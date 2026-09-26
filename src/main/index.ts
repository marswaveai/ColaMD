import { app, BrowserWindow, ipcMain, dialog, Menu, shell, session, clipboard, screen, nativeTheme } from 'electron'
import { execFile } from 'child_process'
import { autoUpdater } from 'electron-updater'
import { join, basename, dirname, extname, isAbsolute, resolve, relative, sep } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { appendFile, readFile, writeFile, readdir, copyFile, mkdir, stat } from 'fs/promises'
import { watch, FSWatcher, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs'

const startupStartedAt = performance.now()
const startupTraceEnabled = process.env.COLAMD_STARTUP_TRACE === '1'
const startupMarks: Record<string, number> = { 'main-loaded': 0 }
let startupTraceWritten = false

function markStartup(name: string): void {
  if (!startupTraceEnabled || startupTraceWritten) return
  startupMarks[name] = Math.round(performance.now() - startupStartedAt)
}

function writeStartupTrace(): void {
  if (!startupTraceEnabled || startupTraceWritten || !('renderer-ready' in startupMarks)) return
  startupTraceWritten = true
  const trace = JSON.stringify({ platform: process.platform, electron: process.versions.electron, ...startupMarks })
  void appendFile(join(app.getPath('userData'), 'startup-trace.jsonl'), `${trace}\n`).catch(() => {})
  console.info(`ColaMD startup trace: ${trace}`)
}


const themesDir = join(app.getPath('home'), '.colamd', 'themes')
const recoveryDir = join(app.getPath('home'), '.colamd', 'recovered')
const releaseNoticePath = join(app.getPath('userData'), 'release-notice.json')

// The shell's top row, in CSS pixels: the window controls overlay on Windows has
// to be told the same height the renderer draws (design.md, one row). Must match
// --chrome-row-height in base.css and the pre-load guard in index.html.
const TITLEBAR_HEIGHT = 36
// What the overlay shows before the renderer reports its theme. The app's theme is
// independent of the system's, so this can only be a guess: follow the system, and
// the renderer corrects it on first paint (a wrong guess would otherwise flash a
// light strip over a dark row).
const lightOverlay = { bg: '#e4e1de', symbol: '#6f6b67' }
const darkOverlay = { bg: '#1a1e24', symbol: '#8b939c' }

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

// Bundled examples are opened on demand from Help. Browsing the user's
// Documents folder on macOS can trigger a privacy prompt before they have even
// opened a file.
const demoDir = app.isPackaged
  ? join(process.resourcesPath, 'demo')
  : join(__dirname, '../../resources/demo')
const cheatsheetDir = app.isPackaged
  ? join(process.resourcesPath, 'templates')
  : join(__dirname, '../../resources/templates')

interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

// One directory level: subdirectories first, then Markdown files, each sorted
// by name. Hidden directories stay out of the list.
async function listDirectoryChildren(dir: string): Promise<SiblingFile[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'directory' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const files = entries
      .filter((e) => e.isFile() && MARKDOWN_EXTENSIONS.includes(extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'file' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return [...directories, ...files]
  } catch {
    return []
  }
}

// The file panel's root: the open document's directory, with `..` as the one
// way back up. Deeper levels are read one directory at a time as the tree is
// expanded, so nothing walks the whole tree up front.
async function listSiblingFiles(filePath: string | null, browseDir?: string): Promise<SiblingFile[]> {
  const dir = browseDir ?? (filePath ? dirname(filePath) : null)
  if (!dir) return []
  const parent = dirname(dir)
  const children = await listDirectoryChildren(dir)
  return parent === dir ? children : [{ name: '..', path: parent, kind: 'parent' }, ...children]
}

function ensureThemesDir(): void {
  if (!existsSync(themesDir)) {
    mkdir(themesDir, { recursive: true }).catch(() => {})
  }
}

// --- Recent files + session restore (#28, #45) ---
const recentStorePath = join(app.getPath('home'), '.colamd', 'recent.json')
let recentStore: { recent: string[]; restoreOnLaunch: boolean } = { recent: [], restoreOnLaunch: true }
const languagePreferencePath = join(app.getPath('userData'), 'language.json')

// Window size, position and view zoom survive a restart. Having to resize and
// re-zoom on every launch is a daily annoyance on a large display (#95), and
// these are the same kind of choice the app already remembers for themes, panel
// width and language.
const windowStatePath = join(app.getPath('userData'), 'window-state.json')
interface SavedWindowState {
  bounds?: { x: number; y: number; width: number; height: number }
  zoom?: number
}

function loadWindowState(): SavedWindowState {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath, 'utf-8')) as SavedWindowState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let savedWindowState: SavedWindowState = loadWindowState()

// A saved position can point at a display that is no longer attached, which
// would put the window somewhere the user cannot reach. Keep it only when it
// still overlaps a screen that exists right now.
function usableBounds(): { x: number; y: number; width: number; height: number } | undefined {
  const bounds = savedWindowState.bounds
  if (!bounds) return undefined
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined
  if (bounds.width < 600 || bounds.height < 400) return undefined
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
  })
  return onScreen ? bounds : undefined
}

let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // getNormalBounds keeps a full-screen or maximised window from being stored
  // as the size of the screen.
  const bounds = win.getNormalBounds()
  const zoom = win.webContents.getZoomFactor()
  savedWindowState = { bounds, zoom }
  void mkdir(dirname(windowStatePath), { recursive: true })
    .then(() => writeFile(windowStatePath, JSON.stringify({ bounds, zoom }), 'utf-8'))
    .catch(() => { /* a preference that cannot be written is not worth a dialog */ })
}

function scheduleWindowStateSave(win: BrowserWindow): void {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => saveWindowState(win), 600)
}
type UiLanguage = 'zh' | 'en'
let preferredLanguage: UiLanguage | null = null
try {
  const parsed = JSON.parse(readFileSync(languagePreferencePath, 'utf-8')) as { language?: unknown }
  if (parsed.language === 'zh' || parsed.language === 'en') preferredLanguage = parsed.language
} catch { /* first run or unreadable preference */ }

function getPreferredLanguage(): UiLanguage {
  return preferredLanguage ?? (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')
}

// Dialogs the user sees during normal use follow the UI language too: they were
// hardcoded Chinese, so an English window got Chinese buttons and vice versa
// (2026-09-15).
function uiText(zh: string, en: string): string {
  return getPreferredLanguage() === 'zh' ? zh : en
}

function setPreferredLanguage(language: UiLanguage): void {
  preferredLanguage = language
  try {
    mkdir(dirname(languagePreferencePath), { recursive: true }).catch(() => {})
    writeFileSync(languagePreferencePath, JSON.stringify({ language }), 'utf-8')
  } catch { /* best effort */ }
  setTimeout(() => buildMenu(), 0)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('language-changed', language)
  }
}
try {
  const parsed = JSON.parse(readFileSync(recentStorePath, 'utf-8'))
  if (Array.isArray(parsed.recent)) {
    recentStore.recent = parsed.recent.filter((p: unknown): p is string => typeof p === 'string')
  }
  if (typeof parsed.restoreOnLaunch === 'boolean') recentStore.restoreOnLaunch = parsed.restoreOnLaunch
} catch { /* first run or unreadable store */ }

function persistRecentStore(): void {
  try {
    mkdir(dirname(recentStorePath), { recursive: true }).catch(() => {})
    writeFileSync(recentStorePath, JSON.stringify(recentStore, null, 2), 'utf-8')
  } catch { /* best effort */ }
}

function pushRecentFile(filePath: string, rebuildMenu = false): void {
  const recent = [filePath, ...recentStore.recent.filter((p) => p !== filePath)].slice(0, 10)
  if (recent.length === recentStore.recent.length && recent.every((p, index) => p === recentStore.recent[index])) return
  recentStore.recent = recent
  persistRecentStore()
  // NEVER rebuild the menu from the autosave path: setApplicationMenu during
  // typing cancels the macOS IME composition and loses in-flight characters.
  // The File menu draws from recentStore on every platform now; macOS additionally
  // gets the file in its own recent list, which feeds the Dock menu.
  if (process.platform === 'darwin') {
    app.addRecentDocument(filePath)
  } else if (rebuildMenu) {
    buildMenu()
  }
}

function recentFiles(): string[] {
  return recentStore.recent.filter((p) => existsSync(p)).slice(0, 10)
}

function clearRecentFiles(): void {
  recentStore.recent = []
  persistRecentStore()
  if (process.platform === 'darwin') app.clearRecentDocuments()
  buildMenu()
}

function setRestoreOnLaunch(enabled: boolean): void {
  recentStore.restoreOnLaunch = enabled
  persistRecentStore()
  buildMenu()
}

async function scanCustomThemes(): Promise<string[]> {
  try {
    const files = await readdir(themesDir)
    return files.filter(f => f.endsWith('.css')).sort()
  } catch {
    return []
  }
}

// Per-window state
interface WindowState {
  filePath: string | null
  browsePath: string | null
  watcher: FSWatcher | null
  isInternalSave: boolean
  internalSaveCount: number
  // mtime of the file as of our last read or write. An autosave refuses to
  // write when the file on disk is newer, so an edit that landed while the
  // save was queued is never silently overwritten.
  lastKnownMtime: number
  // Content of our last internal write/load. Delayed FSEvents echoes of our
  // own writes are skipped when the disk still holds exactly this content.
  lastInternalSaveContent: string | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  siblingsTimer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  closePromise: Promise<boolean> | null
  rendererReady: boolean
  writeQueue: Promise<void>
  closeAuthorized: boolean
  // Every file this window holds open in a tab, reported by the renderer. Used
  // to focus an existing tab instead of opening a duplicate window.
  tabFiles: string[]
  // Files handed to a window whose renderer has not finished loading yet. Sent
  // as tab-open requests once the renderer is ready AND the initial document
  // has been delivered — an early tab-open would otherwise race the first
  // 'file-opened' and both would land in the same tab.
  pendingTabFiles: string[]
  // True once the window's opening document (if any) has been handed to the
  // renderer, i.e. tab-open requests can be processed safely.
  initialDocDelivered: boolean
}

interface DocumentSnapshot {
  dirty: boolean
  content: string
  // Every tab of the window that still has unsaved content. `path === null`
  // means an untitled tab, which cannot be written without asking the user.
  tabs?: { path: string | null; content: string }[]
}

interface PendingDocumentStateRequest {
  webContentsId: number
  resolve: (snapshot: DocumentSnapshot | null) => void
  timer: ReturnType<typeof setTimeout>
}

const windowStates = new Map<number, WindowState>()
let pendingFilePaths: string[] = []
let isQuitting = false
let nextDocumentStateRequestId = 0
const pendingDocumentStateRequests = new Map<string, PendingDocumentStateRequest>()

function getState(win: BrowserWindow): WindowState {
  let state = windowStates.get(win.id)
  if (!state) {
    state = { filePath: null, browsePath: null, watcher: null, isInternalSave: false, internalSaveCount: 0, lastKnownMtime: 0, lastInternalSaveContent: null, debounceTimer: null, siblingsTimer: null, dirty: false, closePromise: null, rendererReady: false, writeQueue: Promise.resolve(), closeAuthorized: false, tabFiles: [], pendingTabFiles: [], initialDocDelivered: false }
    windowStates.set(win.id, state)
  }
  return state
}

function getWinFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

// Modification time of the file on disk, or 0 when it cannot be read.
function fileMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

// True when the file changed after our own last read or write, meaning there is
// an external edit this window has not seen yet. A 1ms tolerance absorbs
// filesystem timestamp rounding.
function fileChangedExternally(filePath: string, state: WindowState): boolean {
  if (!state.lastKnownMtime || filePath !== state.filePath) return false
  const diskMtime = fileMtimeMs(filePath)
  if (!diskMtime) return false
  return diskMtime > state.lastKnownMtime + 1
}

// Hand the renderer the version now on disk so the existing external-change
// flow can ask the user which side to keep.
function notifyExternalChange(win: BrowserWindow, filePath: string): void {
  void readFile(filePath, 'utf-8')
    .then((data) => {
      if (!win.isDestroyed()) win.webContents.send('file-changed', data)
    })
    .catch(() => { /* the watcher picks it up on the next event */ })
}

function createWindow(
  filePath?: string,
  initialContent?: string,
  initialBrowsePath?: string,
  // 没有路径的文档（语法速查）也要有一个「所在位置」：文件里的相对图片地址要相对它
  // 解析。传的是那份文档**本该在**的地址，所以文档直接打开和从菜单打开，图片都能出来。
  initialFileUrl?: string,
): BrowserWindow {
  // Windows gets ONE row for its shell. A normal Windows frame stacks three
  // bars: the system title bar, the in-window menu bar, and our own row, which
  // is what made the app read as heavy there (2026-09-15). So: no system
  // title bar, no menu bar, and the OS draws the window controls as an overlay
  // inside our row instead (Chrome's arrangement). macOS keeps its traffic
  // lights inside the same row, and Linux keeps its frame and its menu bar.
  const isWindows = process.platform === 'win32'
  const win = new BrowserWindow({
    ...(usableBounds() ?? { width: 960, height: 720 }),
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: isWindows ? 'hidden' : 'hiddenInset',
    ...(isWindows
      ? { titleBarOverlay: { ...(nativeTheme.shouldUseDarkColors ? { color: darkOverlay.bg, symbolColor: darkOverlay.symbol } : { color: lightOverlay.bg, symbolColor: lightOverlay.symbol }), height: TITLEBAR_HEIGHT } }
      : {}),
    // macOS centres the traffic lights in the row: the button frame is 14px tall
    // with the 12px circle inside it, so the circle's centre sits at y + 8. For a
    // 36px row that is 18 = half the row, i.e. y = 10 (measured against Finder:
    // its 52px toolbar puts them at 26, exactly half).
    trafficLightPosition: { x: 16, y: TITLEBAR_HEIGHT / 2 - 8 },
    // Windows only: the menu bar is the second of the three bars, so it starts
    // hidden and Alt still reveals it the way Windows users expect. The row gets
    // its own menu button, which pops the same menu.
    ...(isWindows ? { autoHideMenuBar: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // No spellcheck UI in ColaMD — avoid red squiggles in the editor (issue #7)
      spellcheck: false
    }
  })
  markStartup('window-created')

  // The renderer owns the shell's layout, so it needs to know when the window
  // enters or leaves macOS full screen: full screen takes the traffic lights
  // away, and the 96px they occupy has to go with them.
  const sendFullscreen = (isFullscreen: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen-changed', isFullscreen)
  }
  win.on('enter-full-screen', () => sendFullscreen(true))
  win.on('leave-full-screen', () => sendFullscreen(false))

  const state = getState(win)
  if (initialBrowsePath) state.browsePath = initialBrowsePath

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    markStartup('renderer-loaded')
    // The zoom level lives on the webContents, so a new window has to be told.
    if (typeof savedWindowState.zoom === 'number' && savedWindowState.zoom > 0) {
      win.webContents.setZoomFactor(savedWindowState.zoom)
    }
    const deliver = (): void => {
      if (filePath) {
        // The queued tab-opens must go out only after this document's
        // 'file-opened', otherwise both land in the same tab.
        void loadFileInWindow(win, filePath).then(() => {
          getState(win).initialDocDelivered = true
          flushPendingTabFiles(win)
        })
      } else if (initialContent) {
        // In-memory content (e.g. the Markdown cheatsheet) — no file, no watcher
        win.webContents.send('file-opened', { path: null, content: initialContent, fileUrl: initialFileUrl })
        getState(win).initialDocDelivered = true
        flushPendingTabFiles(win)
      } else {
        getState(win).initialDocDelivered = true
        flushPendingTabFiles(win)
      }
    }
    // Wait for the renderer to be listening: a 'file-opened' that arrives
    // before init registers its handlers is dropped, and the window opens
    // empty. Polling here is bounded by the renderer's own init time.
    if (getState(win).rendererReady) {
      deliver()
    } else {
      const poll = setInterval(() => {
        if (win.isDestroyed() || getState(win).rendererReady) {
          clearInterval(poll)
          if (!win.isDestroyed()) deliver()
        }
      }, 30)
      // Unstoppable safety net: never block delivery forever.
      setTimeout(() => {
        clearInterval(poll)
        if (!win.isDestroyed() && !getState(win).initialDocDelivered) deliver()
      }, 10_000)
    }
  })

  // Remember the window's own geometry, so the next launch opens where this one
  // was left instead of at the default size (#95).
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('close', () => saveWindowState(win))

  // Intercept window close: confirm unsaved changes before the window dies.
  // cmd+w (role: 'close') and quit both funnel through here.
  win.on('close', (e) => {
    const st = getState(win)
    if (isQuitting || st.closeAuthorized || (!st.rendererReady && !st.dirty)) return
    e.preventDefault()
    void confirmWindowClose(win, st).then((ok) => {
      if (ok && !win.isDestroyed()) {
        st.closeAuthorized = true
        win.close()
      }
    })
  })

  win.on('closed', () => {
    stopWatching(state)
    windowStates.delete(win.id)
    fullScreenBeforeSlideshow.delete(win.id)
  })

  updateTitle(win)
  return win
}

function updateTitle(win: BrowserWindow): void {
  const state = getState(win)
  const fileName = state.filePath ? basename(state.filePath) : 'Untitled'
  win.setTitle(`${fileName} — ColaMD`)
}

function suggestFileName(win: BrowserWindow, content?: string): string | undefined {
  const state = getState(win)
  if (state.filePath) return basename(state.filePath, '.md')
  if (!content) return undefined
  // Extract first heading or first non-empty line
  const match = content.match(/^#\s+(.+)/m) || content.match(/^(.+)/m)
  if (!match) return undefined
  return match[1].trim().replace(/[/\\:*?"<>|]/g, '').slice(0, 60) || undefined
}

// Save dialogs should open beside the currently edited Markdown file. When
// the document is still untitled there is no meaningful sibling directory, so
// Electron keeps its normal platform-specific default (typically Documents).
function suggestSavePath(win: BrowserWindow, fileName?: string): string | undefined {
  const state = getState(win)
  const name = fileName ?? suggestFileName(win)
  if (!name) return undefined
  return state.filePath ? join(dirname(state.filePath), name) : name
}

function stopWatching(state: WindowState): void {
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }
}

function watchFile(win: BrowserWindow, state: WindowState): void {
  if (!state.filePath) return
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }

  const filePath = state.filePath
  const dir = dirname(filePath)
  const fileName = basename(filePath)
  // macOS FSEvents replays recent history when a watcher starts; drop events
  // fired within this window so opening a file doesn't trigger a spurious reload.
  let suppressUntil = 0

  const scheduleReload = (): void => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      readFile(filePath, 'utf-8')
        .then((data) => {
          // Our own writes echo back through FSEvents long after the internal
          // save window closes; reloading them would revert the editor and
          // wipe anything typed since the save. Skip self-echoes.
          if (state.lastInternalSaveContent !== null && data === state.lastInternalSaveContent) return
          state.lastInternalSaveContent = null
          state.lastKnownMtime = fileMtimeMs(filePath)
          if (!win.isDestroyed()) win.webContents.send('file-changed', data)
        })
        .catch(() => { /* file mid-replace; a follow-up event will re-trigger */ })
    }, 100)
  }

  const onExternalChange = (): void => {
    if (state.isInternalSave) return
    if (Date.now() < suppressUntil) return

    scheduleReload()
  }

  // Agent created/renamed/deleted a sibling file — refresh the file panel list
  const scheduleSiblingsRefresh = (): void => {
    if (state.siblingsTimer) clearTimeout(state.siblingsTimer)
    state.siblingsTimer = setTimeout(() => {
      state.siblingsTimer = null
      if (state.filePath !== filePath) return // file switched meanwhile; new watcher handles it
      listSiblingFiles(filePath, state.browsePath ?? dirname(filePath)).then((files) => {
        if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      })
    }, 300)
  }

  const establish = (): void => {
    if (state.filePath !== filePath) return
    suppressUntil = Date.now() + 300
    if (state.watcher) {
      state.watcher.close()
      state.watcher = null
    }
    try {
      // Watch the parent directory instead of the file: agents often save
      // atomically (write temp + rename over), which replaces the file's
      // inode and silently kills a watcher bound to the old file. A
      // directory watcher survives those and keeps reporting our filename.
      const watcher = watch(dir, (eventType, filename) => {
        if (state.isInternalSave) return
        // filename may be null on some platforms — treat as our file
        if (filename !== null && filename !== fileName) {
          // A sibling file changed (agent created / renamed / deleted it)
          if (MARKDOWN_EXTENSIONS.includes(extname(filename).toLowerCase())) {
            scheduleSiblingsRefresh()
          }
          return
        }

        if (eventType === 'rename') {
          // Atomic save / file replacement. The dir watcher itself stays
          // valid, but re-establish anyway to cover platform quirks.
          onExternalChange()
          if (filename === fileName && existsSync(filePath)) establish()
        } else if (eventType === 'change') {
          onExternalChange()
        }
      })
      watcher.on('error', () => {
        // Watcher died (directory removed, permissions…). Retry so we
        // recover automatically when the file comes back.
        establish()
      })
      state.watcher = watcher
    } catch {
      // Fallback: watch the file directly if the directory isn't watchable
      try {
        const watcher = watch(filePath, (eventType) => {
          if (eventType !== 'change' || state.isInternalSave) return
          onExternalChange()
        })
        watcher.on('error', () => establish())
        state.watcher = watcher
      } catch { /* file not watchable; nothing to do */ }
    }
  }

  establish()
}

// 图片路径不在主进程改写。
//
// 曾经的做法是：打开时把 `![](img/a.png)` 改写成 `file:///...` 交给编辑器显示，保存时再改回
// 相对路径。文本优先之后这条路走不通了——缓冲区里存的就是文件的字节，任何改写都等于让
// 「打开一份文件、一个字都不改、保存」把文件改掉（`./img/a.png` 会被写成 `img/a.png`）。
// 现在渲染层拿着文档自己的 file:// URL 在画图时解析，文件里始终是用户写的那串路径。

function loadFileInWindow(win: BrowserWindow, filePath: string): Promise<void> {
  const state = getState(win)
  const operation = async (): Promise<void> => {
    try {
      const data = await readFile(filePath, 'utf-8')
      if (win.isDestroyed()) return
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, true)
      state.lastInternalSaveContent = data
      state.lastKnownMtime = fileMtimeMs(filePath)
      win.webContents.send('file-opened', { path: filePath, content: data, fileUrl: pathToFileURL(filePath).href })
    } catch {
      // Keep the current document when the selected file cannot be read.
    }
  }
  const next = state.writeQueue.then(operation, operation)
  state.writeQueue = next.then(() => undefined, () => undefined)
  return next
}

// Find window that already has this file open, either as its active document or
// in one of its tabs.
function findWindowForFile(filePath: string): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (state.filePath === filePath || state.tabFiles.includes(filePath)) {
      const win = BrowserWindow.fromId(id)
      if (win && state.filePath !== filePath) win.webContents.send('focus-file', filePath)
      return win
    }
  }
  return null
}

// The focused window, or the most recently created one when nothing is
// focused (e.g. the user clicked a dock icon). Used to decide where documents
// arriving from outside the window land.
function focusedOrLastWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const windows = BrowserWindow.getAllWindows()
  for (let i = windows.length - 1; i >= 0; i--) {
    if (!windows[i].isDestroyed()) return windows[i]
  }
  return null
}

// Hand a file to a window as a new tab. Until the renderer is up AND its
// opening document has been delivered it cannot process the request, so park
// it and flush later.
function openFileAsTab(target: BrowserWindow, filePath: string): void {
  const state = getState(target)
  if (!state.rendererReady || !state.initialDocDelivered) {
    state.pendingTabFiles.push(filePath)
    return
  }
  target.webContents.send('open-in-new-tab', filePath)
}

function flushPendingTabFiles(win: BrowserWindow): void {
  const state = getState(win)
  if (!state.rendererReady || !state.initialDocDelivered) return
  const queued = state.pendingTabFiles.splice(0)
  for (const fp of queued) win.webContents.send('open-in-new-tab', fp)
}

// Open file: reuse existing window, else land as a tab in the current window
// (design.md: files open into the current window, not a new one each time).
function openFile(filePath: string): void {
  // If already open, focus that window
  const existing = findWindowForFile(filePath)
  if (existing) {
    existing.focus()
    return
  }

  // Find an untitled empty window to reuse
  const emptyWin = findEmptyWindow()
  if (emptyWin) {
    loadFileInWindow(emptyWin, filePath)
    emptyWin.focus()
    return
  }

  // The document is open nowhere: it becomes a new tab of the window the user
  // is in, instead of one more window on the pile (#99).
  const target = focusedOrLastWindow()
  if (target) {
    openFileAsTab(target, filePath)
    if (target.isMinimized()) target.restore()
    target.focus()
    return
  }

  // Create new window
  const win = createWindow(filePath)
  win.focus()
}

// An untitled window is the natural place for a document that arrives from
// outside the app, but not any untitled window: on macOS it is easy to leave one
// behind another app or on another Space, and delivering the file there looks
// exactly like the file never arrived, because the window that came to the front
// is the one the user was already in (issue #105). Prefer the window the user is
// actually looking at, then fall back to the first one.
function findEmptyWindow(): BrowserWindow | null {
  const isEmpty = (win: BrowserWindow | null): boolean => {
    if (!win || win.isDestroyed()) return false
    const state = windowStates.get(win.id)
    return !!state && !state.filePath
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (isEmpty(focused)) return focused

  for (const [id, state] of windowStates) {
    if (!state.filePath) {
      return BrowserWindow.fromId(id) || null
    }
  }
  return null
}

// Serialize writes per window. A save is valid only while its source document
// remains active; stale queued work must neither overwrite window state nor
// make a later document appear saved.
function saveToPath(win: BrowserWindow, filePath: string, content: string, sourcePath: string | null, rebuildMenu = false): Promise<boolean> {
  const state = getState(win)
  const operation = async (): Promise<boolean> => {
    if (win.isDestroyed() || state.filePath !== sourcePath) return false
    try {
      state.internalSaveCount += 1
      state.isInternalSave = true
      await writeFile(filePath, content, 'utf-8')
      state.lastInternalSaveContent = content
      state.lastKnownMtime = fileMtimeMs(filePath)
      if (win.isDestroyed() || state.filePath !== sourcePath) return false
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, rebuildMenu)
      return true
    } catch {
      return false
    } finally {
      setTimeout(() => {
        state.internalSaveCount = Math.max(0, state.internalSaveCount - 1)
        state.isInternalSave = state.internalSaveCount > 0
      }, 100)
    }
  }
  const next = state.writeQueue.then(operation, operation)
  state.writeQueue = next.then(() => undefined, () => undefined)
  return next
}

// IPC Handlers

ipcMain.on('open-external', (_event, url: string) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url)
  }
})

ipcMain.handle('get-file-manager-name', () => fileManagerName())

// Renderer clipboard reads have no transient user activation when the request
// comes from a menu accelerator, so the link command reads it in the main
// process (review on #87).
ipcMain.handle('read-clipboard-text', () => clipboard.readText())

// 渲染层没有 path/url 模块，图片相对路径的基准由这里给：文档自己的 file:// URL。
ipcMain.handle('file-url', (_event, filePath: unknown) => {
  return typeof filePath === 'string' && filePath ? pathToFileURL(filePath).href : null
})

// 放映幻灯片 takes the whole screen. Which window was full screen before a deck
// started is the main process's to remember: leaving the deck must give back a
// full screen the user had chosen for their own reasons, and must not leave one
// behind that the deck switched on.
const fullScreenBeforeSlideshow = new Map<number, boolean>()

ipcMain.handle('slideshow-fullscreen', (event, on: unknown) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  if (on) {
    if (!fullScreenBeforeSlideshow.has(win.id)) fullScreenBeforeSlideshow.set(win.id, win.isFullScreen())
    if (!win.isFullScreen()) win.setFullScreen(true)
  } else {
    const before = fullScreenBeforeSlideshow.get(win.id) ?? false
    fullScreenBeforeSlideshow.delete(win.id)
    if (!before && win.isFullScreen()) win.setFullScreen(false)
  }
  return true
})

// Electron 44 rebuilt the clipboard on the W3C API, so writes return a promise
// at runtime, while the shipped types still declare void. A rejected write must
// not surface as an unhandled rejection: node terminates the process on those.
function copyToClipboard(text: string): void {
  const write = clipboard.writeText(text) as unknown as Promise<void> | undefined
  void write?.catch((err: unknown) => { console.error('clipboard write failed:', err) })
}

function fileManagerName(): 'finder' | 'explorer' | 'file-manager' {
  if (process.platform === 'darwin') return 'finder'
  if (process.platform === 'win32') return 'explorer'
  return 'file-manager'
}

function revealLabel(zh: boolean): string {
  return fileManagerName() === 'explorer'
    ? (zh ? '在资源管理器中显示' : 'Reveal in File Explorer')
    : (zh ? '在 Finder 中显示' : 'Reveal in Finder')
}

// Right-click menu for a tab: the closing actions, plus the path actions that
// make sense for the document in it. Same native menu as the file list.
ipcMain.handle('tab-context-menu', (event, payload: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof payload !== 'object' || payload === null) return
  const { tabId, filePath, canCloseOthers, canCloseRight } = payload as Record<string, unknown>
  if (typeof tabId !== 'string' || tabId.length === 0) return
  const zh = getPreferredLanguage() === 'zh'
  const send = (action: string) => win.webContents.send('tab-menu-action', { action, tabId })
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: zh ? '关闭' : 'Close', click: () => send('close') }
  ]
  if (canCloseOthers === true) {
    items.push({ label: zh ? '关闭其他标签页' : 'Close Other Tabs', click: () => send('close-others') })
  }
  if (canCloseRight === true) {
    items.push({ label: zh ? '关闭右侧标签页' : 'Close Tabs to the Right', click: () => send('close-right') })
  }
  if (typeof filePath === 'string' && filePath.length > 0) {
    items.push({ type: 'separator' })
    // The rest of the menu sends actions back to the renderer; this one is a
    // main-process job, so it runs here and needs no round trip.
    items.push({
      label: zh ? '在新窗口打开' : 'Open in New Window',
      click: () => {
        const opened = createWindow(filePath)
        opened.focus()
      }
    })
    items.push({ label: zh ? '复制路径' : 'Copy path', click: () => copyToClipboard(filePath) })
    items.push({ label: revealLabel(zh), click: () => shell.showItemInFolder(filePath) })
  }
  Menu.buildFromTemplate(items).popup({ window: win })
})

// Right-click menu for a file panel entry. Native menu on purpose: no custom
// popup to theme, keep it accessible and platform familiar.
ipcMain.handle('entry-context-menu', (event, targetPath: unknown, kind: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof targetPath !== 'string' || targetPath.length === 0) return
  const zh = getPreferredLanguage() === 'zh'
  const items: Electron.MenuItemConstructorOptions[] = []
  if (kind !== 'directory') {
    // First item: opening a document in its own tab is the reason this menu is
    // reached for (design.md).
    items.push({
      label: zh ? '在新标签页打开' : 'Open in New Tab',
      click: () => {
        const state = getState(win)
        // Tabs live in the renderer, so the menu only reports the intent.
        if (state.filePath === targetPath) return
        win.webContents.send('open-in-new-tab', targetPath)
      }
    })
    items.push({ type: 'separator' })
  }
  items.push({ label: zh ? '复制路径' : 'Copy path', click: () => copyToClipboard(targetPath) })
  if (kind !== 'directory') {
    items.push({ label: zh ? '用默认应用打开' : 'Open in default app', click: () => { void shell.openPath(targetPath) } })
  }
  items.push({
    label: revealLabel(zh),
    click: () => shell.showItemInFolder(targetPath)
  })
  Menu.buildFromTemplate(items).popup({ window: win })
})

ipcMain.handle('reveal-file', (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const filePath = getState(win).filePath
  if (!filePath) return false
  try {
    shell.showItemInFolder(filePath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('open-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]

  // If this window has no file, load here; otherwise open in new window
  const state = getState(win)
  if (!state.filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, true)
      state.lastInternalSaveContent = content
      win.webContents.send('file-opened', { path: filePath, content, fileUrl: pathToFileURL(filePath).href })
      return { path: filePath, content }
    } catch {
      return null
    }
  } else {
    openFile(filePath)
    return null
  }
})

ipcMain.handle('open-file-path', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)

  // If this window has no file, load here
  if (!state.filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, true)
      state.lastInternalSaveContent = content
      win.webContents.send('file-opened', { path: filePath, content, fileUrl: pathToFileURL(filePath).href })
      return { path: filePath, content }
    } catch {
      return null
    }
  } else {
    openFile(filePath)
    return null
  }
})

// Switch the window's active document without touching the renderer's content.
// Tabs keep their own editor state in the renderer, so this only re-points what
// belongs to the window: watcher, title, recent list and file panel. The disk
// version is returned so the caller can tell whether it changed while this tab
// was in the background. Passing null (or an empty string) means the active
// document is untitled, which must clear the window's file binding: otherwise a
// save of that untitled document would be written into the previous file.
ipcMain.handle('activate-file', async (event, filePath: unknown) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  if (filePath !== null && filePath !== '' && typeof filePath !== 'string') return null
  const target = typeof filePath === 'string' && filePath.length > 0 ? filePath : null
  const state = getState(win)
  const operation = async (): Promise<{ content: string; fileUrl: string; mtime: number } | null> => {
    if (!target) {
      stopWatching(state)
      state.filePath = null
      state.lastInternalSaveContent = null
      state.lastKnownMtime = 0
      updateTitle(win)
      return null
    }
    try {
      const data = await readFile(target, 'utf-8')
      if (win.isDestroyed()) return null
      state.filePath = target
      state.browsePath = dirname(target)
      state.lastInternalSaveContent = data
      state.lastKnownMtime = fileMtimeMs(target)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(target, true)
      return { content: data, fileUrl: pathToFileURL(target).href, mtime: state.lastKnownMtime }
    } catch {
      return null
    }
  }
  const next = state.writeQueue.then(operation, operation)
  state.writeQueue = next.then(() => undefined, () => undefined)
  return next
})

// Same-directory file panel: list markdown files next to the open file
ipcMain.handle('list-siblings', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)
  return listSiblingFiles(state.filePath, state.browsePath ?? undefined)
})

// Expanding a directory in the file panel reads that one directory.
ipcMain.handle('list-directory', async (_event, dirPath: unknown) => {
  if (typeof dirPath !== 'string' || !dirPath) return null
  return listDirectoryChildren(dirPath)
})

// Open a Markdown file, or walk the panel's root back up, from the file panel.
ipcMain.handle('open-sibling', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win || typeof filePath !== 'string') return false
  try {
    const info = await stat(filePath)
    const state = getState(win)
    if (info.isDirectory()) {
      state.browsePath = filePath
      const files = await listSiblingFiles(state.filePath, filePath)
      if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      return true
    }
    // Already open in another tab of this window: focus that tab instead of
    // loading the same file twice.
    if (state.tabFiles.includes(filePath) && state.filePath !== filePath) {
      win.webContents.send('focus-file', filePath)
      return true
    }
  } catch {
    return false
  }
  loadFileInWindow(win, filePath)
  return true
})

ipcMain.on('set-tab-files', (event, paths: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const state = getState(win)
  state.tabFiles = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
})

ipcMain.handle('save-file', async (event, content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)
  const sourcePath = state.filePath
  // The caller states which document this content belongs to; '' means untitled.
  // Comparing strictly (rather than only when a path is given) is what stops a
  // save from landing in whatever file the window happened to open last.
  if (typeof expectedPath === 'string' && sourcePath !== (expectedPath.length > 0 ? expectedPath : null)) return null
  let filePath = sourcePath
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, {
      title: uiText('保存 Markdown 文档', 'Save Markdown document'),
      buttonLabel: uiText('保存', 'Save'),
      nameFieldLabel: uiText('文件名：', 'File name:'),
      defaultPath: suggestSavePath(win, suggestFileName(win, content)),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    filePath = result.filePath
  }
  // Auto-save never overwrites an edit that landed after our last read or
  // write: the watcher can miss it (an event during our own write is dropped as
  // a self-echo), so probe the mtime and let the user decide instead. A manual
  // save keeps the old behavior, because the user asked for it explicitly.
  if (autosave && fileChangedExternally(filePath, state)) {
    notifyExternalChange(win, filePath)
    return null
  }
  const ok = await saveToPath(win, filePath, content, sourcePath, rebuildMenu ?? false)
  return ok ? filePath : null
})

ipcMain.handle('save-file-as', async (event, content: string, expectedPath?: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const sourcePath = getState(win).filePath
  if (typeof expectedPath === 'string' && sourcePath !== (expectedPath.length > 0 ? expectedPath : null)) return null
  const result = await dialog.showSaveDialog(win, {
    title: uiText('另存为', 'Save As'),
    buttonLabel: uiText('保存', 'Save'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: suggestSavePath(win, suggestFileName(win, content)),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  const ok = await saveToPath(win, result.filePath, content, sourcePath, true)
  return ok ? result.filePath : null
})

ipcMain.handle('export-docx', async (event, payload: unknown) => {
  const win = getWinFromEvent(event)
  const content = typeof payload === 'object' && payload !== null ? (payload as { content?: unknown }).content : payload
  const images = typeof payload === 'object' && payload !== null ? (payload as { images?: unknown }).images : undefined
  if (!win || typeof content !== 'string') return false
  win.show()
  win.focus()
  const diagramImages = images && typeof images === 'object' && !Array.isArray(images)
    ? Object.fromEntries(Object.entries(images as Record<string, unknown>).filter(([, value]) => typeof value === 'string') as Array<[string, string]>)
    : undefined
  const baseName = suggestFileName(win, content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 Word 文档', 'Export Word document'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: suggestSavePath(win, `${baseName}.docx`),
    filters: [{ name: 'Word Document', extensions: ['docx'] }]
  })
  if (result.canceled || !result.filePath) return false
  try {
    const { markdownToDocx } = await import('./docx-export')
    await writeFile(result.filePath, await markdownToDocx({ content, sourcePath: getState(win).filePath, images: diagramImages }))
    shell.showItemInFolder(result.filePath)
    return true
  } catch (error) {
    console.error('Word export failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法导出 Word 文档', 'Could not export the Word document'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
})

ipcMain.handle('export-image', async (event, snapshot: unknown, preset: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || (preset !== 'desktop' && preset !== 'mobile') || !snapshot || typeof snapshot !== 'object') return false
  win.show()
  win.focus()
  const { html, styles, bodyClass, background } = snapshot as { html?: unknown; styles?: unknown; bodyClass?: unknown; background?: unknown }
  if (typeof html !== 'string' || typeof styles !== 'string' || typeof bodyClass !== 'string' || typeof background !== 'string') return false
  const baseName = suggestFileName(win) ?? 'untitled'
  const suffix = preset === 'desktop' ? 'desktop' : 'mobile'
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 PNG 图片', 'Export PNG images'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: suggestSavePath(win, `${baseName}-${suffix}.png`),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  })
  if (result.canceled || !result.filePath) return false
  try {
    const { renderDocumentImages } = await import('./image-export')
    const pages = await renderDocumentImages({ html, styles, bodyClass, background }, preset)
    if (pages.length === 0) throw new Error('没有可导出的内容')

    const extension = extname(result.filePath)
    const basePath = extension ? result.filePath.slice(0, -extension.length) : result.filePath
    const digits = String(pages.length).length
    const outputPaths = pages.map((_, index) => index === 0
      ? result.filePath
      : `${basePath}-${String(index + 1).padStart(digits, '0')}${extension}`)
    const conflicts = outputPaths.slice(1).filter((path) => existsSync(path))
    if (conflicts.length > 0) {
      const response = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [uiText('取消', 'Cancel'), uiText('替换', 'Replace')],
        defaultId: 0,
        cancelId: 0,
        message: uiText('部分图片已存在', 'Some images already exist'),
        detail: uiText(`将替换 ${conflicts.length} 张同名图片。`, `${conflicts.length} image${conflicts.length === 1 ? '' : 's'} with the same name will be replaced.`),
      })
      if (response.response !== 1) return false
    }

    await Promise.all(pages.map((page, index) => writeFile(outputPaths[index], page)))
    shell.showItemInFolder(outputPaths[0])
    return true
  } catch (error) {
    console.error('Image export failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法导出图片', 'Could not export the images'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
})

ipcMain.handle('export-pdf', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 PDF', 'Export PDF'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: suggestSavePath(win, suggestFileName(win)),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    const background = await win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor') as string
    // 打印的是这个窗口本身，所以先把编辑器的痕迹收起来：光标、选区、以及当前行
    // 因为「正在编辑」而显形的源码都不该上纸。
    await win.webContents.executeJavaScript('window.__colamdPrintExport?.enter()').catch(() => {})
    const cssKey = await win.webContents.insertCSS(
      `@media print {
        /* The margins are the page's, so they repeat, and the page carries the
           theme background: without it the margin area stays paper white and a
           warm or dark theme ends up with a bright frame around every page. */
        @page { margin: 20mm 18mm; background: ${background}; }
        html, body, #editor { height: auto !important; overflow: visible !important; background: ${background} !important; }
        #editor { margin: 0 !important; padding: 0 !important; }
        /* 光标与选区是编辑器的东西，不是文档的内容。 */
        .cm-cursor, .cm-cursorLayer, .cm-selectionLayer, .cm-selectionBackground { display: none !important; }
        /* A cell has to break a long token (JSON, a URL) instead of forcing the
           table wider than the page: one unbreakable string sets a minimum width
           the table cannot go below, and the last column ends up cut off at the
           paper's edge (#108). The table already carries width: 100% in the
           theme; this is what lets it actually shrink to that width. */
        #editor .cm-content th, #editor .cm-content td { overflow-wrap: anywhere !important; word-break: break-word !important; }
      }`
    )
    try {
      const pdfData = await win.webContents.printToPDF({
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
        pageSize: 'A4'
      })
      await writeFile(result.filePath, pdfData)
      return true
    } finally {
      await win.webContents.removeInsertedCSS(cssKey)
    }
  } catch {
    return false
  } finally {
    await win.webContents.executeJavaScript('window.__colamdPrintExport?.exit()').catch(() => {})
  }
})

// 导出幻灯片 PDF (File → Export Slides PDF). One `---` is one sheet, 16:9, on the
// theme's own paper: the deck, as something you can carry anywhere. The renderer
// owns the page — it has the stylesheet and the measurement — and this side owns
// the file and the dialog. The renderer is asked to become paper only once the
// destination is chosen: a document laid out as sheets behind a save dialog
// reads as the app having come apart.
async function exportSlidesPDF(win: BrowserWindow | null): Promise<boolean> {
  if (!win || win.isDestroyed()) return false
  const base = suggestFileName(win)
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出幻灯片 PDF', 'Export Slides PDF'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: suggestSavePath(win, base ? `${base}-slides` : 'slides'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  const sheet = await win.webContents
    .executeJavaScript('window.__colamdSlidesExport ? window.__colamdSlidesExport.enter() : false')
    .catch(() => false) as { width: number; height: number } | false
  if (!sheet) return false

  // 幻灯片也是文档：光标、选区、当前行显形的源码都不该上纸。
  await win.webContents.executeJavaScript('window.__colamdPrintExport?.enter()').catch(() => {})

  try {
    const pdfData = await win.webContents.printToPDF({
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: { width: sheet.width, height: sheet.height }
    })
    await writeFile(result.filePath, pdfData)
    return true
  } catch {
    return false
  } finally {
    await win.webContents.executeJavaScript('window.__colamdPrintExport?.exit()').catch(() => {})
    await win.webContents.executeJavaScript('window.__colamdSlidesExport?.exit()').catch(() => {})
  }
}

// 导出 HTML 与图片走的是另一条路：渲染进程把当前文档的快照（内容 + 样式）交给主进程，
// 主进程在隐藏窗口里重新排版，不碰用户眼前的这个窗口。

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char)
}

ipcMain.handle('export-html', async (event, snapshot: {
  content: string
  html: string
  document: string
  styles: string
  bodyClass: string
}) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const baseName = suggestFileName(win, snapshot.content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 HTML', 'Export HTML'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: suggestSavePath(win, `${baseName}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return false

  const title = escapeHTML(baseName)
  const bodyClass = escapeHTML(snapshot.bodyClass)
  // 优先用语义化那一份：导出的是**一篇文档**，不该带上编辑器自己的行结构和类名
  const renderedContent = snapshot.document || snapshot.html || `<pre>${escapeHTML(snapshot.content)}</pre>`
  const exportStyles = snapshot.styles || ''
  const documentHTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${exportStyles}
    html, body { height: auto; overflow: visible; }
    body { min-width: 320px; }
    #titlebar, #file-panel, #source-editor { display: none !important; }
    #editor { height: auto !important; min-height: 100vh; overflow: visible !important; padding: 0 !important; }
  </style>
</head>
<body class="${bodyClass}">
  <article class="colamd-document">${renderedContent}</article>
</body>
</html>
`

  try {
    await writeFile(result.filePath, documentHTML, 'utf-8')
    shell.showItemInFolder(result.filePath)
    return true
  } catch {
    return false
  }
})

// Bundled Markdown documents open in an in-memory window. This keeps Help
// useful even in a signed/read-only app bundle and avoids starting a watcher.
async function openBundledDocument(fileName: string): Promise<void> {
  try {
    const content = await readFile(join(demoDir, fileName), 'utf-8')
    createWindow(undefined, content, demoDir)
  } catch {
    createWindow(undefined, undefined, demoDir)
  }
}

async function openChangelogOnceForVersion(): Promise<void> {
  if (!app.isPackaged) return
  const version = app.getVersion()
  try {
    const saved = JSON.parse(await readFile(releaseNoticePath, 'utf-8')) as { changelogVersion?: unknown }
    if (saved.changelogVersion === version) return
  } catch {
    // First launch or an invalid marker: show the changelog and rewrite it.
  }

  try {
    const content = await readFile(join(demoDir, 'changelog.md'), 'utf-8')
    createWindow(undefined, content, demoDir)
    await writeFile(releaseNoticePath, JSON.stringify({ changelogVersion: version }), 'utf-8')
  } catch {
    // Do not mark the version as seen if the bundled changelog could not open.
  }
}

async function openCheatsheet(language: 'zh' | 'en' = 'zh'): Promise<void> {
  try {
    const fileName = language === 'en' ? 'cheatsheet-en.md' : 'cheatsheet.md'
    const content = await readFile(join(cheatsheetDir, fileName), 'utf-8')
    createWindow(undefined, content, demoDir, pathToFileURL(join(cheatsheetDir, fileName)).href)
  } catch {
    createWindow(undefined, undefined, demoDir)
  }
}

ipcMain.handle('load-custom-theme', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [{ name: 'CSS', extensions: ['css'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  try {
    const srcPath = result.filePaths[0]
    const fileName = basename(srcPath)
    const destPath = join(themesDir, fileName)
    await copyFile(srcPath, destPath)
    const css = await readFile(destPath, 'utf-8')
    buildMenu() // rebuild menu to include new theme
    return { name: fileName, css }
  } catch {
    return null
  }
})

ipcMain.handle('load-theme-css', async (_event, fileName: string) => {
  try {
    return await readFile(join(themesDir, fileName), 'utf-8')
  } catch {
    return null
  }
})

// Renderer reports the applied theme; the Theme menu checkmarks are updated
// in place (never rebuild the menu from an IPC callback — setApplicationMenu
// inside a menu-triggered path hangs the main process).
let currentTheme = 'elegant'
// Which side of the window the file panel occupies. The renderer owns the
// preference (localStorage, beside the panel's width) and reports it here so the
// View menu's checkmarks tell the truth; main keeps no copy of it on disk.
let currentPanelSide: 'left' | 'right' = 'right'
let currentPageWidth: 'narrow' | 'standard' | 'wide' = 'standard'
let themeMenuItems: Array<{ id: string; theme: string }> = []
// Enumerate installed system font families for the font settings dialog (#7752855).
// Uses NSFontManager via JXA — the same source as the macOS font panel — so the
// list matches what the system and other apps (e.g. Typora) show, with
// localized family names. Result is cached after the first load.
let systemFontFamilies: string[] | null = null
let systemFontFamiliesPromise: Promise<string[]> | null = null

function loadSystemFontFamilies(): Promise<string[]> {
  if (systemFontFamilies) return Promise.resolve(systemFontFamilies)
  if (systemFontFamiliesPromise) return systemFontFamiliesPromise
  systemFontFamiliesPromise = new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve([])
      return
    }
    const script = [
      'ObjC.import("AppKit")',
      'const nm = $.NSFontManager.sharedFontManager',
      'const out = []',
      'const fams = nm.availableFontFamilies.js',
      'for (const f of fams) { out.push(nm.localizedNameForFamilyFace($(f), $()).js) }',
      'out.join("\\n")'
    ].join('; ')
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      try {
        if (err) {
          console.error('[font-list] osascript failed:', (err as NodeJS.ErrnoException).message)
          throw err
        }
        const collator = new Intl.Collator(app.getLocale().startsWith('zh') ? 'zh-Hans' : 'en', { sensitivity: 'base', numeric: true })
        systemFontFamilies = [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort(collator.compare)
      } catch {
        systemFontFamilies = []
      }
      resolve(systemFontFamilies)
    })
  })
  return systemFontFamiliesPromise
}

ipcMain.handle('list-system-fonts', () => loadSystemFontFamilies())

// Broadcast editor font changes from one window to the others (#7752855)
ipcMain.handle('set-editor-font', (_event, prefs: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents === _event.sender) continue
    if (!win.webContents.isDestroyed()) win.webContents.send('editor-font-changed', prefs)
  }
})

// External edit collided with unsaved local changes. Pause the editor's
// autosave (renderer side) and ask the user which version survives.
ipcMain.handle('report-external-conflict', async (event, localContent: unknown) => {
  const win = getWinFromEvent(event)
  if (!win) {
    event.sender.send('external-conflict-result', { action: 'keep' })
    return
  }
  const state = getState(win)
  const filePath = state.filePath
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [
      uiText('保留我的版本（继续编辑）', 'Keep my version (keep editing)'),
      uiText('加载磁盘上的版本（我的内容会存成恢复文件）', 'Load the version on disk (my version is kept as a recovery file)')
    ],
    defaultId: 0,
    cancelId: 0,
    message: uiText('文件已被其他程序修改', 'The file was changed by another program'),
    detail: uiText(
      '你正在编辑的内容尚未保存，同时磁盘上的文件已被外部修改。请选择保留哪个版本。',
      'Your edits are not saved yet, and the file on disk changed. Choose which version to keep.'
    )
  })
  if (win.isDestroyed()) return
  if (choice.response === 1 && filePath) {
    try {
      const data = await readFile(filePath, 'utf-8')
      // Loading the disk version is the one move in this app that throws unsaved
      // input away for good (the editor flushes its undo history at the same
      // time), so the version being dropped is written down first. If that write
      // fails we do NOT discard anything: the fall-through keeps the user's
      // version in the editor instead.
      const recoveryPath = await keepRecoveredCopy(filePath, localContent)
      if (!recoveryPath) throw new Error('未保留恢复副本')
      state.lastInternalSaveContent = data
      event.sender.send('external-conflict-result', {
        action: 'load',
        content: data,
        recoveryPath
      })
      return
    } catch (error) {
      console.error('Could not keep the unsaved version, keeping the editor version instead', error)
    }
  }
  event.sender.send('external-conflict-result', { action: 'keep' })
})

// The copy that makes discarding safe. Named after the document so the folder
// stays readable years later, with a local timestamp to the second.
async function keepRecoveredCopy(filePath: string, content: unknown): Promise<string | null> {
  if (typeof content !== 'string' || content.trim() === '') return null
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const target = join(recoveryDir, `${basename(filePath, extname(filePath))}-${stamp}.md`)
  try {
    await mkdir(recoveryDir, { recursive: true })
    await writeFile(target, content, 'utf-8')
    return target
  } catch (error) {
    console.error('Could not write the recovery copy', error)
    return null
  }
}

// The renderer names the recovery file it was just told about; nothing outside
// our own recovery folder is allowed through.
ipcMain.handle('reveal-path', (_event, target: unknown) => {
  if (typeof target !== 'string' || !target) return false
  const root = resolve(recoveryDir)
  const path = resolve(target)
  if (path !== root && !path.startsWith(root + sep)) return false
  shell.showItemInFolder(path)
  return true
})

ipcMain.handle('report-theme', (_event, theme: unknown) => {
  const next = typeof theme === 'string' && theme ? theme : 'elegant'
  if (next === currentTheme) return
  currentTheme = next
  updateThemeMenuChecks()
})

ipcMain.handle('report-panel-side', (_event, side: unknown) => {
  const next: 'left' | 'right' = side === 'left' ? 'left' : 'right'
  if (next === currentPanelSide) return
  currentPanelSide = next
  updatePanelSideMenuChecks()
})

ipcMain.handle('report-page-width', (_event, width: unknown) => {
  const next: 'narrow' | 'standard' | 'wide' =
    width === 'narrow' || width === 'wide' ? width : 'standard'
  if (next === currentPageWidth) return
  currentPageWidth = next
  updatePageWidthMenuChecks()
})

// The Windows window controls are painted by the OS inside our own row, so their
// strip has to carry the theme's chrome colour. The renderer resolves the live
// computed colours and reports them on every theme change; the overlay only
// exists on Windows, and older runtimes without the API simply keep the default.
ipcMain.handle('report-titlebar-colors', (event, colors: unknown) => {
  if (process.platform !== 'win32') return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  const payload = colors as { background?: unknown; symbol?: unknown } | null
  // Plain #rrggbb only: the platform parses no CSS Color 4, and a value it cannot
  // read fails the whole call, leaving the buttons on whatever they were created
  // with (2026-09-15, a light strip over a black row shipped to a Windows tester
  // because the renderer handed over `color(srgb …)`).
  const hex = (value: unknown): string | null =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null
  const background = hex(payload?.background)
  if (!background) return
  const symbol = hex(payload?.symbol)
  try {
    win.setTitleBarOverlay({ color: background, ...(symbol ? { symbolColor: symbol } : {}), height: TITLEBAR_HEIGHT })
  } catch (error) {
    // Not silent: a swallowed failure here is invisible in the UI, and that is
    // exactly how the colours above went unnoticed until a Windows screenshot.
    console.error('title bar overlay update failed:', error)
  }
})

// The row's own menu button (Windows, where the menu bar is hidden). It pops the
// application menu in place, so the menu stays the same native menu everywhere.
ipcMain.handle('popup-app-menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  Menu.getApplicationMenu()?.popup({ window: win })
})

ipcMain.handle('get-language', () => getPreferredLanguage())

// Menu — targets the focused window

function setAsDefaultApp(): void {
  if (process.platform !== 'darwin') {
    dialog.showMessageBox({
      type: 'info',
      message: 'This feature is available on macOS only.'
    })
    return
  }

  const script = `
    ObjC.import('CoreServices');
    var bundleID = 'ai.marswave.colamd';
    var exts = ['md', 'markdown', 'mdown', 'mkd', 'txt'];
    var results = [];
    for (var i = 0; i < exts.length; i++) {
      var ext = exts[i];
      try {
        var uti = $.UTTypeCreatePreferredIdentifierForTag(
          $.kUTTagClassFilenameExtension,
          $(ext),
          null
        );
        if (!uti) throw new Error('Could not resolve file type');
        var status = String($.LSSetDefaultRoleHandlerForContentType(uti, $.kLSRolesAll, $(bundleID)));
        results.push(ext + ': ' + (status === '0' ? 'OK' : 'error ' + status));
      } catch (e) {
        results.push(ext + ': ' + e.message);
      }
    }
    JSON.stringify(results);
  `

  execFile('osascript', ['-l', 'JavaScript', '-e', script], (error, stdout, stderr) => {
    if (error) {
      dialog.showMessageBox({
        type: 'error',
        message: 'Failed to set ColaMD as the default app.',
        detail: stderr || error.message
      })
      return
    }
    try {
      const results: string[] = JSON.parse(stdout.trim())
      const allOk = results.every((r) => r.endsWith(': OK'))
      dialog.showMessageBox({
        type: 'info',
        message: allOk
          ? 'ColaMD is now the default app for Markdown and text files.'
          : 'Some file types could not be associated. System Settings may need manual adjustment.',
        detail: results.join('\n')
      })
    } catch {
      dialog.showMessageBox({
        type: 'info',
        message: 'Default app request sent. You may need to confirm in the system dialog.'
      })
    }
  })
}

function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

function getPreferredCheatsheetLanguage(): 'zh' | 'en' {
  return getPreferredLanguage()
}

let latestVersion: string | null = null

function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (win) win.webContents.send(channel, ...args)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  // Scan custom themes synchronously for menu building
  const customThemeItems: Electron.MenuItemConstructorOptions[] = []
  try {
    const files = readdirSync(themesDir).filter((f: string) => f.endsWith('.css')).sort()
    for (const file of files) {
      customThemeItems.push({
        label: file.replace(/\.css$/, ''),
        id: `theme-custom-${file}`,
        checked: currentTheme === `custom:${file}`,
        type: 'checkbox' as const,
        click: async () => {
          try {
            const css = await readFile(join(themesDir, file), 'utf-8')
            sendToFocused('set-theme', `custom:${file}`)
            sendToFocused('set-custom-css', css)
          } catch { /* ignore */ }
        }
      })
    }
  } catch { /* themes dir may not exist yet */ }

  const preferredCheatsheetLanguage = getPreferredCheatsheetLanguage()
  const labels = preferredCheatsheetLanguage === 'zh'
    ? {
        file: '文件', edit: '编辑', view: '视图', theme: '主题', window: '窗口', help: '帮助',
        newFile: '新建', open: '打开...', save: '保存', saveAs: '另存为...',
        newTab: '新建标签页', closeTab: '关闭标签页',
        recentOpen: '最近打开', restoreOnLaunch: '启动时打开上次文档', clearRecent: '清除最近记录', noRecent: '没有最近打开的文件',
        exportPDF: '导出 PDF...', exportSlidesPDF: '导出幻灯片 PDF...', exportHTML: '导出 HTML...', exportWord: '导出 Word...', exportImageDesktop: '导出图片（电脑阅读）...', exportImageMobile: '导出图片（手机阅读）...', find: '查找',
        setDefault: '设置为默认应用...',
        filePanel: '显示 / 隐藏文件列表', sourceMode: '切换 Markdown 源码',
        panelSide: '文件列表位置', panelSideLeft: '在左侧', panelSideRight: '在右侧',
        pageWidth: '正文宽度', pageWidthNarrow: '窄', pageWidthStandard: '标准', pageWidthWide: '宽',
        light: '浅色', dark: '深色', elegant: '雅致',
        sepia: '羊皮纸', notion: '简白', bear: '熊红', writer: '作家',
        solarizedDark: '夜航', nord: '极地', gruvbox: '暖木', dracula: '德古拉', midnight: '午夜',
        importTheme: '导入主题...', whatsNew: '新功能演示',
        cheatsheet: 'Markdown 语法', about: '关于 ColaMD', checkForUpdates: '检查更新...', updateAvailable: '发现新版本', close: '关闭窗口',
        undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
        actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '切换全屏', playSlideshow: '放映幻灯片',
        fontSettings: '编辑器字体…',
        language: '界面语言', chinese: '中文', english: 'English',
        hide: '隐藏 ColaMD', hideOthers: '隐藏其他应用', showAll: '显示全部', quit: '退出 ColaMD',
        minimize: '最小化', zoom: '缩放', front: '前置全部窗口',
      }
    : {
        file: 'File', edit: 'Edit', view: 'View', theme: 'Theme', window: 'Window', help: 'Help',
        newFile: 'New', open: 'Open...', save: 'Save', saveAs: 'Save As...',
        newTab: 'New Tab', closeTab: 'Close Tab',
        recentOpen: 'Open Recent', restoreOnLaunch: 'Reopen last document at launch', clearRecent: 'Clear Recent', noRecent: 'No recent files',
        exportPDF: 'Export PDF...', exportSlidesPDF: 'Export Slides PDF...', exportHTML: 'Export HTML...', exportWord: 'Export Word...', exportImageDesktop: 'Export Image (Desktop)...', exportImageMobile: 'Export Image (Mobile)...', find: 'Find',
        setDefault: 'Set as Default...',
        filePanel: 'Show / Hide File List', sourceMode: 'Toggle Markdown Source',
        panelSide: 'File List Position', panelSideLeft: 'On the Left', panelSideRight: 'On the Right',
        pageWidth: 'Text Width', pageWidthNarrow: 'Narrow', pageWidthStandard: 'Standard', pageWidthWide: 'Wide',
        light: 'Light', dark: 'Dark', elegant: 'Elegant',
        sepia: 'Sepia', notion: 'Notion', bear: 'Bear', writer: 'Writer',
        solarizedDark: 'Solarized Dark', nord: 'Nord', gruvbox: 'Gruvbox', dracula: 'Dracula', midnight: 'Midnight',
        importTheme: 'Import Theme...', whatsNew: "What's New",
        cheatsheet: 'Markdown Syntax', about: 'About ColaMD', checkForUpdates: 'Check for Updates...', updateAvailable: 'Update Available', close: 'Close Window',
        undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
        actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen', playSlideshow: 'Play Slideshow',
        fontSettings: 'Editor Font…',
        language: 'Language', chinese: '中文', english: 'English',
        hide: 'Hide ColaMD', hideOthers: 'Hide Others', showAll: 'Show All', quit: 'Quit ColaMD',
        minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
      }

  const themeIdByLabel = new Map<string, string>([
    [labels.light, 'light'],
    [labels.elegant, 'elegant'],
    [labels.notion, 'notion'],
    [labels.writer, 'writer'],
    [labels.bear, 'bear'],
    [labels.sepia, 'sepia'],
    [labels.dark, 'dark'],
    [labels.gruvbox, 'gruvbox'],
    [labels.midnight, 'midnight'],
    [labels.solarizedDark, 'solarized-dark'],
    [labels.nord, 'nord'],
    [labels.dracula, 'dracula'],
  ])
  const themeSubmenu: Electron.MenuItemConstructorOptions[] = [
    { label: labels.light, id: 'theme-light', type: 'checkbox' as const, checked: currentTheme === 'light', click: () => sendToFocused('set-theme', 'light') },
    { label: labels.elegant, id: 'theme-elegant', type: 'checkbox' as const, checked: currentTheme === 'elegant', click: () => sendToFocused('set-theme', 'elegant') },
    { label: labels.notion, id: 'theme-notion', type: 'checkbox' as const, checked: currentTheme === 'notion', click: () => sendToFocused('set-theme', 'notion') },
    { label: labels.writer, id: 'theme-writer', type: 'checkbox' as const, checked: currentTheme === 'writer', click: () => sendToFocused('set-theme', 'writer') },
    { label: labels.bear, id: 'theme-bear', type: 'checkbox' as const, checked: currentTheme === 'bear', click: () => sendToFocused('set-theme', 'bear') },
    { label: labels.sepia, id: 'theme-sepia', type: 'checkbox' as const, checked: currentTheme === 'sepia', click: () => sendToFocused('set-theme', 'sepia') },
    { type: 'separator' },
    { label: labels.dark, id: 'theme-dark', type: 'checkbox' as const, checked: currentTheme === 'dark', click: () => sendToFocused('set-theme', 'dark') },
    { label: labels.gruvbox, id: 'theme-gruvbox', type: 'checkbox' as const, checked: currentTheme === 'gruvbox', click: () => sendToFocused('set-theme', 'gruvbox') },
    { label: labels.midnight, id: 'theme-midnight', type: 'checkbox' as const, checked: currentTheme === 'midnight', click: () => sendToFocused('set-theme', 'midnight') },
    { label: labels.solarizedDark, id: 'theme-solarized-dark', type: 'checkbox' as const, checked: currentTheme === 'solarized-dark', click: () => sendToFocused('set-theme', 'solarized-dark') },
    { label: labels.nord, id: 'theme-nord', type: 'checkbox' as const, checked: currentTheme === 'nord', click: () => sendToFocused('set-theme', 'nord') },
    { label: labels.dracula, id: 'theme-dracula', type: 'checkbox' as const, checked: currentTheme === 'dracula', click: () => sendToFocused('set-theme', 'dracula') },
  ]
  if (customThemeItems.length > 0) {
    themeSubmenu.push({ type: 'separator' }, ...customThemeItems)
  }
  themeSubmenu.push({ type: 'separator' }, {
    label: labels.importTheme,
    click: () => sendToFocused('menu-import-theme')
  })

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'ColaMD',
      submenu: [
        { label: labels.about, role: 'about' as const },
        { type: 'separator' as const },
        { label: labels.hide, role: 'hide' as const },
        { label: labels.hideOthers, role: 'hideOthers' as const },
        { label: labels.showAll, role: 'unhide' as const },
        { type: 'separator' as const },
        { label: labels.quit, role: 'quit' as const }
      ]
    }] : []),
    {
      label: labels.file,
      submenu: [
        {
          label: labels.newFile,
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: labels.open,
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu-open')
        },
        {
          label: labels.recentOpen,
          // Our own label and submenu on every platform: the recentDocuments role
          // draws a clock icon and an English label, which no other menu item has.
          submenu: recentFiles().length
            ? recentFiles().map((p, index) => ({
                label: `${index + 1}. ${basename(p)}`,
                click: () => openFile(p)
              }))
            : [{ label: labels.noRecent, enabled: false }]
        },
        {
          label: labels.restoreOnLaunch,
          type: 'checkbox' as const,
          checked: recentStore.restoreOnLaunch,
          click: () => setRestoreOnLaunch(!recentStore.restoreOnLaunch)
        },
        {
          label: labels.clearRecent,
          click: () => clearRecentFiles()
        },
        { type: 'separator' },
        {
          label: labels.newTab,
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToFocused('menu-new-tab')
        },
        {
          label: labels.closeTab,
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToFocused('menu-close-tab')
        },
        { type: 'separator' },
        {
          label: labels.save,
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu-save')
        },
        {
          label: labels.saveAs,
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToFocused('menu-save-as')
        },
        { type: 'separator' },
        {
          label: labels.exportPDF,
          click: () => sendToFocused('menu-export-pdf')
        },
        {
          // The same pages the deck shows, one per sheet: a deck that leaves the
          // app with you.
          label: labels.exportSlidesPDF,
          click: () => {
            void exportSlidesPDF(getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null)
          }
        },
        {
          label: labels.exportHTML,
          click: () => sendToFocused('menu-export-html')
        },
        {
          label: labels.exportWord,
          click: () => sendToFocused('menu-export-docx')
        },
        {
          label: labels.exportImageDesktop,
          click: () => sendToFocused('menu-export-image', 'desktop')
        },
        {
          label: labels.exportImageMobile,
          click: () => sendToFocused('menu-export-image', 'mobile')
        },
        { type: 'separator' },
        {
          label: labels.setDefault,
          click: () => setAsDefaultApp()
        },
        { type: 'separator' },
        isMac ? { label: labels.close, accelerator: 'CmdOrCtrl+Shift+W', role: 'close' } : { label: labels.quit, role: 'quit' }
      ]
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, role: 'undo' },
        { label: labels.redo, role: 'redo' },
        { type: 'separator' },
        { label: labels.cut, role: 'cut' },
        { label: labels.copy, role: 'copy' },
        { label: labels.paste, role: 'paste' },
        { label: labels.selectAll, role: 'selectAll' },
        { type: 'separator' },
        {
          label: labels.find,
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToFocused('editor:search')
        },
        {
          // #58: discoverable format shortcuts; the menu is the documentation.
          label: preferredCheatsheetLanguage === 'zh' ? '格式' : 'Format',
          submenu: [
            { label: preferredCheatsheetLanguage === 'zh' ? '加粗' : 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendToFocused('editor:format', 'bold') },
            { label: preferredCheatsheetLanguage === 'zh' ? '斜体' : 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendToFocused('editor:format', 'italic') },
            { label: preferredCheatsheetLanguage === 'zh' ? '行内代码' : 'Inline Code', accelerator: 'CmdOrCtrl+E', click: () => sendToFocused('editor:format', 'inlineCode') },
            { label: preferredCheatsheetLanguage === 'zh' ? '删除线' : 'Strikethrough', accelerator: 'CmdOrCtrl+Shift+X', click: () => sendToFocused('editor:format', 'strikethrough') },
            { label: preferredCheatsheetLanguage === 'zh' ? '链接（网址取自剪贴板）' : 'Link (URL from clipboard)', accelerator: 'CmdOrCtrl+K', click: () => sendToFocused('editor:format', 'link') },
            { label: preferredCheatsheetLanguage === 'zh' ? '无序列表' : 'Bullet List', accelerator: 'CmdOrCtrl+Shift+8', click: () => sendToFocused('editor:format', 'bulletList') },
            { label: preferredCheatsheetLanguage === 'zh' ? '有序列表' : 'Ordered List', accelerator: 'CmdOrCtrl+Shift+7', click: () => sendToFocused('editor:format', 'orderedList') }
          ]
        }
      ]
    },
    {
      label: labels.view,
      submenu: [
        { label: labels.actualSize, role: 'resetZoom' },
        { label: labels.zoomIn, role: 'zoomIn' },
        { label: labels.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        {
          label: labels.filePanel,
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendToFocused('toggle-file-panel')
        },
        {
          // Which side the panel sits on is the renderer's preference, next to
          // the panel's own width; this menu only asks for the change and shows
          // the answer (the renderer reports back, like the theme does).
          label: labels.panelSide,
          submenu: [
            { id: 'panel-side-right', label: labels.panelSideRight, type: 'checkbox' as const, checked: currentPanelSide === 'right', click: () => sendToFocused('set-panel-side', 'right') },
            { id: 'panel-side-left', label: labels.panelSideLeft, type: 'checkbox' as const, checked: currentPanelSide === 'left', click: () => sendToFocused('set-panel-side', 'left') }
          ]
        },
        {
          label: labels.sourceMode,
          accelerator: 'CmdOrCtrl+/',
          click: () => sendToFocused('toggle-source-mode')
        },
        { type: 'separator' },
        { label: labels.fontSettings, click: () => sendToFocused('open-font-settings') },
        {
          // The column's width is the renderer's preference, next to the panel's
          // side and its width; this menu only asks for the change and then shows
          // the answer (the renderer reports back, like the theme does).
          label: labels.pageWidth,
          submenu: [
            { id: 'page-width-narrow', label: labels.pageWidthNarrow, type: 'checkbox' as const, checked: currentPageWidth === 'narrow', click: () => sendToFocused('set-page-width', 'narrow') },
            { id: 'page-width-standard', label: labels.pageWidthStandard, type: 'checkbox' as const, checked: currentPageWidth === 'standard', click: () => sendToFocused('set-page-width', 'standard') },
            { id: 'page-width-wide', label: labels.pageWidthWide, type: 'checkbox' as const, checked: currentPageWidth === 'wide', click: () => sendToFocused('set-page-width', 'wide') }
          ]
        },
        {
          label: labels.language,
          submenu: [
            { label: labels.chinese, type: 'checkbox' as const, checked: getPreferredLanguage() === 'zh', click: () => setPreferredLanguage('zh') },
            { label: labels.english, type: 'checkbox' as const, checked: getPreferredLanguage() === 'en', click: () => setPreferredLanguage('en') }
          ]
        },
        { type: 'separator' },
        // A deck is the document itself cut at its `---`, so this belongs with the
        // ways of looking at the document, beside full screen.
        {
          label: labels.playSlideshow,
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => sendToFocused('menu-play-slideshow')
        },
        { label: labels.fullscreen, role: 'togglefullscreen' }
      ]
    },
    {
      label: labels.theme,
      submenu: themeSubmenu
    },
    // The Window menu is not cosmetic: macOS injects the system window-tiling
    // commands (System Settings → Keyboard → Keyboard Shortcuts → Windows, e.g.
    // ⌃⌥⌘←) into whichever menu is registered via setWindowsMenu. Electron does
    // that only for role 'windowMenu' — without it every tiling shortcut is
    // dead in the app (#97). The role supplies the items; the label is ours, so
    // the menu speaks the interface language like every other one (an English
    // "Window" sat between 主题 and 帮助 until 2026-09-15).
    ...(isMac ? [{ role: 'windowMenu' as const, label: labels.window }] : []),
    {
      label: labels.help,
      submenu: [
        {
          label: labels.whatsNew,
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => { void openBundledDocument('changelog.md') }
        },
        {
          label: labels.cheatsheet,
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => { void openCheatsheet(preferredCheatsheetLanguage) }
        },
        {
          label: labels.checkForUpdates,
          enabled: app.isPackaged,
          click: () => { void checkForUpdates(true) }
        },
        ...(latestVersion ? [{
          label: `${labels.updateAvailable} v${latestVersion}`,
          click: () => {
            updateDownloadRequested = true
            void autoUpdater.downloadUpdate()
          }
        }] : []),
        { type: 'separator' },
        { label: labels.about, role: 'about' }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  localizeWindowMenu(menu, labels)
  themeMenuItems = [
    ...themeSubmenu.filter((item): item is Electron.MenuItemConstructorOptions & { id: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, theme: themeIdByLabel.get(item.label ?? '') ?? (item.id.startsWith('theme-custom-') ? `custom:${String(item.label)}.css` : '') })),
  ]
}

// The Window menu's three standard items come from the 'windowMenu' role, and
// Electron leaves their labels to the system language. In an app whose interface
// is Chinese on an English system that left "Minimize / Zoom / Bring All to
// Front" sitting in an otherwise Chinese menu (2026-09-15), so the labels are
// rewritten to the interface language. The role stays: it is what registers the
// menu with macOS and keeps the system window-tiling shortcuts alive (#97).
function localizeWindowMenu(menu: Menu, labels: { minimize: string; zoom: string; front: string }): void {
  // Compared lowercased because Electron reports the role as 'windowmenu' while
  // its own types spell the constructor option 'windowMenu'.
  const windowMenu = menu.items.find((item) => String(item.role).toLowerCase() === 'windowmenu')
  if (!windowMenu?.submenu) return
  const byRole: Record<string, string> = {
    minimize: labels.minimize,
    zoom: labels.zoom,
    front: labels.front
  }
  for (const item of windowMenu.submenu.items) {
    const label = item.role ? byRole[item.role] : undefined
    if (label) item.label = label
  }
}

function updateThemeMenuChecks(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const entry of themeMenuItems) {
    const item = menu.getMenuItemById(entry.id)
    if (item) item.checked = entry.theme === currentTheme
  }
}

function updatePanelSideMenuChecks(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const side of ['left', 'right'] as const) {
    const item = menu.getMenuItemById(`panel-side-${side}`)
    if (item) item.checked = side === currentPanelSide
  }
}

function updatePageWidthMenuChecks(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const width of ['narrow', 'standard', 'wide'] as const) {
    const item = menu.getMenuItemById(`page-width-${width}`)
    if (item) item.checked = width === currentPageWidth
  }
}

// --- Auto update (weak, non-blocking) ---
let manualUpdateCheck = false
let updateDownloadRequested = false

// Update checks run once a day. The stamp lives beside the other preferences so
// a restart does not buy a second check, and a window left open gets its check
// from the timer in setupAutoUpdater.
const updateCheckStampPath = join(app.getPath('userData'), 'update-check.json')
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const UPDATE_CHECK_TICK_MS = 30 * 60 * 1000

function lastUpdateCheckAt(): number {
  try {
    const parsed = JSON.parse(readFileSync(updateCheckStampPath, 'utf-8')) as { at?: unknown }
    return typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : 0
  } catch {
    return 0
  }
}

function markUpdateChecked(): void {
  const at = Date.now()
  void mkdir(dirname(updateCheckStampPath), { recursive: true })
    .then(() => writeFile(updateCheckStampPath, JSON.stringify({ at }), 'utf-8'))
    .catch(() => { /* a stamp that cannot be written costs one extra check */ })
}

function showUpdateMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = getFocusedWindow()
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
}

async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) return
  // Once a day, not once a launch: the check is a request for a small manifest,
  // and five launches in a day meant five identical requests for the same answer
  // (2026-09-21). A manual check is the user asking now, and it restarts the day.
  if (!manual && Date.now() - lastUpdateCheckAt() < UPDATE_CHECK_INTERVAL_MS) return
  manualUpdateCheck = manual
  try {
    await autoUpdater.checkForUpdates()
    markUpdateChecked()
  } catch (error) {
    // The day is not spent when the check could not happen at all: a launch
    // without a network should not cost the next one its chance to see a
    // release. Nothing is shown for a background check.
    if (!manualUpdateCheck) return
    manualUpdateCheck = false
    const chinese = getPreferredCheatsheetLanguage() === 'zh'
    await showUpdateMessage({
      type: 'error',
      buttons: [chinese ? '好' : 'OK'],
      message: chinese ? '无法检查更新' : 'Unable to check for updates',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const broadcast = (channel: string, version: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, version)
    }
  }

  autoUpdater.on('update-available', (info) => {
    manualUpdateCheck = false
    latestVersion = info.version
    buildMenu()
    broadcast('update-available', info.version)
  })
  autoUpdater.on('update-not-available', () => {
    if (!manualUpdateCheck) return
    manualUpdateCheck = false
    const chinese = getPreferredCheatsheetLanguage() === 'zh'
    void showUpdateMessage({
      type: 'info',
      buttons: [chinese ? '好' : 'OK'],
      message: chinese ? 'ColaMD 已是最新版本' : 'ColaMD is up to date',
      detail: chinese ? `当前版本：v${app.getVersion()}` : `Current version: v${app.getVersion()}`
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloadRequested = false
    broadcast('update-downloaded', info.version)
  })
  autoUpdater.on('download-progress', (progress) => {
    if (!updateDownloadRequested) return
    broadcast('update-progress', String(Math.min(100, Math.round(progress.percent))))
  })
  autoUpdater.on('error', (err) => {
    console.error('autoUpdater:', err.message)
    // Only surface failures for a user-initiated download; background
    // update checks fail silently (weak, non-blocking philosophy).
    if (!updateDownloadRequested) return
    updateDownloadRequested = false
    broadcast('update-error', '')
  })

  // Defer the first check so it never delays startup.
  setTimeout(() => {
    void checkForUpdates()
  }, 8000)

  // A window that stays open for days still hears about the next release the day
  // it lands; the gate inside checkForUpdates keeps these ticks from turning into
  // requests of their own.
  const dailyTick = setInterval(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_TICK_MS)
  dailyTick.unref()
}

ipcMain.handle('download-update', async () => {
  updateDownloadRequested = true
  await autoUpdater.downloadUpdate()
})

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true)
})

// App lifecycle

// --- Single instance (#99, #100) ---
// A second launch while ColaMD runs must not become a second process: it
// doubles memory, shows two menu bars, and its renderer stalls ~4 seconds on
// the first instance's LevelDB lock for Local Storage before giving up on
// writing theme/state preferences. The second launch's files arrive in
// 'second-instance' and open as tabs of the existing window instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Keep files only: the app-path argument (".") and stray directories are
    // not documents.
    const fileArgs = argv.slice(app.isPackaged ? 1 : 2)
      .filter((arg) => !arg.startsWith('-'))
      .filter((arg) => {
        try { return !statSync(arg).isDirectory() } catch { return true }
      })
    if (fileArgs.length === 0) {
      // Plain re-launch: bring the app the user already has back to front.
      const target = focusedOrLastWindow()
      if (target) {
        if (target.isMinimized()) target.restore()
        target.show()
        target.focus()
      } else {
        createWindow()
      }
      return
    }
    for (const fp of fileArgs) openFile(fp)
  })
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  markStartup('app-ready')
  ensureThemesDir()
  buildMenu()

  // Check command line args for file paths
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  const fileArgs = args.filter((arg) => !arg.startsWith('-'))
  if (fileArgs.length > 0) {
    pendingFilePaths = fileArgs
  }

  if (pendingFilePaths.length > 0) {
    // The first argument becomes the window; the rest open as its tabs (#99)
    // instead of one window per file.
    const [first, ...rest] = pendingFilePaths
    const firstWindow = createWindow(first)
    for (const fp of rest) openFileAsTab(firstWindow, fp)
    pendingFilePaths = []
  } else {
    // Start with an empty editor and no directory scan. Bundled examples stay
    // available from Help and are loaded only when explicitly requested.
    // With session restore on, reopen the most recent document instead (#45).
    const lastDoc = recentStore.restoreOnLaunch ? recentStore.recent.find((p) => existsSync(p)) : undefined
    if (lastDoc) {
      createWindow(lastDoc)
    } else {
      createWindow()
    }
  }

  setupAutoUpdater()
  void openChangelogOnceForVersion()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// --- Unsaved-changes guard (auto-save is the primary defense; this is the backstop) ---

// Ask one specific renderer for an atomic dirty/content snapshot. A timeout is
// a failed request, never a signal that the document is clean.
function requestDocumentState(win: BrowserWindow): Promise<DocumentSnapshot | null> {
  const requestId = `${win.webContents.id}:${++nextDocumentStateRequestId}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingDocumentStateRequests.get(requestId)
      if (!pending) return
      pendingDocumentStateRequests.delete(requestId)
      pending.resolve(null)
    }, 3000)
    pendingDocumentStateRequests.set(requestId, { webContentsId: win.webContents.id, resolve, timer })
    win.webContents.send('request-document-state', requestId)
  })
}

ipcMain.on('document-state-response', (event, requestId: unknown, snapshot: unknown) => {
  if (typeof requestId !== 'string' || !snapshot || typeof snapshot !== 'object') return
  const { dirty, content, tabs } = snapshot as DocumentSnapshot
  if (typeof dirty !== 'boolean' || typeof content !== 'string') return
  const pending = pendingDocumentStateRequests.get(requestId)
  if (!pending || pending.webContentsId !== event.sender.id) return
  pendingDocumentStateRequests.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve({
    dirty,
    content,
    tabs: Array.isArray(tabs)
      ? tabs.filter((tab) => tab && typeof tab.content === 'string' && (tab.path === null || typeof tab.path === 'string'))
      : undefined
  })
})

ipcMain.on('renderer-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    getState(win).rendererReady = true
    // The renderer is listening now, so it can be told the state it cannot read
    // for itself: a window restored into full screen must not keep the traffic
    // light clearance.
    win.webContents.send('fullscreen-changed', win.isFullScreen())
    // Files queued before the renderer could listen (multi-file launch, early
    // second-instance) go out now.
    flushPendingTabFiles(win)
  }
  markStartup('renderer-ready')
  writeStartupTrace()
})

// Renderer reports its unsaved state as a fast path for quit coordination.
ipcMain.on('set-dirty', (event, isDirty: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) getState(win).dirty = !!isDirty
})

// Concurrent close events for the same window must share one prompt and save.
function confirmWindowClose(win: BrowserWindow, state: WindowState): Promise<boolean> {
  if (!state.closePromise) {
    state.closePromise = handleWindowClose(win, state).finally(() => {
      state.closePromise = null
    })
  }
  return state.closePromise
}

// Confirm before losing unsaved edits. Returns true only after a verified save
// or an explicit discard; every failure leaves the window open and dirty.
async function handleWindowClose(win: BrowserWindow, state: WindowState): Promise<boolean> {
  if (!state.rendererReady && !state.dirty) return true

  const snapshot = await requestDocumentState(win)
  if (!snapshot) {
    // Renderer is unresponsive: it cannot report state or save anything, so
    // blocking forever would trap the user. Offer an explicit escape instead.
    if (!state.dirty) return true
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [uiText('仍要关闭', 'Close anyway'), uiText('取消', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      message: uiText('无法与编辑窗口通信', 'Cannot reach the editor window'),
      detail: uiText(
        '窗口可能已停止响应，无法确认是否有未保存的修改。强行关闭可能丢失内容。',
        'The window is not responding, so unsaved changes cannot be checked. Closing it may lose content.'
      )
    })
    return response === 0
  }
  state.dirty = snapshot.dirty
  if (!snapshot.dirty) return true

  const detail = state.filePath
    ? uiText(`“${basename(state.filePath)}” 有未保存的修改。`, `“${basename(state.filePath)}” has unsaved changes.`)
    : uiText('当前未命名文档有未保存的修改。', 'The current untitled document has unsaved changes.')
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [uiText('保存', 'Save'), uiText('不保存', "Don't Save"), uiText('取消', 'Cancel')],
    defaultId: 0,
    cancelId: 2,
    message: uiText('未保存的修改', 'Unsaved changes'),
    detail
  })
  if (response === 2) return false
  if (response === 1) {
    state.dirty = false
    return true
  }

  const sourcePath = state.filePath
  let filePath = sourcePath
  if (!filePath) {
    const saveAs = await dialog.showSaveDialog(win, {
      title: uiText('保存 Markdown 文档', 'Save Markdown document'),
      buttonLabel: uiText('保存', 'Save'),
      nameFieldLabel: uiText('文件名：', 'File name:'),
      defaultPath: suggestSavePath(win, suggestFileName(win, snapshot.content)),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (saveAs.canceled || !saveAs.filePath) return false
    filePath = saveAs.filePath
  }

  // Background tabs are not the window's active document, so they bypass the
  // active-file guards and are written straight to their own paths. An untitled
  // background tab cannot be written without a dialog, so it is reported
  // instead of being dropped silently.
  const backgroundTabs = (snapshot.tabs ?? []).filter((tab) => tab.path && tab.path !== sourcePath)
  const untitledTabs = (snapshot.tabs ?? []).filter((tab) => !tab.path)
  for (const tab of backgroundTabs) {
    try {
      await writeFile(tab.path as string, tab.content, 'utf-8')
    } catch {
      await dialog.showMessageBox(win, {
        type: 'error',
        buttons: [uiText('好', 'OK')],
        message: uiText('无法保存标签页', 'Could not save the tab'),
        detail: uiText(
          `“${basename(tab.path as string)}” 写入失败，为保护内容已取消关闭。`,
          `Writing “${basename(tab.path as string)}” failed, so closing was cancelled to protect the content.`
        )
      })
      return false
    }
  }
  if (untitledTabs.length > 0) {
    const untitled = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [uiText('取消', 'Cancel'), uiText('丢弃未命名标签页', 'Discard untitled tabs')],
      defaultId: 0,
      cancelId: 0,
      message: uiText('还有未命名的标签页没有保存', 'Some untitled tabs are still unsaved'),
      detail: uiText(
        '关闭窗口会丢掉它们里的内容。请先切到那些标签页保存。',
        'Closing the window would lose their content. Switch to those tabs and save them first.'
      )
    })
    if (untitled.response === 0) return false
  }

  const saved = await saveToPath(win, filePath, snapshot.content, sourcePath, true)
  if (!saved) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法保存文档', 'Could not save the document'),
      detail: uiText(
        '为保护未保存的内容，已取消关闭。请检查文件权限和可用磁盘空间。',
        'Closing was cancelled to protect the unsaved content. Check file permissions and free disk space.'
      )
    })
    return false
  }
  state.dirty = false
  return true
}

app.on('before-quit', (e) => {
  if (isQuitting) return
  e.preventDefault()
  void (async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      const ok = await confirmWindowClose(win, getState(win))
      if (!ok) return // user cancelled or saving failed; abort the quit entirely
    }
    isQuitting = true
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady()) {
    openFile(filePath)
  } else {
    pendingFilePaths.push(filePath)
  }
})
