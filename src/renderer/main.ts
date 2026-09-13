import { createEditor, flashHeadingOnArrival, getMarkdown, onEditorJumpPhase, setMarkdown, showMathModal, setMathModalLanguage, releaseMermaidRenderer, captureEditorState, restoreEditorState, buildEditorState, serializeEditorState } from './editor/editor'
import type { EditorState } from '@milkdown/kit/prose/state'
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
const revealFileBtnEl = () => document.getElementById('reveal-file-btn') as HTMLButtonElement
const wordCountEl = () => document.getElementById('word-count') as HTMLElement
const fileTitleEl = () => document.getElementById('file-title') as HTMLElement
const saveStatusEl = () => document.getElementById('save-status') as HTMLElement
const updateBannerEl = () => document.getElementById('update-banner') as HTMLElement
const updateBannerTextEl = () => document.getElementById('update-banner-text') as HTMLElement
const updateBannerActionEl = () => document.getElementById('update-banner-action') as HTMLButtonElement
const tabBarEl = () => document.getElementById('tab-bar') as HTMLElement
const tabListEl = () => document.getElementById('tab-list') as HTMLElement
const newTabBtnEl = () => document.getElementById('new-tab-btn') as HTMLButtonElement

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

// Resizable file panel: default 220px, drag range 180-420px, persisted
// locally (design.md). Applied at module load so the first paint already
// uses the saved width.
const FILE_PANEL_MIN_WIDTH = 180
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
  window.electronAPI.reportDirty(dirty, activeTabId >= 0 ? activeTabId : undefined)
}

// --- Save status hint (#49) ---
let saveStatusTimer: ReturnType<typeof setTimeout> | null = null
// True while an external-modification conflict waits for the user's choice;
// autosave stays paused so it cannot silently overwrite the external edit.
let externalConflictPending = false

// --- Tabs (docs/tabs-tech-design.md) ---
// The editor is a single instance. The module-level variables above are the
// live state of the ACTIVE tab; each background tab keeps a snapshot and the
// switch protocol swaps the two sides. Snapshots hold whole EditorStates, so
// undo history, selection, and search state travel with their tab and can
// never reach into another tab's document.
interface TabSession {
  tabId: number
  filePath: string | null
  dirty: boolean
  documentRevision: number
  sourceModeActive: boolean
  editorState: EditorState | null
  sourceContent: string | null
  scrollRatioValue: number
  externalConflictPending: boolean
  // Disk version that arrived while this tab was in the background; the
  // conflict dialog is deferred until the tab becomes active again.
  externalDiskContent: string | null
  // Content loaded from main that has not been applied to any editor state
  // yet (tab created by main, or a background hot reload of a clean tab).
  pendingLoad: string | null
  outlineActiveIndex: number
}

const tabs = new Map<number, TabSession>()
let activeTabId = -1

function tabName(filePath: string | null): string {
  return filePath ? (filePath.split(/[\\/]/).pop() || filePath) : (isChinese() ? '未命名' : 'Untitled')
}

function createLocalSession(tabId: number): TabSession {
  // Events can arrive out of order at startup (file-opened queues before
  // new-tab is registered), so creating twice must preserve parked state.
  const existing = tabs.get(tabId)
  if (existing) return existing
  const session: TabSession = {
    tabId,
    filePath: null,
    dirty: false,
    documentRevision: 0,
    sourceModeActive: false,
    editorState: null,
    sourceContent: null,
    scrollRatioValue: 0,
    externalConflictPending: false,
    externalDiskContent: null,
    pendingLoad: null,
    outlineActiveIndex: -1,
  }
  tabs.set(tabId, session)
  return session
}

// Copy the live variables into the outgoing tab's snapshot before the live
// state is overwritten by the incoming tab.
function captureActiveSession(): void {
  const snap = tabs.get(activeTabId)
  if (!snap) return
  snap.filePath = currentFilePath
  snap.dirty = dirty
  snap.documentRevision = documentRevision
  snap.externalConflictPending = externalConflictPending
  snap.sourceModeActive = sourceModeActive
  snap.outlineActiveIndex = outlineActiveIndex
  if (sourceModeActive) {
    snap.sourceContent = sourceEl().value
    snap.scrollRatioValue = scrollRatio(sourceEl())
    snap.editorState = null
  } else {
    snap.editorState = captureEditorState()
    snap.scrollRatioValue = scrollRatio(editorEl())
    snap.sourceContent = null
  }
}

function surfaceDeferredConflict(): void {
  const snap = tabs.get(activeTabId)
  if (!snap || !snap.externalConflictPending || snap.externalDiskContent === null) return
  const el = saveStatusEl()
  if (el) {
    el.textContent = isChinese() ? '文件已被外部修改' : 'File changed externally'
    el.classList.remove('saved')
    el.classList.add('pending')
  }
  window.electronAPI.reportExternalConflict?.()
}

function activateSession(tabId: number): void {
  const snap = tabs.get(tabId)
  if (!snap || tabId === activeTabId) return
  // Flush the outgoing tab's pending autosave while its content is still in
  // the live editor; runAutosave captures path and content synchronously.
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
    if (dirty && currentFilePath && !externalConflictPending) void runAutosave()
  }
  captureActiveSession()
  activeTabId = tabId
  currentFilePath = snap.filePath
  dirty = snap.dirty
  // Invalidate saves that were in flight for either tab across the switch.
  documentRevision = snap.documentRevision + 1
  snap.documentRevision = documentRevision
  externalConflictPending = snap.externalConflictPending
  if (snap.sourceModeActive) {
    enterSourceMode(snap.sourceContent ?? '', snap.scrollRatioValue)
  } else if (snap.editorState) {
    exitSourceMode()
    restoreEditorState(snap.editorState)
    restoreScrollRatio(editorEl(), snap.scrollRatioValue)
  } else if (snap.pendingLoad !== null) {
    setContent(snap.pendingLoad, true)
    snap.pendingLoad = null
    editorEl().scrollTop = 0
    sourceEl().scrollTop = 0
  } else {
    // A blank tab created by New Tab.
    setContent('', true)
    editorEl().scrollTop = 0
    sourceEl().scrollTop = 0
  }
  snap.editorState = null
  snap.sourceContent = null
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  if (dirty && currentFilePath && !externalConflictPending) scheduleAutosave()
  window.electronAPI.reportDirty(dirty, tabId)
  updateFileTitle()
  updateFileRevealButton()
  updateSourceToggle()
  updateWordCount()
  if (dirty) {
    showSaveStatus('dirty')
  } else {
    clearSaveStatus()
  }
  endOutlineJump()
  outlineActiveIndex = snap.outlineActiveIndex
  scheduleOutlineUpdate()
  surfaceDeferredConflict()
  void window.electronAPI.notifyActiveTab(tabId)
  renderTabStrip()
  updateTabBarVisibility()
}

function removeLocalSession(tabId: number): void {
  tabs.delete(tabId)
}

// Apply a freshly loaded document to the ACTIVE tab. Shared by the
// file-opened event and the startup path where file-opened is processed
// before new-tab (both queues flush at registration time).
function applyLoadedContent(path: string | null, content: string): void {
  releaseMermaidRenderer()
  currentFilePath = path
  const snap = tabs.get(activeTabId)
  if (snap) snap.filePath = path
  updateFileRevealButton()
  resetDirty()
  setContent(content, true)
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
  renderTabStrip()
}

function renderTabStrip(): void {
  const list = tabListEl()
  if (!list) return
  list.innerHTML = ''
  const ordered = [...tabs.values()].sort((a, b) => a.tabId - b.tabId)
  for (const snap of ordered) {
    const item = document.createElement('div')
    item.className = 'tab-item' + (snap.tabId === activeTabId ? ' active' : '')
    const name = tabName(snap.filePath)
    const label = document.createElement('span')
    label.className = 'tab-name'
    label.textContent = name
    item.title = snap.filePath ?? name
    item.dataset.tabId = String(snap.tabId)
    item.addEventListener('click', () => activateSession(snap.tabId))
    item.addEventListener('auxclick', (e) => {
      if (e.button === 1) void window.electronAPI.closeTab(snap.tabId)
    })
    // The prototype's per-tab close affordance: hidden until hover, present
    // on the active tab too. Linear SVG per AGENT.md, not a text glyph.
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'tab-close'
    closeBtn.setAttribute('aria-label', isChinese() ? '关闭标签页' : 'Close tab')
    closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void window.electronAPI.closeTab(snap.tabId)
    })
    item.append(label, closeBtn)
    list.appendChild(item)
  }
}

// design.md: the tab bar only exists once the user has created a second tab;
// with fewer than two tabs there is no persistent region at all. The bar
// collapses to zero height and fades (see base.css) instead of toggling
// display, so its entrance animates rather than jumps.
function updateTabBarVisibility(): void {
  const visible = tabs.size >= 2
  document.body.classList.toggle('has-tabs', visible)
  if (visible) renderTabStrip()
}

function showSaveStatus(state: 'dirty' | 'saved'): void {
  const el = saveStatusEl()
  if (!el) return
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  if (state === 'dirty') {
    // Announce unsaved edits only; a successful save fades out silently.
    el.textContent = isChinese() ? '已编辑' : 'Edited'
    el.classList.add('pending')
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

function setDirty(): void {
  documentRevision += 1
  dirty = true
  reportDirty()
  showSaveStatus('dirty')
  scheduleAutosave()
}

function clearDirty(): void {
  dirty = false
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  reportDirty()
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
  const path = await enqueueSave(() => window.electronAPI.saveFile(content, filePath, false, true, activeTabId >= 0 ? activeTabId : undefined))
  if (path && revision === documentRevision && currentFilePath === filePath) {
    currentFilePath = path
    clearDirty()
    showSaveStatus('saved')
  }
}

async function saveCurrent(saveAs = false): Promise<boolean> {
  const revision = documentRevision
  const content = getContent()
  const expectedPath = currentFilePath
  const tabId = activeTabId
  const path = await enqueueSave(() => saveAs
    ? window.electronAPI.saveFileAs(content, expectedPath ?? undefined, tabId >= 0 ? tabId : undefined)
    : window.electronAPI.saveFile(content, expectedPath ?? undefined, true, false, tabId >= 0 ? tabId : undefined))
  if (!path || currentFilePath !== expectedPath) return false

  currentFilePath = path
  updateFileTitle()
  updateFileRevealButton()
  refreshSiblings()
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
function updateFileRevealButton(): void {
  const btn = revealFileBtnEl()
  const label = fileLocationLabel()
  btn.disabled = currentFilePath === null
  // Only the styled .toolbar-tip is used; a native title tooltip would stack a
  // second label on top of it. Sibling titlebar buttons rely on aria-label too.
  btn.setAttribute('aria-label', label)
  const tip = btn.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
}

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
  fileTitleEl().dataset.untitled = zh ? '未命名' : 'Untitled'
  if (!currentFilePath) fileTitleEl().textContent = fileTitleEl().dataset.untitled ?? 'Untitled'
  fileTabEl().textContent = zh ? '文件' : 'Files'
  outlineTabEl().textContent = zh ? '大纲' : 'Outline'
  fileToggleBtnEl().setAttribute('aria-label', zh ? '显示 / 隐藏文件列表' : 'Show / hide file list')
  sourceToggleBtnEl().setAttribute('aria-label', zh ? '切换 Markdown 源码 / 所见即所得' : 'Toggle Markdown source / WYSIWYG')
  updateFileRevealButton()
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
// design.md range and persists on release. Pointer capture keeps the drag
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
  const name = currentFilePath ? (currentFilePath.split(/[\\/]/).pop() || currentFilePath) : (fileTitleEl().dataset.untitled || 'Untitled')
  fileTitleEl().textContent = name
}

function renderFileList(files: import('../preload/index').SiblingFile[]): void {
  const list = fileListEl()
  list.innerHTML = ''
  for (const f of files) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    const icon = document.createElement('span')
    icon.className = `file-entry-icon ${f.kind}`
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = f.kind === 'parent'
      ? '<svg viewBox="0 0 16 16"><path d="M13 8H3.5M7 4 3 8l4 4"/></svg>'
      : f.kind === 'directory'
        ? '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h6v6.5h-11.5z"/><path d="M2.5 4.5v-1h4l1.5 1.5"/></svg>'
        : '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
    const label = document.createElement('span')
    label.className = 'file-entry-name'
    label.textContent = f.kind === 'parent' ? '..' : f.name
    btn.addEventListener('mouseenter', () => {
      const overflow = label.scrollWidth - label.clientWidth
      if (overflow <= 0) return
      label.style.setProperty('--file-entry-scroll', `${overflow}px`)
      label.style.setProperty('--file-entry-scroll-duration', `${Math.min(6, Math.max(2.4, overflow / 20))}s`)
      label.classList.add('scrolling')
    })
    btn.addEventListener('mouseleave', () => {
      label.classList.remove('scrolling')
      label.style.removeProperty('--file-entry-scroll')
      label.style.removeProperty('--file-entry-scroll-duration')
    })
    btn.title = f.kind === 'directory'
      ? (isChinese() ? `打开 ${f.name}` : `Open ${f.name}`)
      : f.kind === 'parent' ? (isChinese() ? '返回上级目录' : 'Go to parent directory') : f.name
    btn.dataset.path = f.path
    btn.dataset.kind = f.kind
    btn.classList.toggle('directory', f.kind === 'directory')
    btn.classList.toggle('parent', f.kind === 'parent')
    if (f.path === currentFilePath) btn.classList.add('active')
    btn.append(icon, label)
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

  // Main asks for an authoritative snapshot before any close or quit. Every
  // tab reports its own state; dirty tabs include their content so the main
  // process can save them without another round trip.
  api.onRequestDocumentState((requestId) => {
    const tabStates = [...tabs.values()].map((snap) => {
      const isActive = snap.tabId === activeTabId
      const isDirty = isActive ? dirty : snap.dirty
      let content: string | undefined
      if (isDirty) {
      content = isActive
        ? getContent()
        : (snap.sourceContent ?? (snap.editorState ? serializeEditorState(snap.editorState) : null) ?? '')
      }
      return { tabId: snap.tabId, path: snap.filePath, dirty: isDirty, content }
    })
    window.electronAPI.respondDocumentState(requestId, { tabs: tabStates })
  })
  api.reportRendererReady()

  // Save before switching files. If saving is cancelled or fails, preserve the
  // current document rather than opening another file over it.
  fileListEl().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
    if (!btn || !btn.dataset.path) return
    if (btn.dataset.path === currentFilePath) return
    if (btn.dataset.kind === 'file' && dirty && !await saveCurrent()) return
    await api.openSibling(btn.dataset.path)
  })

  fileToggleBtnEl().addEventListener('click', togglePanel)
  revealFileBtnEl().addEventListener('click', () => { void api.revealFile() })
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

  api.onSiblingsChanged((files) => renderFileList(files))
  updatePanelVisibility()
  updateTabBarVisibility()
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

  api.onNewFile(() => { releaseMermaidRenderer(); exitSourceMode(); applyContent(''); scheduleOutlineUpdate() })
  api.onFileOpened((data) => {
    const snap = createLocalSession(data.tabId)
    if (data.tabId !== activeTabId) {
      // Background load: park the content in the session; activation applies it.
      snap.filePath = data.path
      snap.pendingLoad = data.content
      snap.dirty = false
      snap.documentRevision += 1
      snap.externalConflictPending = false
      snap.externalDiskContent = null
      renderTabStrip()
      return
    }
    applyLoadedContent(data.path, data.content)
  })
  api.onFileChanged((data) => {
    if (data.tabId !== activeTabId) {
      const snap = tabs.get(data.tabId)
      if (!snap) return
      if (snap.dirty) {
        // A background tab must never be clobbered by an external write; the
        // conflict decision is deferred until the tab becomes active again.
        snap.externalConflictPending = true
        snap.externalDiskContent = data.content
      } else {
        snap.pendingLoad = data.content
        snap.documentRevision += 1
      }
      return
    }
    // An external edit landing while the user still has unsaved changes must
    // never clobber the editor, and plain autosave would silently overwrite
    // the external edit. Pause autosave and let the user choose explicitly.
    if (dirty) {
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
      return
    }
    if (sourceModeActive) {
      sourceEl().value = data.content
    } else {
      // An external write is not something the reader can undo into; making it
      // one undo step would also let a stray undo write stale content back.
      setMarkdownProgrammatically(data.content, true)
    }
    updateSourceToggle()
    updateWordCount()
    resetDirty()
    scheduleOutlineUpdate()
  })

  // --- Tab lifecycle, driven by the main process (docs/tabs-tech-design.md) ---
  api.onNewTab((tabId) => {
    const snap = createLocalSession(tabId)
    if (activeTabId === -1) {
      // First tab of the window: the editor already shows its startup content.
      // file-opened may have arrived first (its queue flushes earlier) and
      // parked content here; apply it now.
      activeTabId = tabId
      if (snap.pendingLoad !== null) {
        const content = snap.pendingLoad
        snap.pendingLoad = null
        applyLoadedContent(snap.filePath, content)
      }
      renderTabStrip()
      updateTabBarVisibility()
      return
    }
    activateSession(tabId)
  })
  api.onTabClosed(({ closedTabId, activateTabId }) => {
    removeLocalSession(closedTabId)
    if (activateTabId !== null && tabs.has(activateTabId) && activateTabId !== activeTabId) {
      activateSession(activateTabId)
    }
    renderTabStrip()
    updateTabBarVisibility()
  })
  api.onActivateTab((tabId) => activateSession(tabId))
  newTabBtnEl().addEventListener('click', () => { void api.newTab() })

  api.onSetTheme((theme) => applyTheme(theme))
  api.onLanguageChanged((language: UiLanguage) => {
    setUiLanguage(language)
    searchPanel.setLanguage(language)
    setMathModalLanguage(language)
    updateUiLanguage()
  })
  api.onExternalConflictResult((result) => {
    if (result.action === 'load' && typeof result.content === 'string') {
      applyContent(result.content)
      resetDirty()
      updateWordCount()
      scheduleOutlineUpdate()
      const snap = tabs.get(activeTabId)
      if (snap) {
        snap.externalDiskContent = null
        snap.pendingLoad = null
      }
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