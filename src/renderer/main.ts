import { createEditor, flashHeadingOnArrival, getMarkdown, onEditorJumpPhase, setMarkdown, showMathModal, setMathModalLanguage, releaseMermaidRenderer, getEditorState, restoreEditorState, applyMarkdownStyle, runFormatCommand, type FormatCommandId } from './editor/editor'
import { detectMarkdownStyle } from './editor/markdown-style'
import { SearchPanel } from './editor/search-panel'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
import { setUiLanguage, isChinese, type UiLanguage } from './ui-language'
import { applyEditorFont, loadSavedEditorFont, showFontSettingsModal } from './editor/font-settings'
import './themes/base.css'
import './themes/premium.css'

let sourceModeActive = false
const editorEl = () => document.getElementById('editor') as HTMLElement
const sourceEl = () => document.getElementById('source-editor') as HTMLTextAreaElement
const filePanelEl = () => document.getElementById('file-panel') as HTMLElement
const fileListEl = () => document.getElementById('file-list') as HTMLElement
const outlineListEl = () => document.getElementById('outline-list') as HTMLElement
const fileTabEl = () => document.getElementById('file-panel-files') as HTMLButtonElement
const outlineTabEl = () => document.getElementById('file-panel-outline') as HTMLButtonElement
const fileToggleBtnEl = () => document.getElementById('file-toggle-btn') as HTMLButtonElement
const sourceToggleBtnEl = () => document.getElementById('source-toggle-btn') as HTMLButtonElement
const wordCountEl = () => document.getElementById('word-count') as HTMLElement
const saveStatusEl = () => document.getElementById('save-status') as HTMLElement
const updateBannerEl = () => document.getElementById('update-banner') as HTMLElement
const updateBannerTextEl = () => document.getElementById('update-banner-text') as HTMLElement
const updateBannerActionEl = () => document.getElementById('update-banner-action') as HTMLButtonElement

// --- Same-directory file panel ---
let currentFilePath: string | null = null
let fileManagerName: import('../preload/index').FileManagerName = 'file-manager'
let dirty = false
// Programmatic Markdown replacement dispatches a synchronous ProseMirror
// transaction. Suppress only that transaction, never a time window of input.
let applyingProgrammaticChange = false
// The editor emits updates while it is being built: the initial document plus
// the trailing paragraph it inserts. Those are not user edits, so a document
// must not start out dirty, or closing an untouched new window would ask to
// save it.
let editorReady = false
// Fresh installs start focused on the document. Once changed, the user's
// explicit panel preference is preserved.
let manualHidden = localStorage.getItem('file-panel-hidden') !== '0'
let panelMode: 'files' | 'outline' = 'files'
let outlineUpdateQueued = false
// Outline doubles as a reading-progress view (#64): the entry for the section
// currently at the top of the viewport is highlighted and kept visible.
// outlineItems only caches source-mode line numbers; visual mode re-queries
// the live DOM at use time because Milkdown recreates heading nodes whenever
// the content is re-set, which silently detaches cached element references.
let outlineItems: OutlineItem[] = []
let outlineActiveIndex = -1
let outlineSyncQueued = false
// While an outline click drives a smooth scroll, scrollspy updates are paused
// so the in-flight scroll events cannot overwrite the clicked entry; the lock
// is released on `scrollend` or by a fallback timer when no scroll happens.
let outlineJumping = false
let outlineJumpTimer: ReturnType<typeof setTimeout> | null = null
let outlineJumpStartTop = 0

// Resizable file panel: default 220px, drag range 203-420px, persisted
// locally (design.md: light, no permanent handle, hover feedback only).
// Applied at module load so the first paint already uses the saved width.
// The floor is what keeps the two left edges agreeing: the row's three 28px
// controls with their 8px steps end at 202, the strip starts on that line, so
// a narrower panel would leave its right edge to the left of the strip and the
// tab would visibly hang past the panel (2026-09-15).
const FILE_PANEL_MIN_WIDTH = 203
const FILE_PANEL_MAX_WIDTH = 420
const FILE_PANEL_DEFAULT_WIDTH = 220

function clampFilePanelWidth(width: number): number {
  return Math.min(FILE_PANEL_MAX_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, Math.round(width)))
}

function applyFilePanelWidth(width: number): void {
  document.documentElement.style.setProperty('--file-panel-width', `${width}px`)
}

applyFilePanelWidth(clampFilePanelWidth(Number.parseInt(localStorage.getItem('file-panel-width') ?? '', 10) || FILE_PANEL_DEFAULT_WIDTH))

function setMarkdownProgrammatically(content: string, flushHistory = false): void {
  applyingProgrammaticChange = true
  try {
    setMarkdown(content, flushHistory)
  } finally {
    applyingProgrammaticChange = false
  }
}

// --- Unsaved-state tracking + auto-save ---
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let documentRevision = 0
let saveQueue: Promise<void> = Promise.resolve()

function reportDirty(): void {
  window.electronAPI.reportDirty(dirty)
}

// --- Save status hint (#49) ---
let saveStatusTimer: ReturnType<typeof setTimeout> | null = null
// True while an external-modification conflict waits for the user's choice;
// autosave stays paused so it cannot silently overwrite the external edit.
let externalConflictPending = false

function showSaveStatus(state: 'dirty' | 'saved'): void {
  const el = saveStatusEl()
  if (!el) return
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  // The dirty hint is gone: the active tab shows a dot for it, and a label in
  // the row was one signal too many. The element stays for the messages that
  // need words, such as an external edit waiting on the user's choice.
  if (state === 'dirty') {
    el.classList.remove('pending')
    el.textContent = ''
  } else {
    el.classList.remove('pending')
    saveStatusTimer = setTimeout(() => {
      el.textContent = ''
    }, 600)
  }
}

function clearSaveStatus(): void {
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  const el = saveStatusEl()
  if (el) {
    el.classList.remove('pending', 'saved')
    el.textContent = ''
  }
}

// An external edit landing while the user still has unsaved changes must never
// clobber the editor, and plain autosave would silently overwrite the external
// edit. Pause autosave and let the user choose explicitly.
function raiseExternalConflict(): void {
  if (externalConflictPending) return
  externalConflictPending = true
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  const el = saveStatusEl()
  if (el) {
    if (saveStatusTimer) {
      clearTimeout(saveStatusTimer)
      saveStatusTimer = null
    }
    el.textContent = isChinese() ? '文件已被外部修改' : 'File changed externally'
    el.classList.remove('saved')
    el.classList.add('pending')
  }
  window.electronAPI.reportExternalConflict?.()
}

// --- Tabs (design.md) ---
// Tabs are created by the user (the + button or ⌘T) and never appear on their own.
// The module-level document state above always describes the ACTIVE tab, so every
// existing path (save, autosave, external conflict, outline, source mode) keeps
// working unchanged. Background tabs keep a snapshot of their own state, which
// makes switching a capture/restore pair instead of a second document machine.
interface DocumentTab {
  id: string
  filePath: string | null
  dirty: boolean
  revision: number
  sourceMode: boolean
  sourceText: string
  content: string
  editorState: import('@milkdown/kit/prose/state').EditorState | null
  diskContent: string | null
  scrollTop: number
}

const tabs: DocumentTab[] = []
let activeTabId: string | null = null
let nextTabId = 1
let switchingTab = false

const tabBarEl = () => document.getElementById('tab-bar') as HTMLElement

function activeTab(): DocumentTab | null {
  return tabs.find((tab) => tab.id === activeTabId) ?? null
}

// The label for a document that has no path yet, in the current UI language.
let untitledName = 'Untitled'

function untitledLabel(): string {
  return untitledName
}

// The tab carries the document's name, not its file name. `.md` on every tab is
// noise in a strip that hugs its label, and it lands right where the ellipsis
// cuts — `解读.…` reads as four dots. Mirrors the panel's markdown filter.
const DOCUMENT_SUFFIX = /\.(md|markdown|mdown|mkd)$/i

function tabLabel(tab: DocumentTab): string {
  if (!tab.filePath) return untitledLabel()
  const name = tab.filePath.split(/[\\/]/).pop() || tab.filePath
  return name.replace(DOCUMENT_SUFFIX, '')
}

// Read the live state back into the active tab's record. Called before every
// switch, close and bar render, so the records and the screen cannot disagree.
function captureActiveTab(): void {
  const tab = activeTab()
  if (!tab) return
  // The path is the tab's identity and only changes where a document is really
  // opened or saved; deriving it here would let a stray render rename a tab.
  tab.dirty = dirty
  tab.revision = documentRevision
  tab.sourceMode = sourceModeActive
  tab.content = getContent()
  if (sourceModeActive) {
    tab.sourceText = sourceEl().value
    tab.scrollTop = sourceEl().scrollTop
  } else {
    tab.editorState = getEditorState()
    tab.scrollTop = editorEl().scrollTop
  }
}

// The bar only carries the unsaved mark that the tab already owns; the title bar
// keeps the primary save hint.
function markActiveTabDirty(): void {
  const tab = activeTab()
  if (!tab) return
  tab.dirty = dirty
  const entry = tabBarEl().querySelector(`.tab-entry[data-tab-id="${tab.id}"]`)
  entry?.classList.toggle('dirty', dirty)
}

// --- The floating label ---
// ONE fixed layer for every name the shell has to shorten: a tab (where it also
// carries ⌘W) and a file-panel row. Neither the strip nor the panel can host it
// — both clip their own overflow — so the renderer positions it.
// A tab waits longer: hovering a tab is usually a prelude to clicking it, and a
// label that jumps out immediately is noise. A row is different — the name is
// what was asked for, so it answers sooner.
const TAB_TIP_DELAY = 1000
const ROW_TIP_DELAY = 450

let tipTimer: ReturnType<typeof setTimeout> | undefined

function showTip(anchor: HTMLElement, text: string, side: 'below' | 'right'): void {
  const tip = document.getElementById('hover-tip') as HTMLElement | null
  if (!tip) return
  tip.textContent = text
  tip.hidden = false
  const rect = anchor.getBoundingClientRect()
  const width = tip.offsetWidth
  if (side === 'right') {
    // Beside the panel and level with the row: the label describes the list, so
    // it must not cover it.
    const height = tip.offsetHeight
    tip.style.left = `${Math.round(Math.min(rect.right + 8, window.innerWidth - width - 8))}px`
    tip.style.top = `${Math.round(Math.min(Math.max(8, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 8))}px`
    return
  }
  tip.style.left = `${Math.round(Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8))}px`
  tip.style.top = `${Math.round(rect.bottom + 7)}px`
}

function scheduleTip(anchor: HTMLElement, text: string, side: 'below' | 'right', delay: number): void {
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => showTip(anchor, text, side), delay)
}

function hideTip(): void {
  clearTimeout(tipTimer)
  const tip = document.getElementById('hover-tip') as HTMLElement | null
  if (tip) tip.hidden = true
}

// A tab whose name fits says nothing but the shortcut; only a truncated name is
// worth spelling out. The full path never appears on hover: it was the system
// tooltip, and it reads as an accident.
function tabTipText(entry: HTMLElement): string {
  const shortcut = '⌘W'
  const name = entry.querySelector('.tab-entry-name') as HTMLElement | null
  const full = entry.dataset.fullName ?? ''
  if (!name || !full) return shortcut
  return name.scrollWidth > name.clientWidth + 1 ? `${full} · ${shortcut}` : shortcut
}

function hideTabTip(): void {
  hideTip()
}
function closeGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '9')
  svg.setAttribute('height', '9')
  svg.setAttribute('viewBox', '0 0 9 9')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  for (const [x1, y1, x2, y2] of [['1.6', '1.6', '7.4', '7.4'], ['7.4', '1.6', '1.6', '7.4']]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    svg.append(line)
  }
  return svg
}

// Same plus as the title bar button, at the tab strip's scale.

// The plus at the strip's scale, same shape as the icons in the title bar.
function plusGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  for (const [x1, y1, x2, y2] of [['8', '3.1', '8', '12.9'], ['3.1', '8', '12.9', '8']]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    svg.append(line)
  }
  return svg
}

function renderTabBar(): void {
  captureActiveTab()
  const bar = tabBarEl()
  // The strip is always there: with the layout collapsed into the title bar's
  // row it costs no extra height, and one shape for the chrome beats a title bar
  // that changes personality when a second document appears.
  bar.hidden = false
  // The strip lives inside the title bar's row now, so it consumes no height of
  // its own: the editor starts right under the same 40px row either way.
  document.documentElement.style.setProperty('--tab-bar-height', '0px')
  document.documentElement.style.setProperty('--editor-top-gap', '0px')
  bar.innerHTML = ''
  // Hide the hover hint unconditionally, including the path where the whole
  // strip disappears (one tab left): a pending timer would otherwise pop "⌘W"
  // for a tab that no longer exists, and a visible hint would never leave —
  // the strip it belongs to is gone, so no mouseleave can fire (#90).
  hideTabTip()
  for (const tab of tabs) {
    const entry = document.createElement('div')
    entry.className = 'tab-entry'
    entry.dataset.tabId = tab.id
    entry.setAttribute('role', 'tab')
    entry.dataset.fullName = tabLabel(tab)
    if (tab.id === activeTabId) {
      entry.classList.add('active')
      entry.setAttribute('aria-selected', 'true')
    }
    if (tab.dirty) entry.classList.add('dirty')
    const name = document.createElement('span')
    name.className = 'tab-entry-name'
    name.textContent = tabLabel(tab)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tab-entry-close'
    close.setAttribute('aria-label', isChinese() ? '关闭标签页' : 'Close tab')
    close.append(closeGlyph())
    entry.append(name, close)
    bar.append(entry)
  }
  // The plus belongs to the strip: it shows up with the strip and goes away with
  // it, instead of appearing and vanishing in the title bar.
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'tab-new-btn'
  add.setAttribute('aria-label', isChinese() ? '新建标签页' : 'New tab')
  add.append(plusGlyph())
  bar.append(add)
  const active = bar.querySelector('.tab-entry.active')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  // Let the main process know which files this window holds in tabs, so opening
  // an already open document can focus that tab instead of duplicating it.
  window.electronAPI.setTabFiles(tabs.map((tab) => tab.filePath).filter((path): path is string => !!path))
}

function showBlankDocument(): void {
  releaseMermaidRenderer()
  exitSourceMode()
  applyingProgrammaticChange = true
  try {
    setMarkdown('', true)
  } finally {
    applyingProgrammaticChange = false
  }
  updateWordCount('')
  resetDirty()
  updateFileTitle()
  updatePanelVisibility()
  void refreshSiblings()
  scheduleOutlineUpdate()
  editorEl().scrollTop = 0
  sourceEl().scrollTop = 0
}

// Switching away must not lose work. A tab with a path is flushed through the
// usual queue (same rule the file panel already followed); an untitled tab keeps
// its content in its own record and is only decided on when it would really be
// dropped (closing the tab, or closing the window).
async function saveTabForLeaving(tab: DocumentTab | null): Promise<boolean> {
  if (!tab || !tab.dirty || !tab.filePath) return true
  return await saveCurrent()
}

// The window always holds at least one document, so the strip never shows a
// lone plus next to a welcome screen that belongs to no tab: a launch with no
// file seeds the first tab here, and a file that arrives later adopts it.
function ensureTab(): DocumentTab {
  const existing = activeTab()
  if (existing) return existing
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    filePath: null,
    dirty: false,
    revision: documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  return tab
}

async function openNewTab(): Promise<void> {
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    filePath: null,
    dirty: false,
    revision: ++documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  // Tell the main process the window is now on an untitled document, otherwise
  // its notion of the active file still points at the previous tab's file.
  await window.electronAPI.activateFile(null)
  showBlankDocument()
  renderTabBar()
}

async function activateTab(id: string): Promise<void> {
  if (switchingTab || id === activeTabId) return
  const target = tabs.find((tab) => tab.id === id)
  if (!target) return
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  switchingTab = true
  try {
    // Point the window at the incoming document first: this re-points the file
    // watcher, the title and the recent list, and reports whether the file
    // changed while this tab sat in the background. An untitled tab passes null
    // so the window stops pointing at the tab we are leaving.
    const disk = await window.electronAPI.activateFile(target.filePath)
    // This document may have been written in a different style than the one we
    // are leaving; restore its own serialiser style with its content.
    applyMarkdownStyle(detectMarkdownStyle(target.content))
    activeTabId = target.id
    currentFilePath = target.filePath
    documentRevision = target.revision
    dirty = false
    externalConflictPending = false
    const changedOnDisk = !!disk && target.diskContent !== null && disk.content !== target.diskContent
    if (changedOnDisk && !target.dirty) {
      target.diskContent = disk!.content
      setContent(disk!.content, true)
      clearDirty()
      clearSaveStatus()
    } else if (target.sourceMode) {
      enterSourceMode(target.sourceText, 0)
    } else if (target.editorState) {
      exitSourceMode()
      // Swapping in the tab's own editor state is not a user edit. Without this
      // guard the listener fires, the tab flips to 「已编辑」, and an autosave
      // rewrites the file the user never touched.
      applyingProgrammaticChange = true
      try {
        restoreEditorState(target.editorState)
      } finally {
        applyingProgrammaticChange = false
      }
    }
    // The tab's own unsaved state decides, never the swap itself.
    dirty = target.dirty
    reportDirty()
    if (dirty) {
      showSaveStatus('dirty')
      if (!changedOnDisk) scheduleAutosave()
    } else {
      clearSaveStatus()
    }
    updateWordCount()
    updateFileTitle()
    updatePanelVisibility()
    void refreshSiblings()
    scheduleOutlineUpdate()
    const restoreScroll = (): void => {
      if (target.sourceMode) sourceEl().scrollTop = target.scrollTop
      else editorEl().scrollTop = target.scrollTop
    }
    restoreScroll()
    requestAnimationFrame(restoreScroll)
    renderTabBar()
    if (changedOnDisk && target.dirty) raiseExternalConflict()
  } finally {
    switchingTab = false
  }
}

async function closeTab(id: string): Promise<void> {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const tab = tabs[index]
  if (tab.id === activeTabId) {
    captureActiveTab()
    if (!await saveTabForLeaving(tab)) return
    if (tab.dirty && !tab.filePath && !confirmDiscardUntitled()) return
  } else if (tab.dirty) {
    // A background tab is not the active document, so it is written straight to
    // its own path; an untitled one cannot be written without a dialog.
    if (tab.filePath) {
      const saved = await window.electronAPI.saveFile(tab.content, tab.filePath, false, false)
      if (!saved) return
      tab.dirty = false
    } else if (!confirmDiscardUntitled()) {
      return
    }
  }
  tabs.splice(index, 1)
  if (tabs.length === 0) {
    // The last tab closed: the window falls back to a single blank document and
    // the bar disappears with it.
    activeTabId = null
    await openNewTab()
    return
  }
  if (tab.id === activeTabId) {
    activeTabId = null
    await activateTab(tabs[Math.min(index, tabs.length - 1)].id)
  }
  renderTabBar()
}

// An untitled tab has nowhere to go on disk, so closing it asks first.
function confirmDiscardUntitled(): boolean {
  return window.confirm(isChinese()
    ? '这个标签页还没有保存，关闭会丢掉里面的内容。'
    : 'This tab has unsaved content. Close it anyway?')
}

// Open a file in a tab of its own. Reuses a blank current tab, and never opens
// the same file twice: an already open document just gets focused.
async function openFileInNewTab(path: string): Promise<void> {
  const existing = tabs.find((tab) => tab.filePath === path)
  if (existing) {
    await activateTab(existing.id)
    return
  }
  const current = activeTab()
  if (current && !current.filePath && !current.dirty) {
    await window.electronAPI.openSibling(path)
    return
  }
  await openNewTab()
  // Claim the path before the 'file-opened' round-trip lands: a burst of
  // queued tab-opens would otherwise see this tab as still blank and reuse it
  // for the next file, overwriting the one just opened (#99).
  const claimed = activeTab()
  if (claimed) claimed.filePath = path
  await window.electronAPI.openSibling(path)
}

// Closing several tabs runs one at a time: each close may need its own unsaved
// confirmation, and a cancelled one stops the rest.
async function closeTabsMatching(keep: (index: number) => boolean): Promise<void> {
  for (;;) {
    const index = tabs.findIndex((_tab, i) => keep(i))
    if (index < 0) return
    const before = tabs.length
    await closeTab(tabs[index].id)
    if (tabs.length === before) return
  }
}

function bindTabBar(api: import('../preload/index').ElectronAPI): void {
  // Tab-opens are serialized: each request awaits main (activateFile,
  // file-opened) before the next runs. Without this, a burst of queued opens
  // (multi-file launch, fast second-instance) interleaves and two documents
  // land in one tab (#99).
  let tabOpenQueue: Promise<void> = Promise.resolve()
  const enqueueTabOpen = (path: string): void => {
    tabOpenQueue = tabOpenQueue.then(() => openFileInNewTab(path)).catch(() => { /* next file still opens */ })
  }
  // Tabs are also created from the File menu / ⌘T and from the file list; the
  // strip's own plus is bound above, in renderTabBar.
  api.onMenuNewTab(() => { void openNewTab() })
  api.onMenuCloseTab(() => { if (activeTabId) void closeTab(activeTabId) })
  api.onOpenInNewTab(enqueueTabOpen)
  const handleTabMenuAction = ({ action, tabId }: { action: string; tabId: string }) => {
    if (action === 'close') { void closeTab(tabId); return }
    if (action === 'close-others') { void closeTabsMatching((i) => tabs[i].id !== tabId); return }
    if (action === 'close-right') {
      void closeTabsMatching((i) => i > tabs.findIndex((tab) => tab.id === tabId))
    }
  }
  api.onTabMenuAction(handleTabMenuAction)
  // Chromium re-dispatches hover events after the DOM under the pointer changes,
  // with the same coordinates. Closing a tab rebuilds the strip, so the hint used
  // to re-arm itself under a pointer that never moved and looked like it refused
  // to go away (#90). A real hover always comes with new coordinates.
  let lastHoverPoint = ''
  tabBarEl().addEventListener('mouseover', (e) => {
    const point = `${e.clientX},${e.clientY}`
    if (point === lastHoverPoint) return
    lastHoverPoint = point
    const target = e.target as HTMLElement
    const entry = target.closest('.tab-entry') as HTMLElement | null
    if (entry) scheduleTip(entry, tabTipText(entry), 'below', TAB_TIP_DELAY)
    else if (target.closest('.tab-new-btn')) scheduleTip(target.closest('.tab-new-btn') as HTMLElement, isChinese() ? '新建标签页 · ⌘T' : 'New tab · ⌘T', 'below', TAB_TIP_DELAY)
    else hideTabTip()
  })
  tabBarEl().addEventListener('mouseleave', () => {
    // Leaving clears the gate: coming back to the same pixel is a real hover.
    lastHoverPoint = ''
    hideTabTip()
  })
  tabBarEl().addEventListener('contextmenu', (e) => {
    const entry = (e.target as HTMLElement).closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    e.preventDefault()
    void api.showTabContextMenu({
      tabId: id,
      filePath: tabs[index].filePath,
      canCloseOthers: tabs.length > 1,
      canCloseRight: index < tabs.length - 1
    })
  })
  api.onFocusFile((path) => {
    const tab = tabs.find((candidate) => candidate.filePath === path)
    if (tab) void activateTab(tab.id)
  })
  tabBarEl().addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('.tab-new-btn')) {
      void openNewTab()
      return
    }
    const entry = target.closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    if (target.closest('.tab-entry-close')) {
      void closeTab(id)
      return
    }
    void activateTab(id)
  })
  // Middle click closes, the browser convention; the bar stays free of a
  // permanent close affordance (design.md).
  tabBarEl().addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const entry = (e.target as HTMLElement).closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    e.preventDefault()
    void closeTab(id)
  })
}

// Keep the active tab's record in step with a successful write, so switching
// back to it later can tell whether the file changed underneath us.
function noteTabSaved(content: string): void {
  const tab = activeTab()
  if (!tab) return
  tab.diskContent = content
  tab.filePath = currentFilePath
  tab.dirty = dirty
}

function setDirty(): void {
  documentRevision += 1
  dirty = true
  reportDirty()
  showSaveStatus('dirty')
  markActiveTabDirty()
  scheduleAutosave()
}

function clearDirty(): void {
  dirty = false
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  reportDirty()
  markActiveTabDirty()
}

// Invalidate any in-flight save captured from the previous document before
// replacing editor content from disk.
function resetDirty(): void {
  documentRevision += 1
  clearDirty()
  clearSaveStatus()
}

function enqueueSave(operation: () => Promise<string | null>): Promise<string | null> {
  const next = saveQueue.then(operation, operation)
  saveQueue = next.then(() => undefined, () => undefined)
  return next
}

function scheduleAutosave(): void {
  if (!currentFilePath) return
  // Paused while an external-modification conflict is unresolved: the user
  // must decide between their version and the disk version first.
  if (externalConflictPending) return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    void runAutosave()
  }, 1000)
}

async function runAutosave(): Promise<void> {
  if (!dirty || !currentFilePath) return
  const revision = documentRevision
  const filePath = currentFilePath
  const content = getContent()
  // rebuildMenu=false: autosave must never rebuild the app menu (macOS IME)
  // autosave=true: the main process may refuse the write when the file changed
  // on disk since our last read or write, and ask the user instead.
  const path = await enqueueSave(() => window.electronAPI.saveFile(content, filePath, false, true))
  if (path && revision === documentRevision && currentFilePath === filePath) {
    currentFilePath = path
    clearDirty()
    noteTabSaved(content)
    showSaveStatus('saved')
  }
}

async function saveCurrent(saveAs = false): Promise<boolean> {
  const revision = documentRevision
  const content = getContent()
  const expectedPath = currentFilePath
  // '' states plainly that the active document is untitled, so a save can never
  // be written into a file the window happens to have open in another tab.
  const path = await enqueueSave(() => saveAs
    ? window.electronAPI.saveFileAs(content, expectedPath ?? '')
    : window.electronAPI.saveFile(content, expectedPath ?? '', true))
  if (!path || currentFilePath !== expectedPath) return false

  currentFilePath = path
  updateFileTitle()
  refreshSiblings()
  noteTabSaved(content)
  if (path !== expectedPath) renderTabBar()
  if (revision === documentRevision) {
    clearDirty()
    showSaveStatus('saved')
    return true
  }
  if (dirty) scheduleAutosave()
  return false
}

function applyContent(content: string): void {
  // Reached only when the document identity changes (New file, loading a disk
  // version after an external conflict), so the undo stack must not survive.
  setContent(content, true)
}

// --- Document statistics (top-right hover indicator) ---
function countCharacters(content: string): number {
  return content.replace(/\s/g, '').length
}

function countTokens(content: string): number {
  const tokens = content.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z]+(?:['’\\-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g)
  return tokens?.length ?? 0
}

function countParagraphs(content: string): number {
  const normalized = content.replace(/\r\n?/g, '\n').trim()
  return normalized ? normalized.split(/\n\s*\n+/).filter((block) => block.trim()).length : 0
}

function updateWordCount(content?: string): void {
  const text = content ?? getContent()
  const tip = wordCountEl().querySelector('.word-count-tip')
  if (!tip) return
  tip.textContent = isChinese()
    ? `${countCharacters(text)} 字 · ${countTokens(text)} 词 · ${countParagraphs(text)} 段`
    : `${countCharacters(text)} chars · ${countTokens(text)} words · ${countParagraphs(text)} paragraphs`
}

// --- Reveal the current file in the OS file manager ---
function fileLocationLabel(): string {
  if (isChinese()) {
    return fileManagerName === 'finder'
      ? '在 Finder 中显示'
      : fileManagerName === 'explorer'
        ? '在资源管理器中显示'
        : '打开所在文件夹'
  }
  return fileManagerName === 'finder'
    ? 'Reveal in Finder'
    : fileManagerName === 'explorer'
      ? 'Reveal in File Explorer'
      : 'Open Containing Folder'
}

// The titlebar is a window drag region, so the button cannot rely on
// `#titlebar:hover`. Its gate lives on the file title instead; this keeps the
// label and the disabled state in sync with the loaded document.
// --- Markdown source / WYSIWYG toggle ---
function updateSourceToggle(): void {
  const btn = sourceToggleBtnEl()
  btn.classList.toggle('active', sourceModeActive)
  const label = sourceModeActive
    ? (isChinese() ? '切换回所见即所得' : 'Switch to WYSIWYG')
    : (isChinese() ? '切换 Markdown 源码' : 'Switch to Markdown source')
  btn.setAttribute('aria-label', label)
  const tip = btn.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
}

function updateUiLanguage(): void {
  const zh = isChinese()
  document.documentElement.lang = zh ? 'zh-CN' : 'en'
  document.title = 'ColaMD'
  untitledName = zh ? '未命名' : 'Untitled'
  fileTabEl().textContent = zh ? '文件' : 'Files'
  outlineTabEl().textContent = zh ? '大纲' : 'Outline'
  fileToggleBtnEl().setAttribute('aria-label', zh ? '显示 / 隐藏文件列表' : 'Show / hide file list')
  sourceToggleBtnEl().setAttribute('aria-label', zh ? '切换 Markdown 源码 / 所见即所得' : 'Toggle Markdown source / WYSIWYG')
  const wordTip = wordCountEl().querySelector('.word-count-tip')
  if (wordTip) wordTip.textContent = zh ? '0 字 · 0 词 · 0 段' : '0 chars · 0 words · 0 paragraphs'
  updateSourceToggle()
  updateWordCount()
}
function scrollRatio(el: HTMLElement): number {
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function restoreScrollRatio(el: HTMLElement, ratio: number): void {
  requestAnimationFrame(() => {
    const range = el.scrollHeight - el.clientHeight
    el.scrollTop = Math.max(0, Math.min(range, range * ratio))
  })
}

function toggleSourceMode(): void {
  if (sourceModeActive) {
    const ratio = scrollRatio(sourceEl())
    // Source → WYSIWYG: re-parse the textarea content back into the editor
    exitSourceMode()
    setMarkdownProgrammatically(sourceEl().value)
    restoreScrollRatio(editorEl(), ratio)
  } else {
    // WYSIWYG → Source: serialize the current editor content into the textarea
    enterSourceMode(getMarkdown(), scrollRatio(editorEl()))
  }
  updateWordCount()
  scheduleOutlineUpdate()
}

function updatePanelVisibility(): void {
  const show = !manualHidden
  filePanelEl().hidden = !show
  document.body.classList.toggle('show-file-panel', show)
  fileToggleBtnEl().classList.toggle('active', show)
  fileListEl().hidden = panelMode !== 'files'
  outlineListEl().hidden = panelMode !== 'outline'
  fileTabEl().classList.toggle('active', panelMode === 'files')
  fileTabEl().setAttribute('aria-selected', String(panelMode === 'files'))
  outlineTabEl().classList.toggle('active', panelMode === 'outline')
  outlineTabEl().setAttribute('aria-selected', String(panelMode === 'outline'))
}

function setPanelMode(mode: 'files' | 'outline'): void {
  panelMode = mode
  updatePanelVisibility()
  if (mode === 'outline') renderOutline()
}

interface OutlineItem {
  level: number
  title: string
  element?: HTMLElement
  line?: number
}

function sourceOutline(content: string): OutlineItem[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
    if (!match) return []
    const title = match[2].replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim()
    return title ? [{ level: match[1].length, title, line: index }] : []
  })
}

function visualOutline(): OutlineItem[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#editor .ProseMirror h1, #editor .ProseMirror h2, #editor .ProseMirror h3, #editor .ProseMirror h4, #editor .ProseMirror h5, #editor .ProseMirror h6'))
    .map((element) => ({ level: Number(element.tagName.slice(1)), title: element.textContent?.trim() ?? '', element }))
    .filter((item) => item.title)
}

function outlineVisible(): boolean {
  return !manualHidden && panelMode === 'outline'
}

function renderOutline(): void {
  // The outline is only ever read from the panel, which is hidden by default.
  // Rebuilding it on every keystroke (and on every scroll) burned a full DOM
  // teardown plus forced layout per frame for output nobody could see.
  if (!outlineVisible()) return
  const list = outlineListEl()
  outlineItems = sourceModeActive ? sourceOutline(sourceEl().value) : visualOutline()
  list.innerHTML = ''
  if (outlineItems.length === 0) {
    outlineActiveIndex = -1
    return
  }
  outlineItems.forEach((item, index) => {
    const entry = document.createElement('li')
    const button = document.createElement('button')
    button.dataset.headingIndex = String(index)
    button.type = 'button'
    button.textContent = item.title
    // Hover keeps truncated headings readable while the panel width stays
    // as-is in this change (#64).
    button.title = item.title
    button.style.paddingLeft = `${8 + (item.level - 1) * 12}px`
    button.addEventListener('click', () => {
      // Re-resolve the entry against the live DOM: cached element references
      // die when the editor content is re-set (#64).
      const current = (sourceModeActive ? sourceOutline(sourceEl().value) : visualOutline())[index]
      if (!current) return
      if (current.element) {
        // flashHeadingOnArrival signals the jump phase, which engages the
        // outline jump lock for visual-mode jumps.
        current.element.scrollIntoView({ behavior: 'smooth', block: 'start' })
        flashHeadingOnArrival(current.element)
      } else if (current.line !== undefined) {
        beginOutlineJump()
        const source = sourceEl()
        const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
        source.scrollTop = Math.max(0, current.line * lineHeight - lineHeight)
        source.focus()
        revealSourceHeading(source, current.line)
      }
      setActiveOutlineIndex(index)
    })
    entry.appendChild(button)
    list.appendChild(entry)
  })
  applyOutlineActive()
  scheduleOutlineActiveSync()
}

function applyOutlineActive(): void {
  const list = outlineListEl()
  const buttons = list.querySelectorAll<HTMLButtonElement>('button')
  buttons.forEach((button, index) => {
    button.classList.toggle('active', index === outlineActiveIndex)
  })
  // Keep the tracked section visible in long documents.
  const active = buttons[outlineActiveIndex]
  if (active) revealOutlineEntry(active)
}

// Manual reveal of the active entry inside the panel. scrollIntoView() must
// not be used here: it would also interrupt the smooth scroll of the content
// pane started by an outline click, so only the panel's own scroller moves.
function revealOutlineEntry(button: HTMLButtonElement): void {
  const panel = filePanelEl()
  const panelTop = panel.getBoundingClientRect().top
  const top = button.getBoundingClientRect().top - panelTop + panel.scrollTop
  const bottom = top + button.offsetHeight
  if (top < panel.scrollTop) {
    panel.scrollTop = top
  } else if (bottom > panel.scrollTop + panel.clientHeight) {
    panel.scrollTop = bottom - panel.clientHeight
  }
}

function beginOutlineJump(): void {
  outlineJumping = true
  if (outlineJumpTimer) clearTimeout(outlineJumpTimer)
  outlineJumpStartTop = (sourceModeActive ? sourceEl() : editorEl()).scrollTop
  // scrollend releases the lock earlier; this fallback exists for the
  // no-scroll case. Re-arming while the position keeps changing keeps long
  // smooth jumps locked for their whole duration (review on #68).
  outlineJumpTimer = setTimeout(releaseOutlineJumpIfSettled, 1500)
}

function releaseOutlineJumpIfSettled(): void {
  if (!outlineJumping) return
  const top = (sourceModeActive ? sourceEl() : editorEl()).scrollTop
  if (top !== outlineJumpStartTop) {
    outlineJumpStartTop = top
    outlineJumpTimer = setTimeout(releaseOutlineJumpIfSettled, 400)
    return
  }
  endOutlineJump()
}

function endOutlineJump(): void {
  if (!outlineJumping) return
  outlineJumping = false
  if (outlineJumpTimer) {
    clearTimeout(outlineJumpTimer)
    outlineJumpTimer = null
  }
  scheduleOutlineActiveSync()
}

function setActiveOutlineIndex(index: number): void {
  if (index === outlineActiveIndex) return
  outlineActiveIndex = index
  applyOutlineActive()
}

function scheduleOutlineActiveSync(): void {
  if (!outlineVisible()) return
  if (outlineJumping) return
  if (outlineSyncQueued) return
  outlineSyncQueued = true
  requestAnimationFrame(() => {
    outlineSyncQueued = false
    syncOutlineActive()
  })
}

// Scrollspy: highlight the outline entry for the section at the top of the
// viewport so the outline tracks reading progress (#64).
function syncOutlineActive(): void {
  if (outlineItems.length === 0) return
  setActiveOutlineIndex(sourceModeActive ? sourceActiveIndex() : visualActiveIndex())
}

function visualActiveIndex(): number {
  const container = editorEl()
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2
  if (atBottom) return outlineItems.length - 1
  const threshold = container.getBoundingClientRect().top + Math.min(96, container.clientHeight * 0.2)
  // Cached references are refreshed by renderOutline; the loop stops at the
  // first heading below the viewport top, so steady-state scrolling only
  // touches the entries it activates. Fall back to a live query when a cached
  // node went missing (content re-set mid-frame) — a detached node must never
  // win the race (#64).
  const items = outlineItems.some((item) => !item.element?.isConnected) ? visualOutline() : outlineItems
  let index = -1
  for (let i = 0; i < items.length; i += 1) {
    const element = items[i].element
    if (!element || !element.isConnected) continue
    if (element.getBoundingClientRect().top > threshold) break
    index = i
  }
  return index
}

function sourceActiveIndex(): number {
  const source = sourceEl()
  const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
  const firstLine = Math.round(source.scrollTop / lineHeight)
  let index = -1
  for (let i = 0; i < outlineItems.length; i += 1) {
    if ((outlineItems[i].line ?? 0) > firstLine + 1) break
    index = i
  }
  return index
}

// Source mode cannot render a heading band; selecting the heading line gives
// the same "you have arrived" feedback as the visual flash (#64).
function revealSourceHeading(source: HTMLTextAreaElement, line: number): void {
  let start = 0
  for (let i = 0; i < line; i += 1) {
    const next = source.value.indexOf('\n', start)
    if (next === -1) {
      start = source.value.length
      break
    }
    start = next + 1
  }
  const end = source.value.indexOf('\n', start)
  source.setSelectionRange(start, end === -1 ? source.value.length : end)
}

function scheduleOutlineUpdate(): void {
  if (!outlineVisible()) return
  if (outlineUpdateQueued) return
  outlineUpdateQueued = true
  requestAnimationFrame(() => {
    outlineUpdateQueued = false
    renderOutline()
  })
}

function togglePanel(): void {
  manualHidden = !manualHidden
  localStorage.setItem('file-panel-hidden', manualHidden ? '1' : '0')
  updatePanelVisibility()
}

// Drag the panel's right edge to resize it; the width clamps to the
// FILE_PANEL_* range and persists on release. Pointer capture keeps the drag
// alive over iframes and selected text.
function initPanelResize(): void {
  const resizer = document.getElementById('panel-resizer') as HTMLDivElement | null
  if (!resizer) return
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    resizer.setPointerCapture(event.pointerId)
    resizer.classList.add('dragging')
    document.body.classList.add('panel-resizing')
    let width = FILE_PANEL_DEFAULT_WIDTH
    const move = (moveEvent: PointerEvent) => {
      width = clampFilePanelWidth(moveEvent.clientX)
      applyFilePanelWidth(width)
    }
    const finish = () => {
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', finish)
      resizer.removeEventListener('pointercancel', finish)
      resizer.classList.remove('dragging')
      document.body.classList.remove('panel-resizing')
      localStorage.setItem('file-panel-width', String(width))
    }
    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', finish)
    resizer.addEventListener('pointercancel', finish)
  })
}

function updateFileTitle(): void {
  // The filename is shown by the tab; the window title is the only place left
  // that needs it spelled out (there is no centred title in the title bar).
  const name = currentFilePath ? (currentFilePath.split(/[\\/]/).pop() || currentFilePath) : (isChinese() ? '未命名' : 'Untitled')
  document.title = name
}

// --- File panel: one root, expanded downward ---
// The root is the open document's directory and `..` stays the one way back
// up; a directory is read only when it is expanded, so a deep tree costs
// nothing until the reader asks for it. Expansion lives in memory only — no
// workspace, nothing restored on the next launch.
const PANEL_INDENT = 12
let panelRoot: import('../preload/index').SiblingFile[] = []
const panelChildren = new Map<string, import('../preload/index').SiblingFile[]>()
const panelExpanded = new Set<string>()
const panelLoading = new Set<string>()

type PanelRow = {
  file: import('../preload/index').SiblingFile
  depth: number
  expandable: boolean
  expanded: boolean
  empty: boolean
}

// Flatten the expanded tree into visible rows. Rendering stays a flat list, so
// hover, active state and hit-testing keep working the way they always have.
function panelRows(): PanelRow[] {
  const rows: PanelRow[] = []
  const walk = (entries: import('../preload/index').SiblingFile[], depth: number): void => {
    for (const file of entries) {
      const expanded = file.kind === 'directory' && panelExpanded.has(file.path)
      rows.push({ file, depth, expandable: file.kind === 'directory', expanded, empty: false })
      if (!expanded) continue
      const children = panelChildren.get(file.path)
      if (!children) {
        void loadPanelDirectory(file.path)
        continue
      }
      if (children.length === 0) rows.push({ file, depth: depth + 1, expandable: false, expanded: false, empty: true })
      else walk(children, depth + 1)
    }
  }
  walk(panelRoot, 0)
  return rows
}

function loadPanelDirectory(dir: string): void {
  if (panelLoading.has(dir)) return
  panelLoading.add(dir)
  void window.electronAPI.listDirectory(dir).then((children) => {
    panelLoading.delete(dir)
    if (!children) return
    panelChildren.set(dir, children)
    renderFileList(panelRoot)
  })
}

function togglePanelDirectory(dir: string): void {
  if (panelExpanded.has(dir)) panelExpanded.delete(dir)
  else {
    panelExpanded.add(dir)
    loadPanelDirectory(dir)
  }
  renderFileList(panelRoot)
}

function renderFileList(files: import('../preload/index').SiblingFile[]): void {
  panelRoot = files
  hideTip()
  const list = fileListEl()
  list.innerHTML = ''
  for (const row of panelRows()) {
    const li = document.createElement('li')
    const indent = 8 + row.depth * PANEL_INDENT
    if (row.empty) {
      const empty = document.createElement('div')
      empty.className = 'file-empty'
      empty.style.paddingLeft = `${indent}px`
      empty.textContent = isChinese() ? '这个文件夹是空的' : 'This folder is empty'
      li.appendChild(empty)
      list.appendChild(li)
      continue
    }
    const f = row.file
    const btn = document.createElement('button')
    btn.style.paddingLeft = `${indent}px`
    const chevron = document.createElement('span')
    chevron.className = `file-entry-chevron${row.expanded ? ' expanded' : ''}${f.kind === 'parent' ? ' back' : ''}`
    chevron.setAttribute('aria-hidden', 'true')
    if (f.kind === 'parent') chevron.innerHTML = '<svg viewBox="0 0 16 16"><path d="M13 8H3.5M7 4 3 8l4 4"/></svg>'
    else if (row.expandable) chevron.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3.5 1.5 7 5l-3.5 3.5"/></svg>'
    const icon = document.createElement('span')
    icon.className = `file-entry-icon ${f.kind}`
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = f.kind === 'directory'
      ? '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h6v6.5h-11.5z"/><path d="M2.5 4.5v-1h4l1.5 1.5"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
    const label = document.createElement('span')
    label.className = 'file-entry-name'
    label.textContent = f.kind === 'parent' ? '..' : f.name
    btn.addEventListener('mouseenter', () => {
      // Only a name that is actually cut off is worth a label; one that fits
      // says itself. No marquee: sliding the name under the icon to read it
      // covers the row it belongs to.
      if (label.scrollWidth <= label.clientWidth + 1) return
      scheduleTip(btn, label.textContent ?? '', 'right', ROW_TIP_DELAY)
    })
    btn.addEventListener('mouseleave', hideTip)
    btn.title = f.kind === 'directory'
      ? (isChinese()
          ? `${row.expanded ? '收起' : '展开'} ${f.name}`
          : `${row.expanded ? 'Collapse' : 'Expand'} ${f.name}`)
      : f.kind === 'parent' ? (isChinese() ? '返回上级目录' : 'Go to parent directory') : f.name
    btn.dataset.path = f.path
    btn.dataset.kind = f.kind
    btn.classList.toggle('directory', f.kind === 'directory')
    btn.classList.toggle('parent', f.kind === 'parent')
    if (f.path === currentFilePath) btn.classList.add('active')
    // The way back sits in the expander's column and its name takes the icon's,
    // so the row reads left to right like every other one instead of hanging a
    // column in. It has no icon of its own, which is why no slot is skipped.
    if (f.kind === 'parent') btn.append(chevron, label)
    else btn.append(chevron, icon, label)
    li.appendChild(btn)
    list.appendChild(li)
  }
}

async function refreshSiblings(): Promise<void> {
  const files = await window.electronAPI.listSiblings()
  if (files) renderFileList(files)
}

function enterSourceMode(content: string, ratio = 0): void {
  sourceModeActive = true
  editorEl().classList.add('hidden')
  const ta = sourceEl()
  ta.classList.add('visible')
  ta.value = content
  restoreScrollRatio(ta, ratio)
  updateSourceToggle()
}

function exitSourceMode(): void {
  sourceModeActive = false
  editorEl().classList.remove('hidden')
  sourceEl().classList.remove('visible')
  updateSourceToggle()
}

const LARGE_DOCUMENT_SOURCE_THRESHOLD = 512 * 1024

function setContent(content: string, flushHistory = false): void {
  // Follow the incoming document's Markdown style before it is parsed, so a
  // save writes the same markers the file already used.
  const detectedStyle = detectMarkdownStyle(content)
  applyMarkdownStyle(detectedStyle)
  if (content.length >= LARGE_DOCUMENT_SOURCE_THRESHOLD) {
    // ProseMirror renders the whole document eagerly. Keep very large files in
    // the existing source editor so opening them stays responsive on Windows.
    enterSourceMode(content)
    updateWordCount(content)
    return
  }
  exitSourceMode()
  setMarkdownProgrammatically(content, flushHistory)
  updateWordCount(content)
}

function getContent(): string {
  if (sourceModeActive) return sourceEl().value
  return getMarkdown()
}

function getExportSnapshot(content: string): {
  content: string
  html: string
  styles: string
  bodyClass: string
  background: string
} {
  let styles = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      styles += Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n') + '\n'
    } catch {
      // Ignore stylesheets that the browser marks as inaccessible.
    }
  }
  return {
    content,
    html: document.querySelector('#editor .ProseMirror')?.innerHTML ?? '',
    styles,
    bodyClass: Array.from(document.body.classList).filter((name) => name !== 'show-file-panel').join(' '),
    background: getComputedStyle(document.body).backgroundColor,
  }
}

async function exportCurrentHTML(): Promise<void> {
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  // Render the latest source text before taking the DOM snapshot, then restore
  // source mode so exporting does not change the user's editing context.
  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })
  }

  await window.electronAPI.exportHTML(getExportSnapshot(content))

  if (wasSourceMode) {
    enterSourceMode(content, sourceScrollRatio)
  }
}

async function exportCurrentImage(preset: 'desktop' | 'mobile'): Promise<void> {
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  await window.electronAPI.exportImage(getExportSnapshot(content), preset)

  if (wasSourceMode) enterSourceMode(content, sourceScrollRatio)
}

async function init(): Promise<void> {
  const api = window.electronAPI
  // macOS keeps its own overlay scrollbars (drawn while you scroll, no layout
  // space, never in the way). The thin custom scrollbar is only for Windows and
  // Linux, where the platform default is a chunky always-on bar.
  if (!/^Mac/i.test(navigator.platform)) document.body.classList.add('platform-non-mac')
  const language = await api.getLanguage()
  fileManagerName = await api.getFileManagerName()
  setUiLanguage(language)
  const savedTheme = loadSavedTheme()
  if (savedTheme.startsWith('custom:')) {
    // Load before applying: a newly opened window must not briefly paint the
    // custom class without its stylesheet. Missing files self-heal to elegant.
    const css = await api.loadThemeCSS(savedTheme.slice(7))
    applyTheme(css ? savedTheme : 'elegant', css ?? undefined)
  } else {
    applyTheme(savedTheme)
  }
  applyEditorFont(loadSavedEditorFont())

  const searchPanel = new SearchPanel()
  searchPanel.setLanguage(language)
  setMathModalLanguage(language)
  api.onSearch(() => searchPanel.show())
  api.onMathModal(() => showMathModal())
  api.onFormatCommand((id) => runFormatCommand(id as FormatCommandId))
  updateUiLanguage()

  await createEditor('editor', (markdown) => {
    updateWordCount(markdown)
  }, () => {
    if (!editorReady) return
    if (!applyingProgrammaticChange) setDirty()
    scheduleOutlineUpdate()
  })
  updateWordCount()
  editorReady = true
  resetDirty()

  // Main asks for an authoritative snapshot before any close or quit.
  api.onRequestDocumentState(async (requestId) => {
    captureActiveTab()
    // Report every tab that still has unsaved content. The main process writes
    // the ones with a path and refuses to close on the untitled ones, so a
    // background tab can never be dropped silently.
    window.electronAPI.respondDocumentState(requestId, {
      dirty,
      content: getContent(),
      tabs: tabs.filter((tab) => tab.dirty).map((tab) => ({ path: tab.filePath, content: tab.content }))
    })
  })
  // Report readiness only after every listener is registered — the main process
  // reacts to this signal by flushing queued tab-opens and by trusting the
  // window with close/quit flows. It sat mid-init once and the flush raced
  // bindTabBar: files handed over at launch were dropped silently.
  api.reportRendererReady()

  // Save before switching files. If saving is cancelled or fails, preserve the
  // current document rather than opening another file over it.
  fileListEl().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
    if (!btn || !btn.dataset.path) return
    // A directory expands in place; the tree only ever grows downward.
    if (btn.dataset.kind === 'directory') {
      togglePanelDirectory(btn.dataset.path)
      return
    }
    if (btn.dataset.path === currentFilePath) return
    // ⌘/Ctrl click opens the file in a tab of its own (design.md).
    if (btn.dataset.kind === 'file' && (e.metaKey || e.ctrlKey)) {
      await openFileInNewTab(btn.dataset.path)
      return
    }
    if (btn.dataset.kind === 'file' && dirty && !await saveCurrent()) return
    await api.openSibling(btn.dataset.path)
  })

  fileToggleBtnEl().addEventListener('click', togglePanel)
  // Right-click on a file panel entry opens the native context menu. The
  // parent entry has no target worth acting on, so it keeps the default.
  fileListEl().addEventListener('contextmenu', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
    const path = btn?.dataset.path
    const kind = btn?.dataset.kind
    if (!path || kind === 'parent') return
    e.preventDefault()
    void api.showEntryContextMenu(path, kind === 'directory' ? 'directory' : 'file')
  })
  initPanelResize()
  bindTabBar(api)
  // The launch document (the welcome screen or a restored file) is a tab from
  // the first frame, so the strip never renders without one.
  ensureTab()
  renderTabBar()
  fileTabEl().addEventListener('click', () => setPanelMode('files'))
  outlineTabEl().addEventListener('click', () => setPanelMode('outline'))
  api.onToggleFilePanel(() => togglePanel())

  sourceToggleBtnEl().addEventListener('click', toggleSourceMode)
  api.onToggleSourceMode(() => toggleSourceMode())
  // Source-mode edits update the word count and mark the doc dirty in real time
  sourceEl().addEventListener('input', () => {
    setDirty()
    updateWordCount()
    scheduleOutlineUpdate()
  })
  // The outline tracks scrolling in both modes so it doubles as a progress
  // view (#64); rAF keeps the rect reads to one batch per frame. `scrollend`
  // also releases the outline jump lock as soon as a jump scroll settles.
  editorEl().addEventListener('scroll', scheduleOutlineActiveSync, { passive: true })
  sourceEl().addEventListener('scroll', scheduleOutlineActiveSync, { passive: true })
  editorEl().addEventListener('scrollend', endOutlineJump)
  sourceEl().addEventListener('scrollend', endOutlineJump)
  // Anchor-link jumps start inside the editor; the phase signal engages the
  // same jump lock the outline clicks use, so the highlight cannot be stolen
  // by sections passed along the way (review on #68).
  onEditorJumpPhase((phase) => (phase === 'start' ? beginOutlineJump() : endOutlineJump()))

  api.onSiblingsChanged((files) => {
    // A watcher refresh can change any directory that is open, so drop the
    // cached levels and let the expanded ones read themselves again.
    panelChildren.clear()
    renderFileList(files)
  })
  updatePanelVisibility()
  await refreshSiblings()

  api.onMenuOpen(async () => {
    // 'file-opened' event drives the content load (and file-panel refresh)
    await api.openFile()
  })

  api.onMenuSave(() => { void saveCurrent() })
  api.onMenuSaveAs(() => { void saveCurrent(true) })
  api.onMenuExportPDF(() => api.exportPDF())
  api.onMenuExportHTML(() => { void exportCurrentHTML() })
  api.onMenuExportDOCX(() => { void api.exportDOCX(getContent()) })
  api.onMenuExportImage((preset) => { void exportCurrentImage(preset) })

  api.onNewFile(() => {
    releaseMermaidRenderer()
    exitSourceMode()
    ensureTab()
    applyContent('')
    scheduleOutlineUpdate()
    renderTabBar()
  })
  api.onFileOpened((data) => {
    releaseMermaidRenderer()
    // A document opened into a window that has none yet (a launch with a file)
    // lands in the first tab rather than creating a second one.
    ensureTab()
    currentFilePath = data.path
    dirty = false
    const tab = activeTab()
    if (tab) {
      tab.filePath = data.path
      tab.dirty = false
      tab.revision = documentRevision
      tab.diskContent = data.content
    }
    resetDirty()
    setContent(data.content, true)
    const resetScroll = () => {
      editorEl().scrollTop = 0
      sourceEl().scrollTop = 0
    }
    resetScroll()
    requestAnimationFrame(resetScroll)
    updateFileTitle()
    updatePanelVisibility()
    refreshSiblings()
    scheduleOutlineUpdate()
    renderTabBar()
  })
  api.onFileChanged((content) => {
    if (dirty) {
      raiseExternalConflict()
      return
    }
    if (sourceModeActive) {
      sourceEl().value = content
    } else {
      // An external write is not something the reader can undo into; making it
      // one undo step would also let a stray undo write stale content back.
      setMarkdownProgrammatically(content, true)
    }
    updateSourceToggle()
    updateWordCount()
    resetDirty()
    scheduleOutlineUpdate()
  })

  api.onSetTheme((theme) => applyTheme(theme))
  api.onLanguageChanged((language: UiLanguage) => {
    setUiLanguage(language)
    searchPanel.setLanguage(language)
    setMathModalLanguage(language)
    updateUiLanguage()
    // Tab labels and the close tooltip are built in the current language.
    renderTabBar()
  })
  api.onExternalConflictResult((result) => {
    if (result.action === 'load' && typeof result.content === 'string') {
      applyContent(result.content)
      resetDirty()
      updateWordCount()
      scheduleOutlineUpdate()
    } else {
      // Keep mine: resume autosave; the next save overwrites the external edit.
      showSaveStatus('dirty')
      if (dirty) scheduleAutosave()
    }
    externalConflictPending = false
  })
  api.onOpenFontSettings(() => showFontSettingsModal())
  api.onEditorFontChanged((prefs) => applyEditorFont(prefs.family || prefs.size ? prefs : null))
  api.onSetCustomCSS((css) => {
    const theme = loadSavedTheme()
    applyTheme(theme, css)
  })

  api.onMenuImportTheme(async () => {
    const result = await api.loadCustomTheme()
    if (result) applyTheme(`custom:${result.name}`, result.css)
  })

  // --- Auto update banner (weak, non-blocking) ---
  let updateDownloaded = false
  function showUpdateBanner(version: string): void {
    updateBannerTextEl().textContent = updateDownloaded
      ? (isChinese() ? `新版本 v${version} 已就绪` : `Update v${version} is ready`)
      : (isChinese() ? `发现新版本 v${version}` : `Update v${version} available`)
    updateBannerActionEl().textContent = updateDownloaded ? (isChinese() ? '重启安装' : 'Restart') : (isChinese() ? '更新' : 'Update')
    updateBannerActionEl().disabled = false
    updateBannerEl().hidden = false
  }

  api.onUpdateAvailable((version) => {
    updateDownloaded = false
    showUpdateBanner(version)
  })
  api.onUpdateDownloaded((version) => {
    updateDownloaded = true
    showUpdateBanner(version)
  })
  api.onUpdateProgress((percent) => {
    if (updateDownloaded) return
    updateBannerActionEl().textContent = isChinese() ? `下载中 ${percent}%` : `Downloading ${percent}%`
  })
  api.onUpdateError(() => {
    if (updateDownloaded) return
    updateBannerActionEl().textContent = isChinese() ? '下载失败，点击重试' : 'Failed, retry'
    updateBannerActionEl().disabled = false
  })

  updateBannerActionEl().addEventListener('click', async () => {
    if (updateDownloaded) {
      await api.installUpdate()
    } else {
      updateBannerActionEl().textContent = isChinese() ? '下载中…' : 'Downloading…'
      updateBannerActionEl().disabled = true
      try {
        await api.downloadUpdate()
      } catch {
        // The 'update-error' event may already have reset the label; this
        // catch covers the path where the IPC call itself rejects.
        updateBannerActionEl().textContent = isChinese() ? '下载失败，点击重试' : 'Failed, retry'
        updateBannerActionEl().disabled = false
      }
    }
  })
  document.getElementById('update-banner-dismiss')!.addEventListener('click', () => {
    updateBannerEl().hidden = true
  })

  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (!filePath) return
    const result = await api.openFilePath(filePath)
    // 'file-opened' event drives the content load when opened into this window
    void result
  })
}

init().catch((e) => console.error('ColaMD init failed:', e))