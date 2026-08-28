import { createEditor, getMarkdown, setMarkdown, showMathModal } from './editor/editor'
import { SearchPanel } from './editor/search-panel'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
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
const fileTitleEl = () => document.getElementById('file-title') as HTMLElement
const saveStatusEl = () => document.getElementById('save-status') as HTMLElement
const updateBannerEl = () => document.getElementById('update-banner') as HTMLElement
const updateBannerTextEl = () => document.getElementById('update-banner-text') as HTMLElement
const updateBannerActionEl = () => document.getElementById('update-banner-action') as HTMLButtonElement

// --- Same-directory file panel ---
let currentFilePath: string | null = null
let dirty = false
// Programmatic Markdown replacement dispatches a synchronous ProseMirror
// transaction. Suppress only that transaction, never a time window of input.
let applyingProgrammaticChange = false
// Fresh installs start focused on the document. Once changed, the user's
// explicit panel preference is preserved.
let manualHidden = localStorage.getItem('file-panel-hidden') !== '0'
let panelMode: 'files' | 'outline' = 'files'
let outlineUpdateQueued = false

function setMarkdownProgrammatically(content: string): void {
  applyingProgrammaticChange = true
  try {
    setMarkdown(content)
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

function showSaveStatus(state: 'dirty' | 'saved'): void {
  const el = saveStatusEl()
  if (!el) return
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  if (state === 'dirty') {
    el.textContent = '未保存'
    el.classList.remove('saved')
    el.classList.add('pending')
  } else {
    el.textContent = '已保存'
    el.classList.remove('pending')
    el.classList.add('saved')
    saveStatusTimer = setTimeout(() => {
      el.classList.remove('saved')
      el.textContent = ''
    }, 2000)
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
  const path = await enqueueSave(() => window.electronAPI.saveFile(content, filePath))
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
  const path = await enqueueSave(() => saveAs
    ? window.electronAPI.saveFileAs(content, expectedPath ?? undefined)
    : window.electronAPI.saveFile(content, expectedPath ?? undefined))
  if (!path || currentFilePath !== expectedPath) return false

  currentFilePath = path
  updateFileTitle()
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
  setContent(content)
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
  tip.textContent = `${countCharacters(text)} 字 · ${countTokens(text)} 词 · ${countParagraphs(text)} 段`
}

// --- Markdown source / WYSIWYG toggle ---
function updateSourceToggle(): void {
  const btn = sourceToggleBtnEl()
  btn.classList.toggle('active', sourceModeActive)
  const label = sourceModeActive
    ? '切换回所见即所得'
    : '切换 Markdown 源码'
  btn.setAttribute('aria-label', label)
  const tip = btn.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
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

function renderOutline(): void {
  const list = outlineListEl()
  const items = sourceModeActive ? sourceOutline(sourceEl().value) : visualOutline()
  list.innerHTML = ''
  if (items.length === 0) return
  for (const item of items) {
    const entry = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = item.title
    button.style.paddingLeft = `${8 + (item.level - 1) * 12}px`
    button.addEventListener('click', () => {
      if (item.element) {
        item.element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else if (item.line !== undefined) {
        const source = sourceEl()
        const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
        source.scrollTop = Math.max(0, item.line * lineHeight - lineHeight)
        source.focus()
      }
    })
    entry.appendChild(button)
    list.appendChild(entry)
  }
}

function scheduleOutlineUpdate(): void {
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

function updateFileTitle(): void {
  const name = currentFilePath ? (currentFilePath.split(/[\\/]/).pop() || currentFilePath) : '未命名'
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
    btn.title = f.kind === 'directory' ? `打开 ${f.name}` : f.kind === 'parent' ? '返回上级目录' : f.name
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

function setContent(content: string): void {
  exitSourceMode()
  setMarkdownProgrammatically(content)
  updateWordCount()
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
  const savedTheme = loadSavedTheme()
  applyTheme(savedTheme)
  applyEditorFont(loadSavedEditorFont())

  if (savedTheme.startsWith('custom:')) {
    const fileName = savedTheme.slice(7)
    const css = await api.loadThemeCSS(fileName)
    if (css) applyTheme(savedTheme, css)
  }

  const searchPanel = new SearchPanel()
  api.onSearch(() => searchPanel.show())
  api.onMathModal(() => showMathModal())

  await createEditor('editor', (markdown) => {
    updateWordCount(markdown)
  }, () => {
    if (!applyingProgrammaticChange) setDirty()
    scheduleOutlineUpdate()
  })
  updateWordCount()

  // Main asks for an authoritative snapshot before any close or quit.
  api.onRequestDocumentState((requestId) => {
    window.electronAPI.respondDocumentState(requestId, { dirty, content: getContent() })
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

  api.onSiblingsChanged((files) => renderFileList(files))
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

  api.onNewFile(() => { exitSourceMode(); applyContent('') })
  api.onFileOpened((data) => {
    currentFilePath = data.path
    resetDirty()
    setContent(data.content)
    updateFileTitle()
    updatePanelVisibility()
    refreshSiblings()
    scheduleOutlineUpdate()
  })
  api.onFileChanged((content) => {
    if (sourceModeActive) {
      sourceEl().value = content
    } else {
      setMarkdownProgrammatically(content)
    }
    updateSourceToggle()
    updateWordCount()
    resetDirty()
    scheduleOutlineUpdate()
  })

  api.onSetTheme((theme) => applyTheme(theme))
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
      ? `新版本 v${version} 已就绪`
      : `发现新版本 v${version}`
    updateBannerActionEl().textContent = updateDownloaded ? '重启安装' : '更新'
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

  updateBannerActionEl().addEventListener('click', async () => {
    if (updateDownloaded) {
      await api.installUpdate()
    } else {
      updateBannerActionEl().textContent = '下载中…'
      updateBannerActionEl().disabled = true
      await api.downloadUpdate()
    }
  })
  document.getElementById('update-banner-dismiss')!.addEventListener('click', () => {
    updateBannerEl().hidden = true
  })

  const agentDot = document.getElementById('agent-dot')
  api.onAgentActivity((state) => {
    if (!agentDot) return
    agentDot.className = state === 'idle' ? '' : state
    const label = state === 'active'
      ? 'Agent 正在修改文档'
      : state === 'cooldown'
        ? 'Agent 刚刚完成修改'
        : 'Agent 状态'
    agentDot.setAttribute('aria-label', label)
    const tip = agentDot.querySelector('.toolbar-tip')
    if (tip) tip.textContent = label
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