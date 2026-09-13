import { app, BrowserWindow, ipcMain, dialog, Menu, shell, session, clipboard } from 'electron'
import { execFile } from 'child_process'
import { autoUpdater } from 'electron-updater'
import { join, basename, dirname, extname, isAbsolute, resolve, relative } from 'path'
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
const releaseNoticePath = join(app.getPath('userData'), 'release-notice.json')

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

// Browse Markdown files in the current directory. Directories are kept as
// navigable entries rather than flattening the whole tree into one list.
async function listSiblingFiles(filePath: string | null, browseDir?: string): Promise<SiblingFile[]> {
  const dir = browseDir ?? (filePath ? dirname(filePath) : null)
  if (!dir) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const result: SiblingFile[] = []
    const parent = dirname(dir)
    if (parent !== dir) result.push({ name: '..', path: parent, kind: 'parent' })

    result.push(
      ...entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'directory' as const }))
        .sort((a, b) => a.name.localeCompare(b.name))
    )
    result.push(
      ...entries
        .filter((e) => e.isFile() && MARKDOWN_EXTENSIONS.includes(extname(e.name).toLowerCase()))
        .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'file' as const }))
        .sort((a, b) => a.name.localeCompare(b.name))
    )
    return result
  } catch {
    return []
  }
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
type UiLanguage = 'zh' | 'en'
let preferredLanguage: UiLanguage | null = null
try {
  const parsed = JSON.parse(readFileSync(languagePreferencePath, 'utf-8')) as { language?: unknown }
  if (parsed.language === 'zh' || parsed.language === 'en') preferredLanguage = parsed.language
} catch { /* first run or unreadable preference */ }

function getPreferredLanguage(): UiLanguage {
  return preferredLanguage ?? (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')
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
  // macOS keeps recents live via the native recentDocuments role instead;
  // other platforms only refresh the menu on user-initiated saves/opens.
  if (process.platform === 'darwin') {
    app.addRecentDocument(filePath)
  } else if (rebuildMenu) {
    buildMenu()
  }
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

// Per-window state. The window is a shell; every open document lives in a
// TabState with its own watcher, mtime bookkeeping, and write queue, so two
// tabs can never clobber each other's file or echo suppression (docs/tabs-tech-design.md D3).
interface TabState {
  tabId: number
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
  dirty: boolean
  writeQueue: Promise<void>
}

interface WindowState {
  tabs: Map<number, TabState>
  activeTabId: number
  nextTabId: number
  siblingsTimer: ReturnType<typeof setTimeout> | null
  closePromise: Promise<boolean> | null
  rendererReady: boolean
  closeAuthorized: boolean
}

interface TabDocState {
  tabId: number
  path: string | null
  dirty: boolean
  content?: string
}

interface PendingDocumentStateRequest {
  webContentsId: number
  resolve: (tabs: TabDocState[] | null) => void
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
    state = { tabs: new Map(), activeTabId: -1, nextTabId: 0, siblingsTimer: null, closePromise: null, rendererReady: false, closeAuthorized: false }
    windowStates.set(win.id, state)
  }
  return state
}

function createTab(win: BrowserWindow): TabState {
  const state = getState(win)
  const tab: TabState = {
    tabId: state.nextTabId,
    filePath: null,
    browsePath: null,
    watcher: null,
    isInternalSave: false,
    internalSaveCount: 0,
    lastKnownMtime: 0,
    lastInternalSaveContent: null,
    debounceTimer: null,
    dirty: false,
    writeQueue: Promise.resolve()
  }
  state.nextTabId += 1
  state.tabs.set(tab.tabId, tab)
  return tab
}

// Resolve the tab an IPC call targets: an explicit tabId when the renderer
// supplies one, otherwise the window's active tab.
function getTab(win: BrowserWindow, tabId?: unknown): TabState | null {
  const state = getState(win)
  if (typeof tabId === 'number' && Number.isInteger(tabId) && state.tabs.has(tabId)) {
    return state.tabs.get(tabId) ?? null
  }
  return state.tabs.get(state.activeTabId) ?? null
}

function activeTabOf(state: WindowState): TabState | null {
  return state.tabs.get(state.activeTabId) ?? null
}

function hasDirtyTabs(state: WindowState): boolean {
  for (const tab of state.tabs.values()) {
    if (tab.dirty) return true
  }
  return false
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
function fileChangedExternally(filePath: string, tab: TabState): boolean {
  if (!tab.lastKnownMtime || filePath !== tab.filePath) return false
  const diskMtime = fileMtimeMs(filePath)
  if (!diskMtime) return false
  return diskMtime > tab.lastKnownMtime + 1
}

// Hand the renderer the version now on disk so the existing external-change
// flow can ask the user which side to keep.
function notifyExternalChange(win: BrowserWindow, filePath: string, tabId: number): void {
  void readFile(filePath, 'utf-8')
    .then((data) => {
      if (!win.isDestroyed()) win.webContents.send('file-changed', { tabId, content: resolveImagePaths(data, filePath) })
    })
    .catch(() => { /* the watcher picks it up on the next event */ })
}

function createWindow(filePath?: string, initialContent?: string, initialBrowsePath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
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

  const state = getState(win)
  const initialTab = createTab(win)
  // The window's first tab is active from birth: every active-tab resolution
  // (siblings, reveal, save defaults, conflict flow) depends on it, and the
  // renderer's first-tab path does not route through the switch protocol.
  state.activeTabId = initialTab.tabId
  if (initialBrowsePath) initialTab.browsePath = initialBrowsePath

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    markStartup('renderer-loaded')
    // Announce the window's first tab before any content so the renderer can
    // build its session bookkeeping, then load into it.
    win.webContents.send('new-tab', initialTab.tabId)
    if (filePath) {
      loadFileInTab(win, initialTab, filePath)
    } else if (initialContent) {
      // In-memory content (e.g. the Markdown cheatsheet) — no file, no watcher
      initialTab.lastInternalSaveContent = initialContent
      win.webContents.send('file-opened', { tabId: initialTab.tabId, path: null, content: initialContent })
    }
  })

  // Intercept window close: confirm unsaved changes before the window dies.
  // cmd+w closing the last tab and quit both funnel through here.
  win.on('close', (e) => {
    const st = getState(win)
    if (isQuitting || st.closeAuthorized || (!st.rendererReady && !hasDirtyTabs(st))) return
    e.preventDefault()
    void confirmWindowClose(win, st).then((ok) => {
      if (ok && !win.isDestroyed()) {
        st.closeAuthorized = true
        win.close()
      }
    })
  })

  win.on('closed', () => {
    for (const tab of state.tabs.values()) stopWatching(tab)
    windowStates.delete(win.id)
  })

  updateTitle(win)
  return win
}

function updateTitle(win: BrowserWindow): void {
  const state = getState(win)
  const active = activeTabOf(state)
  const fileName = active?.filePath ? basename(active.filePath) : 'Untitled'
  win.setTitle(`${fileName} — ColaMD`)
}

function suggestFileName(win: BrowserWindow, content?: string): string | undefined {
  const active = activeTabOf(getState(win))
  if (active?.filePath) return basename(active.filePath, '.md')
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
  return activeTabOf(state)?.filePath ? join(dirname(activeTabOf(state)!.filePath!), name) : name
}

function stopWatching(tab: TabState): void {
  if (tab.watcher) {
    tab.watcher.close()
    tab.watcher = null
  }
}

function watchFile(win: BrowserWindow, tab: TabState): void {
  if (!tab.filePath) return
  if (tab.watcher) {
    tab.watcher.close()
    tab.watcher = null
  }

  const state = getState(win)
  const filePath = tab.filePath
  const tabId = tab.tabId
  const dir = dirname(filePath)
  const fileName = basename(filePath)
  // macOS FSEvents replays recent history when a watcher starts; drop events
  // fired within this window so opening a file doesn't trigger a spurious reload.
  let suppressUntil = 0

  const scheduleReload = (): void => {
    if (tab.debounceTimer) clearTimeout(tab.debounceTimer)
    tab.debounceTimer = setTimeout(() => {
      readFile(filePath, 'utf-8')
        .then((data) => {
          // Our own writes echo back through FSEvents long after the internal
          // save window closes; reloading them would revert the editor and
          // wipe anything typed since the save. Skip self-echoes.
          if (tab.lastInternalSaveContent !== null && data === tab.lastInternalSaveContent) return
          tab.lastInternalSaveContent = null
          tab.lastKnownMtime = fileMtimeMs(filePath)
          if (!win.isDestroyed()) win.webContents.send('file-changed', { tabId, content: resolveImagePaths(data, filePath) })
        })
        .catch(() => { /* file mid-replace; a follow-up event will re-trigger */ })
    }, 100)
  }

  const onExternalChange = (): void => {
    if (tab.isInternalSave) return
    if (Date.now() < suppressUntil) return

    scheduleReload()
  }

  // Agent created/renamed/deleted a sibling file — refresh the file panel list
  const scheduleSiblingsRefresh = (): void => {
    if (state.siblingsTimer) clearTimeout(state.siblingsTimer)
    state.siblingsTimer = setTimeout(() => {
      state.siblingsTimer = null
      if (tab.filePath !== filePath) return // file switched meanwhile; new watcher handles it
      listSiblingFiles(filePath, tab.browsePath ?? dirname(filePath)).then((files) => {
        if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      })
    }, 300)
  }

  const establish = (): void => {
    if (tab.filePath !== filePath) return
    suppressUntil = Date.now() + 300
    if (tab.watcher) {
      tab.watcher.close()
      tab.watcher = null
    }
    try {
      // Watch the parent directory instead of the file: agents often save
      // atomically (write temp + rename over), which replaces the file's
      // inode and silently kills a watcher bound to the old file. A
      // directory watcher survives those and keeps reporting our filename.
      const watcher = watch(dir, (eventType, filename) => {
        if (tab.isInternalSave) return
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
      tab.watcher = watcher
    } catch {
      // Fallback: watch the file directly if the directory isn't watchable
      try {
        const watcher = watch(filePath, (eventType) => {
          if (eventType !== 'change' || tab.isInternalSave) return
          onExternalChange()
        })
        watcher.on('error', () => establish())
        tab.watcher = watcher
      } catch { /* file not watchable; nothing to do */ }
    }
  }

  establish()
}

// Rewrite local image paths to encoded file:// URLs. This handles both
// standard Markdown images and the raw <img src="..."> HTML that Milkdown
// accepts, including Windows drive letters, backslashes, spaces and Unicode.
function localImageUrl(src: string, dir: string): string {
  const value = src.trim().replace(/^<|>$/g, '')
  if (/^(?:https?:|file:|data:|blob:)/i.test(value)) return src
  return pathToFileURL(isAbsolute(value) ? value : resolve(dir, value)).href
}

function resolveImagePaths(content: string, filePath: string): string {
  const dir = dirname(filePath)
  const markdown = content.replace(/!\[([^\]]*)\]\((?!https?:\/\/|file:\/\/|data:|blob:)([^)]+)\)/g, (_match, alt, src) => {
    return `![${alt}](${localImageUrl(src, dir)})`
  })

  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (_match, prefix, quote, src) => {
    return `${prefix}${quote}${localImageUrl(src, dir)}${quote}`
  })
}

// Keep the editor's display URLs out of the Markdown source. Image paths are
// rewritten to file:// URLs for rendering, then converted back to paths that
// are portable relative to the file being saved.
function sourceImageUrl(src: string, dir: string): string {
  const value = src.trim()
  if (!/^file:/i.test(value)) return src

  try {
    const target = fileURLToPath(value)
    const portable = relative(dir, target).replaceAll('\\', '/')
    return portable || './'
  } catch {
    return src
  }
}

function markdownImagePath(value: string): string {
  return /[\s()]/.test(value) ? `<${value}>` : value
}

function restoreImagePaths(content: string, filePath: string): string {
  const dir = dirname(filePath)
  const markdown = content.replace(/!\[([^\]]*)\]\((file:[^)]+)\)/gi, (_match, alt, src) => {
    return `![${alt}](${markdownImagePath(sourceImageUrl(src, dir))})`
  })

  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])(file:[^"']+)\2/gi, (_match, prefix, quote, src) => {
    return `${prefix}${quote}${sourceImageUrl(src, dir)}${quote}`
  })
}

function loadFileInTab(win: BrowserWindow, tab: TabState, filePath: string): void {
  const operation = async (): Promise<void> => {
    try {
      const data = await readFile(filePath, 'utf-8')
      if (win.isDestroyed()) return
      tab.filePath = filePath
      tab.browsePath = dirname(filePath)
      watchFile(win, tab)
      if (getState(win).activeTabId === tab.tabId) updateTitle(win)
      pushRecentFile(filePath, true)
      tab.lastInternalSaveContent = data
      tab.lastKnownMtime = fileMtimeMs(filePath)
      win.webContents.send('file-opened', { tabId: tab.tabId, path: filePath, content: resolveImagePaths(data, filePath) })
    } catch {
      // Keep the current document when the selected file cannot be read.
    }
  }
  const next = tab.writeQueue.then(operation, operation)
  tab.writeQueue = next.then(() => undefined, () => undefined)
}

// Find the window and tab that already have this file open.
function findTabForFile(filePath: string): { win: BrowserWindow; state: WindowState; tab: TabState } | null {
  for (const [id, state] of windowStates) {
    for (const tab of state.tabs.values()) {
      if (tab.filePath === filePath) {
        const win = BrowserWindow.fromId(id)
        if (win) return { win, state, tab }
      }
    }
  }
  return null
}

// design.md: opening a file never spawns a tab on its own. It loads into the
// current tab of the target window; only a blank, unmodified current tab is
// silently overwritten (the old "reuse empty window" rule, now per tab).
async function openIntoWindow(win: BrowserWindow, filePath: string): Promise<void> {
  const state = getState(win)
  const tab = activeTabOf(state) ?? createTab(win)
  state.activeTabId = tab.tabId
  if (!tab.filePath && !tab.dirty) {
    loadFileInTab(win, tab, filePath)
    win.focus()
    return
  }
  if (tab.dirty && !await confirmAndSaveTab(win, tab)) return
  loadFileInTab(win, tab, filePath)
  win.focus()
}

// Open file: focus the existing tab, or load into the focused window's
// current tab, or create a window when none exists.
function openFile(filePath: string): void {
  const existing = findTabForFile(filePath)
  if (existing) {
    existing.state.activeTabId = existing.tab.tabId
    existing.win.focus()
    existing.win.webContents.send('activate-tab', existing.tab.tabId)
    return
  }

  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null
  if (!win) {
    createWindow(filePath).focus()
    return
  }
  void openIntoWindow(win, filePath)
}

// Serialize writes per tab. A save is valid only while its source document
// remains in that tab; stale queued work must neither overwrite tab state nor
// make a later document appear saved.
function saveToPath(win: BrowserWindow, tab: TabState, filePath: string, content: string, sourcePath: string | null, rebuildMenu = false): Promise<boolean> {
  const state = getState(win)
  const operation = async (): Promise<boolean> => {
    if (win.isDestroyed() || !state.tabs.has(tab.tabId) || tab.filePath !== sourcePath) return false
    try {
      tab.internalSaveCount += 1
      tab.isInternalSave = true
      const dataToWrite = restoreImagePaths(content, filePath)
      await writeFile(filePath, dataToWrite, 'utf-8')
      tab.lastInternalSaveContent = dataToWrite
      tab.lastKnownMtime = fileMtimeMs(filePath)
      if (win.isDestroyed() || tab.filePath !== sourcePath) return false
      tab.filePath = filePath
      tab.browsePath = dirname(filePath)
      watchFile(win, tab)
      if (state.activeTabId === tab.tabId) updateTitle(win)
      pushRecentFile(filePath, rebuildMenu)
      return true
    } catch {
      return false
    } finally {
      setTimeout(() => {
        tab.internalSaveCount = Math.max(0, tab.internalSaveCount - 1)
        tab.isInternalSave = tab.internalSaveCount > 0
      }, 100)
    }
  }
  const next = tab.writeQueue.then(operation, operation)
  tab.writeQueue = next.then(() => undefined, () => undefined)
  return next
}

// IPC Handlers

ipcMain.on('open-external', (_event, url: string) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url)
  }
})

ipcMain.handle('get-file-manager-name', () => fileManagerName())

function fileManagerName(): 'finder' | 'explorer' | 'file-manager' {
  if (process.platform === 'darwin') return 'finder'
  if (process.platform === 'win32') return 'explorer'
  return 'file-manager'
}

// Right-click menu for a file panel entry. Native menu on purpose: no custom
// popup to theme, keep it accessible and platform familiar.
ipcMain.handle('entry-context-menu', (event, targetPath: unknown, kind: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof targetPath !== 'string' || targetPath.length === 0) return
  const zh = getPreferredLanguage() === 'zh'
  const manager = fileManagerName()
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: zh ? '复制路径' : 'Copy path', click: () => clipboard.writeText(targetPath) }
  ]
  if (kind !== 'directory') {
    items.push({ label: zh ? '用默认应用打开' : 'Open in default app', click: () => { void shell.openPath(targetPath) } })
  }
  items.push({
    label: manager === 'explorer' ? (zh ? '在资源管理器中显示' : 'Reveal in File Explorer') : (zh ? '在 Finder 中显示' : 'Reveal in Finder'),
    click: () => shell.showItemInFolder(targetPath)
  })
  Menu.buildFromTemplate(items).popup({ window: win })
})

ipcMain.handle('reveal-file', (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const filePath = activeTabOf(getState(win))?.filePath
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
  // Dedup + reuse-blank-tab + overwrite-with-confirm all live in openFile.
  openFile(result.filePaths[0])
  return null
})

ipcMain.handle('open-file-path', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win || typeof filePath !== 'string') return null
  openFile(filePath)
  return null
})

// Same-directory file panel: list markdown files next to the open file
ipcMain.handle('list-siblings', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const active = activeTabOf(getState(win))
  return listSiblingFiles(active?.filePath ?? null, active?.browsePath ?? undefined)
})

// Open a Markdown file or navigate into a directory from the file panel.
ipcMain.handle('open-sibling', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win || typeof filePath !== 'string') return false
  try {
    const info = await stat(filePath)
    const active = activeTabOf(getState(win))
    if (info.isDirectory() && active) {
      active.browsePath = filePath
      const files = await listSiblingFiles(active.filePath, filePath)
      if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      return true
    }
  } catch {
    return false
  }
  openFile(filePath)
  return true
})

ipcMain.handle('save-file', async (event, content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean, tabId?: number) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const tab = getTab(win, tabId)
  if (!tab) return null
  const sourcePath = tab.filePath
  // A queued auto-save must never write an old document into a file opened
  // after the save was scheduled.
  if (expectedPath && sourcePath !== expectedPath) return null
  let filePath = sourcePath
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, {
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
  if (autosave && fileChangedExternally(filePath, tab)) {
    notifyExternalChange(win, filePath, tab.tabId)
    return null
  }
  const ok = await saveToPath(win, tab, filePath, content, sourcePath, rebuildMenu ?? false)
  return ok ? filePath : null
})

ipcMain.handle('save-file-as', async (event, content: string, expectedPath?: string, tabId?: number) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const tab = getTab(win, tabId)
  if (!tab) return null
  const sourcePath = tab.filePath
  if (expectedPath && sourcePath !== expectedPath) return null
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestSavePath(win, suggestFileName(win, content)),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  const ok = await saveToPath(win, tab, result.filePath, content, sourcePath, true)
  return ok ? result.filePath : null
})

ipcMain.handle('export-docx', async (event, content: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof content !== 'string') return false
  win.show()
  win.focus()
  const baseName = suggestFileName(win, content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestSavePath(win, `${baseName}.docx`),
    filters: [{ name: 'Word Document', extensions: ['docx'] }]
  })
  if (result.canceled || !result.filePath) return false
  try {
    const { markdownToDocx } = await import('./docx-export')
    await writeFile(result.filePath, await markdownToDocx({ content, sourcePath: activeTabOf(getState(win))?.filePath ?? null }))
    shell.showItemInFolder(result.filePath)
    return true
  } catch (error) {
    console.error('Word export failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['好'],
      message: '无法导出 Word 文档',
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
    defaultPath: suggestSavePath(win, `${baseName}-${suffix}.png`),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  })
  if (result.canceled || !result.filePath) return false
  try {
    const { renderDocumentPNGs } = await import('./image-export')
    const pages = await renderDocumentPNGs({ html, styles, bodyClass, background }, preset)
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
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
        message: '部分图片已存在',
        detail: `将替换 ${conflicts.length} 张同名图片。`,
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
      buttons: ['好'],
      message: '无法导出图片',
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
})

ipcMain.handle('export-pdf', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestSavePath(win, suggestFileName(win)),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    const background = await win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor') as string
    const cssKey = await win.webContents.insertCSS(
      `@media print {
        @page { margin: 0; }
        html, body, #editor { height: auto !important; overflow: visible !important; background: ${background} !important; }
        #editor { margin-left: 0 !important; padding: 20mm !important; }
        #editor .ProseMirror { min-height: auto !important; }
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
  }
})

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
  styles: string
  bodyClass: string
}) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const baseName = suggestFileName(win, snapshot.content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestSavePath(win, `${baseName}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return false

  const title = escapeHTML(baseName)
  const bodyClass = escapeHTML(snapshot.bodyClass)
  const renderedContent = snapshot.html || `<pre>${escapeHTML(snapshot.content)}</pre>`
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
    #editor { height: auto !important; min-height: 100vh; overflow: visible !important; padding: 40px !important; }
  </style>
</head>
<body class="${bodyClass}">
  <div id="editor"><div class="ProseMirror">${renderedContent}</div></div>
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
    createWindow(undefined, content, demoDir)
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
// autosave (renderer side) and ask the user which version survives. Conflicts
// only reach this dialog for the active tab; background tabs defer theirs
// until they are activated again.
ipcMain.handle('report-external-conflict', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) {
    event.sender.send('external-conflict-result', { action: 'keep' })
    return
  }
  const tab = activeTabOf(getState(win))
  const filePath = tab?.filePath ?? null
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['保留我的版本（继续编辑）', '加载磁盘上的版本（丢弃未保存的输入）'],
    defaultId: 0,
    cancelId: 0,
    message: '文件已被其他程序修改',
    detail: '你正在编辑的内容尚未保存，同时磁盘上的文件已被外部修改。请选择保留哪个版本。'
  })
  if (win.isDestroyed()) return
  if (choice.response === 1 && filePath && tab) {
    try {
      const data = await readFile(filePath, 'utf-8')
      tab.lastInternalSaveContent = data
      event.sender.send('external-conflict-result', { action: 'load', content: resolveImagePaths(data, filePath) })
      return
    } catch {
      // fall through to keep-mine when the file cannot be read
    }
  }
  event.sender.send('external-conflict-result', { action: 'keep' })
})

ipcMain.handle('report-theme', (_event, theme: unknown) => {
  const next = typeof theme === 'string' && theme ? theme : 'elegant'
  if (next === currentTheme) return
  currentTheme = next
  updateThemeMenuChecks()
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

// --- Tab lifecycle entry points (docs/tabs-tech-design.md D5) ---

function newTabInWindow(win: BrowserWindow): void {
  const tab = createTab(win)
  win.webContents.send('new-tab', tab.tabId)
}

function newTabInFocusedWindow(): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (win) newTabInWindow(win)
}

// Close the active tab; closing the last tab closes the window (macOS
// convention). Unsaved content is confirmed per tab, exactly like window close.
async function closeTabInWindow(win: BrowserWindow, tabId: number): Promise<void> {
  const state = getState(win)
  const tab = state.tabs.get(tabId)
  if (!tab) return
  if (state.tabs.size <= 1) {
    // Last tab: closing it means closing the window; the close handler owns
    // the confirmation flow.
    win.close()
    return
  }
  if (tab.dirty) {
    const ok = await confirmAndSaveTab(win, tab)
    if (!ok) return
  }
  const ordered = [...state.tabs.keys()].sort((a, b) => a - b)
  const index = ordered.indexOf(tabId)
  const remaining = ordered.filter((id) => id !== tabId)
  const activateTabId = remaining.length > 0 ? remaining[Math.min(Math.max(index, 0), remaining.length - 1)] : null
  stopWatching(tab)
  if (tab.debounceTimer) clearTimeout(tab.debounceTimer)
  state.tabs.delete(tabId)
  if (state.activeTabId === tabId && activateTabId !== null) state.activeTabId = activateTabId
  updateTitle(win)
  if (!win.isDestroyed()) win.webContents.send('tab-closed', { closedTabId: tabId, activateTabId })
}

function closeTabInFocusedWindow(): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return
  const state = getState(win)
  const active = activeTabOf(state)
  if (!active) return
  void closeTabInWindow(win, active.tabId)
}

// Batch close (close others / close to the right). Closing never funnels to
// window close here: the surviving tab keeps the window alive, and each dirty
// tab is confirmed before it goes away.
async function closeTabsInWindow(win: BrowserWindow, tabIds: number[]): Promise<void> {
  const state = getState(win)
  for (const tabId of tabIds) {
    const tab = state.tabs.get(tabId)
    if (!tab) continue
    if (tab.dirty && !await confirmAndSaveTab(win, tab)) return
    if (!state.tabs.has(tabId)) continue
    stopWatching(tab)
    if (tab.debounceTimer) clearTimeout(tab.debounceTimer)
    state.tabs.delete(tabId)
    if (!win.isDestroyed()) win.webContents.send('tab-closed', { closedTabId: tabId, activateTabId: null })
  }
  if (win.isDestroyed() || state.tabs.has(state.activeTabId)) {
    if (!win.isDestroyed()) updateTitle(win)
    return
  }
  const ordered = [...state.tabs.keys()].sort((a, b) => a - b)
  if (ordered.length === 0) return
  state.activeTabId = ordered[0]
  updateTitle(win)
  win.webContents.send('activate-tab', state.activeTabId)
}

function activateTabByIndexInFocusedWindow(index: number): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return
  const state = getState(win)
  const ordered = [...state.tabs.keys()].sort((a, b) => a - b)
  const tabId = ordered[index]
  if (tabId === undefined) return
  state.activeTabId = tabId
  win.webContents.send('activate-tab', tabId)
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
        file: '文件', edit: '编辑', view: '视图', theme: '主题', help: '帮助',
        newFile: '新建', newTab: '新建标签页', open: '打开...', save: '保存', saveAs: '另存为...',
        closeTab: '关闭标签页',
        recentOpen: '最近打开', restoreOnLaunch: '启动时打开上次文档', clearRecent: '清除最近记录',
        exportPDF: '导出 PDF...', exportHTML: '导出 HTML...', exportWord: '导出 Word...', exportImageDesktop: '导出图片（电脑阅读）...', exportImageMobile: '导出图片（手机阅读）...', find: '查找',
        setDefault: '设置为默认应用...',
        insertFormula: '插入公式', filePanel: '显示 / 隐藏文件列表', sourceMode: '切换 Markdown 源码',
        light: '浅色', dark: '深色', elegant: '雅致',
        sepia: '羊皮纸', notion: '简白', bear: '熊红', writer: '作家',
        solarizedDark: '夜航', nord: '极地', gruvbox: '暖木', dracula: '德古拉', midnight: '午夜',
        importTheme: '导入主题...', whatsNew: '新功能演示',
        cheatsheet: 'Markdown 语法', about: '关于 ColaMD', checkForUpdates: '检查更新...', updateAvailable: '发现新版本', close: '关闭窗口',
        undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
        actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '切换全屏',
        fontSettings: '编辑器字体…',
        language: '界面语言', chinese: '中文', english: 'English',
        hide: '隐藏 ColaMD', hideOthers: '隐藏其他应用', showAll: '显示全部', quit: '退出 ColaMD',
      }
    : {
        file: 'File', edit: 'Edit', view: 'View', theme: 'Theme', help: 'Help',
        newFile: 'New', newTab: 'New Tab', open: 'Open...', save: 'Save', saveAs: 'Save As...',
        closeTab: 'Close Tab',
        recentOpen: 'Open Recent', restoreOnLaunch: 'Reopen last document at launch', clearRecent: 'Clear Recent',
        exportPDF: 'Export PDF...', exportHTML: 'Export HTML...', exportWord: 'Export Word...', exportImageDesktop: 'Export Image (Desktop)...', exportImageMobile: 'Export Image (Mobile)...', find: 'Find',
        setDefault: 'Set as Default...',
        insertFormula: 'Insert Formula', filePanel: 'Show / Hide File List', sourceMode: 'Toggle Markdown Source',
        light: 'Light', dark: 'Dark', elegant: 'Elegant',
        sepia: 'Sepia', notion: 'Notion', bear: 'Bear', writer: 'Writer',
        solarizedDark: 'Solarized Dark', nord: 'Nord', gruvbox: 'Gruvbox', dracula: 'Dracula', midnight: 'Midnight',
        importTheme: 'Import Theme...', whatsNew: "What's New",
        cheatsheet: 'Markdown Syntax', about: 'About ColaMD', checkForUpdates: 'Check for Updates...', updateAvailable: 'Update Available', close: 'Close Window',
        undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
        actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
        fontSettings: 'Editor Font…',
        language: 'Language', chinese: '中文', english: 'English',
        hide: 'Hide ColaMD', hideOthers: 'Hide Others', showAll: 'Show All', quit: 'Quit ColaMD',
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
          label: labels.newTab,
          accelerator: 'CmdOrCtrl+T',
          click: () => newTabInFocusedWindow()
        },
        {
          // Not in design.md yet: offered for the maintainer's ruling in the
          // tabs PR, following the switcher prototype's ⌘1…5 precedent.
          label: preferredCheatsheetLanguage === 'zh' ? '切换标签页' : 'Switch Tab',
          submenu: Array.from({ length: 9 }, (_unused, i) => ({
            label: preferredCheatsheetLanguage === 'zh' ? `标签页 ${i + 1}` : `Tab ${i + 1}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: () => activateTabByIndexInFocusedWindow(i)
          }))
        },
        {
          label: labels.open,
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu-open')
        },
        {
          ...(process.platform === 'darwin'
            ? {
                role: 'recentDocuments' as const,
                submenu: [{ role: 'clearRecentDocuments' as const }]
              }
            : {
                label: labels.recentOpen,
                submenu: [
                  ...recentStore.recent.filter((p) => existsSync(p)).slice(0, 10).map((p, index) => ({
                    label: `${index + 1}. ${basename(p)}`,
                    click: () => openFile(p)
                  }))
                ]
              })
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
        // ⌘W closes the active tab and only closes the window with the last
        // tab (macOS convention, design.md); role:'close' would skip the
        // per-tab confirmation.
        { label: labels.closeTab, accelerator: 'CmdOrCtrl+W', click: () => closeTabInFocusedWindow() },
        ...(isMac ? [] : [{ label: labels.quit, role: 'quit' as const }])
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
          label: labels.insertFormula,
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendToFocused('editor:math')
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
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => sendToFocused('toggle-file-panel')
        },
        {
          label: labels.sourceMode,
          accelerator: 'CmdOrCtrl+/',
          click: () => sendToFocused('toggle-source-mode')
        },
        { type: 'separator' },
        { label: labels.fontSettings, click: () => sendToFocused('open-font-settings') },
        {
          label: labels.language,
          submenu: [
            { label: labels.chinese, type: 'checkbox' as const, checked: getPreferredLanguage() === 'zh', click: () => setPreferredLanguage('zh') },
            { label: labels.english, type: 'checkbox' as const, checked: getPreferredLanguage() === 'en', click: () => setPreferredLanguage('en') }
          ]
        },
        { type: 'separator' },
        { label: labels.fullscreen, role: 'togglefullscreen' }
      ]
    },
    {
      label: labels.theme,
      submenu: themeSubmenu
    },
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
  themeMenuItems = [
    ...themeSubmenu.filter((item): item is Electron.MenuItemConstructorOptions & { id: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, theme: themeIdByLabel.get(item.label ?? '') ?? (item.id.startsWith('theme-custom-') ? `custom:${String(item.label)}.css` : '') })),
  ]
}

function updateThemeMenuChecks(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const entry of themeMenuItems) {
    const item = menu.getMenuItemById(entry.id)
    if (item) item.checked = entry.theme === currentTheme
  }
}

// --- Auto update (weak, non-blocking) ---
let manualUpdateCheck = false
let updateDownloadRequested = false

function showUpdateMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = getFocusedWindow()
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
}

async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) return
  manualUpdateCheck = manual
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
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
}

ipcMain.handle('download-update', async () => {
  updateDownloadRequested = true
  await autoUpdater.downloadUpdate()
})

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true)
})

// App lifecycle

app.whenReady().then(() => {
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
    for (const fp of pendingFilePaths) {
      createWindow(fp)
    }
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

// Ask one specific renderer for an atomic per-tab dirty/content snapshot.
// A timeout is a failed request, never a signal that the document is clean.
function requestDocumentState(win: BrowserWindow): Promise<TabDocState[] | null> {
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
  const { tabs } = snapshot as { tabs?: unknown }
  if (!Array.isArray(tabs)) return
  const parsed: TabDocState[] = []
  for (const entry of tabs) {
    if (!entry || typeof entry !== 'object') continue
    const { tabId, path, dirty, content } = entry as TabDocState
    if (typeof tabId !== 'number' || (path !== null && typeof path !== 'string')) continue
    if (typeof dirty !== 'boolean') continue
    parsed.push({ tabId, path, dirty, content: typeof content === 'string' ? content : undefined })
  }
  const pending = pendingDocumentStateRequests.get(requestId)
  if (!pending || pending.webContentsId !== event.sender.id) return
  pendingDocumentStateRequests.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve(parsed)
})

ipcMain.on('renderer-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) getState(win).rendererReady = true
  markStartup('renderer-ready')
  writeStartupTrace()
  // Optional switch-latency / heap benchmark (COLAMD_TAB_BENCH=1): run once
  // against the first ready window and record the numbers.
  if (process.env.COLAMD_TAB_BENCH === '1' && win && !win.isDestroyed()) {
    win.webContents.send('run-tab-bench')
  }
})

ipcMain.handle('tab-bench-result', async (_event, result: unknown) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...(result as Record<string, unknown>) })
  console.info(`[tab-bench] ${line}`)
  await appendFile(join(app.getPath('userData'), 'tab-bench.jsonl'), `${line}\n`).catch(() => {})
})

// Renderer reports its unsaved state as a fast path for quit coordination.
ipcMain.on('set-dirty', (event, isDirty: boolean, tabId?: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const tab = getTab(win, tabId)
  if (tab) tab.dirty = !!isDirty
})

// Renderer created the session for a tab the main process spun up; it reports
// back which tab is now active so save routing and titles stay correct.
ipcMain.on('active-tab-changed', (event, tabId: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || typeof tabId !== 'number') return
  const state = getState(win)
  if (!state.tabs.has(tabId)) return
  state.activeTabId = tabId
  updateTitle(win)
})

// Main spins up a blank tab (⌘T or the titlebar plus button).
ipcMain.handle('new-tab', (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const tab = createTab(win)
  win.webContents.send('new-tab', tab.tabId)
  return tab.tabId
})

ipcMain.handle('close-tab', (event, tabId: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof tabId !== 'number') return
  void closeTabInWindow(win, tabId)
})

// design.md tab context menu: 关闭 / 关闭其他 / 关闭右侧 / 复制路径 /
// 在文件管理器中显示, as a native popup.
ipcMain.handle('tab-context-menu', (event, tabId: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof tabId !== 'number') return
  const state = getState(win)
  const tab = state.tabs.get(tabId)
  if (!tab) return
  const zh = getPreferredLanguage() === 'zh'
  const manager = fileManagerName()
  const ordered = [...state.tabs.keys()].sort((a, b) => a - b)
  const index = ordered.indexOf(tabId)
  const others = ordered.filter((id) => id !== tabId)
  const right = ordered.slice(index + 1)
  const hasPath = tab.filePath !== null
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: zh ? '关闭' : 'Close', click: () => { void closeTabInWindow(win, tabId) } },
    { label: zh ? '关闭其他' : 'Close Others', enabled: others.length > 0, click: () => { void closeTabsInWindow(win, others) } },
    { label: zh ? '关闭右侧' : 'Close to the Right', enabled: right.length > 0, click: () => { void closeTabsInWindow(win, right) } },
    { type: 'separator' },
    { label: zh ? '复制路径' : 'Copy Path', enabled: hasPath, click: () => { if (tab.filePath) clipboard.writeText(tab.filePath) } },
    {
      label: manager === 'explorer' ? (zh ? '在资源管理器中显示' : 'Reveal in File Explorer') : (zh ? '在 Finder 中显示' : 'Reveal in Finder'),
      enabled: hasPath,
      click: () => { if (tab.filePath) shell.showItemInFolder(tab.filePath) }
    }
  ]
  Menu.buildFromTemplate(items).popup({ window: win })
})

// The ··· overflow listing: every open document in one native menu, the
// active one checked (temporary-document-switcher-design.md: no horizontal
// scrolling, a small list instead).
ipcMain.handle('tab-overflow-menu', (event) => {
  const win = getWinFromEvent(event)
  if (!win) return
  const state = getState(win)
  const zh = getPreferredLanguage() === 'zh'
  const ordered = [...state.tabs.values()].sort((a, b) => a.tabId - b.tabId)
  if (ordered.length === 0) return
  const items: Electron.MenuItemConstructorOptions[] = ordered.map((tab) => ({
    label: tab.filePath ? basename(tab.filePath) : (zh ? '未命名' : 'Untitled'),
    type: 'checkbox' as const,
    checked: tab.tabId === state.activeTabId,
    click: () => {
      state.activeTabId = tab.tabId
      if (!win.isDestroyed()) win.webContents.send('activate-tab', tab.tabId)
    }
  }))
  Menu.buildFromTemplate(items).popup({ window: win })
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
  if (!state.rendererReady && !hasDirtyTabs(state)) return true

  const tabsState = await requestDocumentState(win)
  if (!tabsState) {
    // Renderer is unresponsive: it cannot report state or save anything, so
    // blocking forever would trap the user. Offer an explicit escape instead.
    if (!hasDirtyTabs(state)) return true
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['仍要关闭', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '无法与编辑窗口通信',
      detail: '窗口可能已停止响应，无法确认是否有未保存的修改。强行关闭可能丢失内容。'
    })
    return response === 0
  }
  // The renderer's report is authoritative for dirtiness.
  for (const entry of tabsState) {
    const tab = state.tabs.get(entry.tabId)
    if (tab) tab.dirty = entry.dirty
  }
  const dirtyTabs = [...state.tabs.values()].filter((tab) => tab.dirty)
  for (const tab of dirtyTabs) {
    const entry = tabsState.find((candidate) => candidate.tabId === tab.tabId)
    const ok = await confirmAndSaveTab(win, tab, entry?.content ?? '')
    if (!ok) return false
  }
  return true
}

// Confirm one dirty tab before it goes away (window close or tab close or a
// file loading over it). Returns true only after a verified save, an explicit
// discard, or when the tab turned out to be clean.
async function confirmAndSaveTab(win: BrowserWindow, tab: TabState, content?: string): Promise<boolean> {
  if (content === undefined) {
    const tabsState = await requestDocumentState(win)
    content = tabsState?.find((entry) => entry.tabId === tab.tabId)?.content ?? ''
  }
  const detail = tab.filePath
    ? `“${basename(tab.filePath)}” 有未保存的修改。`
    : '当前未命名文档有未保存的修改。'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    message: '未保存的修改',
    detail
  })
  if (response === 2) return false
  if (response === 1) {
    tab.dirty = false
    return true
  }

  const sourcePath = tab.filePath
  let filePath = sourcePath
  if (!filePath) {
    const saveAs = await dialog.showSaveDialog(win, {
      defaultPath: suggestSavePath(win, suggestFileName(win, content)),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (saveAs.canceled || !saveAs.filePath) return false
    filePath = saveAs.filePath
  }

  const saved = await saveToPath(win, tab, filePath, content, sourcePath, true)
  if (!saved) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['好'],
      message: '无法保存文档',
      detail: '为保护未保存的内容，已取消关闭。请检查文件权限和可用磁盘空间。'
    })
    return false
  }
  tab.dirty = false
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
