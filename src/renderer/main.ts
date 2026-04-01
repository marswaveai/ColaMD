import { sanitizeHTMLFragment } from './editor/sanitize'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
import './themes/base.css'

function ensureErrorToast(): HTMLElement {
  let toast = document.getElementById('error-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'error-toast'
    document.body.appendChild(toast)
  }
  return toast
}

let errorToastTimer: ReturnType<typeof setTimeout> | null = null

function showError(message: string): void {
  const toast = ensureErrorToast()
  toast.textContent = message
  toast.classList.add('visible')
  if (errorToastTimer) clearTimeout(errorToastTimer)
  errorToastTimer = setTimeout(() => {
    toast.classList.remove('visible')
    errorToastTimer = null
  }, 4200)
}

interface AgentChangeEntry {
  id: number
  summary: string
  timestamp: number
  targetText: string | null
}

const MAX_AGENT_CHANGES = 5

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  if (diffMs < 10_000) return 'just now'
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}d ago`
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim())
}

function normalizeLine(line: string): string {
  return line.trim()
}

function countLineOccurrences(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

function collectLineDiff(previousLines: string[], nextLines: string[]): { added: string[]; removed: string[] } {
  const previousCounts = countLineOccurrences(previousLines)
  const nextCounts = countLineOccurrences(nextLines)
  const added: string[] = []
  const removed: string[] = []

  for (const line of nextLines) {
    const count = previousCounts.get(line) ?? 0
    if (count > 0) {
      previousCounts.set(line, count - 1)
    } else {
      added.push(line)
    }
  }

  for (const line of previousLines) {
    const count = nextCounts.get(line) ?? 0
    if (count > 0) {
      nextCounts.set(line, count - 1)
    } else {
      removed.push(line)
    }
  }

  return { added, removed }
}

function findFirstChangedLineIndex(previousLines: string[], nextLines: string[]): number {
  const max = Math.max(previousLines.length, nextLines.length)
  for (let i = 0; i < max; i++) {
    if ((previousLines[i] ?? '') !== (nextLines[i] ?? '')) return i
  }
  return -1
}

function findHeadingContext(lines: string[], changedIndex: number): string | null {
  const safeIndex = Math.min(Math.max(changedIndex, 0), lines.length - 1)
  for (let i = safeIndex; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (isHeadingLine(line)) return line.slice(0, 80)
  }
  return null
}

function buildChangeLabel(addedCount: number, removedCount: number): string {
  if (addedCount > 0 && removedCount > 0) return 'Updated'
  if (addedCount > 0) return 'Added'
  if (removedCount > 0) return 'Removed'
  return 'Reworked'
}

function formatLineDelta(addedCount: number, removedCount: number): string {
  if (addedCount === 0 && removedCount === 0) return ''
  if (addedCount > 0 && removedCount > 0) return ` (+${addedCount}/-${removedCount} lines)`
  if (addedCount > 0) return ` (+${addedCount} lines)`
  return ` (-${removedCount} lines)`
}

function analyzeAgentChange(previous: string, next: string): { summary: string; targetText: string | null } {
  const previousLines = previous.split('\n').map(normalizeLine).filter(Boolean)
  const nextLines = next.split('\n').map(normalizeLine).filter(Boolean)
  const { added, removed } = collectLineDiff(previousLines, nextLines)
  const changedIndex = findFirstChangedLineIndex(previousLines, nextLines)
  const headingContext = findHeadingContext(nextLines, changedIndex >= 0 ? changedIndex : nextLines.length - 1)
    ?? findHeadingContext(previousLines, changedIndex >= 0 ? changedIndex : previousLines.length - 1)
  const label = buildChangeLabel(added.length, removed.length)
  const lineDelta = formatLineDelta(added.length, removed.length)

  if (headingContext) {
    return {
      summary: `${label} ${headingContext}${lineDelta}`,
      targetText: headingContext.replace(/^#{1,6}\s+/, '')
    }
  }

  const firstAdded = added.find((line) => !isHeadingLine(line))
  if (firstAdded) {
    return {
      summary: `${label} paragraph: ${firstAdded.slice(0, 110)}${lineDelta}`,
      targetText: firstAdded
    }
  }

  const firstRemoved = removed.find((line) => !isHeadingLine(line))
  if (firstRemoved) {
    return {
      summary: `${label} paragraph: ${firstRemoved.slice(0, 110)}${lineDelta}`,
      targetText: firstRemoved
    }
  }

  return {
    summary: `Agent updated the document structure${lineDelta}`.trim(),
    targetText: null
  }
}

async function init(): Promise<void> {
  const api = window.electronAPI
  let currentMarkdown = ''
  let editorReady = false
  let pendingOpenedContent: string | null = null
  const pendingErrors: string[] = []
  let getMarkdown = () => ''
  let getHTML = () => ''
  let setMarkdown = (_content: string, _showDiff?: boolean) => {}
  let agentState: 'idle' | 'active' | 'cooldown' = 'idle'
  let lastAgentUpdateAt: number | null = null
  let agentUpdateCount = 0
  let agentChangeId = 0
  let agentChanges: AgentChangeEntry[] = []
  const savedTheme = loadSavedTheme()
  applyTheme(savedTheme)

  const agentStatus = document.getElementById('agent-status')
  const agentPanel = document.getElementById('agent-panel')
  const agentPanelToggle = document.getElementById('agent-panel-toggle') as HTMLButtonElement | null
  const agentSummary = document.getElementById('agent-summary')
  const agentChangeList = document.getElementById('agent-change-list')

  const jumpToAgentChange = (change: AgentChangeEntry): void => {
    const editorEl = document.getElementById('editor')
    const proseMirror = document.querySelector('#editor .ProseMirror')
    if (!editorEl || !proseMirror) return

    const children = Array.from(proseMirror.children) as HTMLElement[]
    const normalizedTarget = change.targetText?.trim().toLowerCase()
    let match: HTMLElement | null = null

    if (normalizedTarget) {
      match = children.find((child) => {
        const text = child.textContent?.trim().toLowerCase() ?? ''
        return text === normalizedTarget || text.startsWith(normalizedTarget) || text.includes(normalizedTarget)
      }) ?? null
    }

    if (!match) {
      match = children[0] ?? null
    }
    if (!match) return

    match.classList.remove('agent-change-target')
    editorEl.scrollTo({
      top: Math.max(match.offsetTop - 24, 0),
      behavior: 'smooth'
    })
    requestAnimationFrame(() => {
      match?.classList.add('agent-change-target')
      setTimeout(() => match?.classList.remove('agent-change-target'), 1800)
    })
  }

  const renderAgentUI = (): void => {
    if (agentStatus) {
      if (agentState === 'active') {
        agentStatus.textContent = 'Agent editing...'
      } else if (lastAgentUpdateAt) {
        agentStatus.textContent = `Updated ${formatRelativeTime(lastAgentUpdateAt)} • ${agentUpdateCount} sync${agentUpdateCount === 1 ? '' : 's'}`
      } else {
        agentStatus.textContent = 'Waiting for agent activity'
      }
    }

    if (agentSummary) {
      agentSummary.textContent = lastAgentUpdateAt
        ? `Last update ${formatRelativeTime(lastAgentUpdateAt)}`
        : 'No external updates yet'
    }

    if (agentChangeList) {
      agentChangeList.innerHTML = ''
      for (const change of agentChanges) {
        const item = document.createElement('li')
        const time = document.createElement('span')
        time.className = 'agent-change-time'
        time.textContent = formatRelativeTime(change.timestamp)
        const summary = document.createElement('button')
        summary.type = 'button'
        summary.className = 'agent-change-link'
        summary.addEventListener('click', () => jumpToAgentChange(change))
        summary.title = change.targetText ? `Jump to ${change.targetText}` : 'Jump to document'
        const summaryText = document.createElement('span')
        summaryText.className = 'agent-change-summary'
        summaryText.textContent = change.summary
        summary.appendChild(summaryText)
        item.append(time, summary)
        agentChangeList.appendChild(item)
      }
    }
  }

  const resetAgentTimeline = (): void => {
    agentState = 'idle'
    lastAgentUpdateAt = null
    agentUpdateCount = 0
    agentChangeId = 0
    agentChanges = []
    renderAgentUI()
  }

  agentPanelToggle?.addEventListener('click', () => {
    const open = agentPanel?.hidden ?? true
    if (agentPanel) agentPanel.hidden = !open
    if (agentPanelToggle) agentPanelToggle.setAttribute('aria-expanded', String(open))
  })

  setInterval(() => {
    if (lastAgentUpdateAt && agentState !== 'active') renderAgentUI()
  }, 30_000)
  renderAgentUI()

  api.onAppError(({ message }) => {
    if (!editorReady) {
      pendingErrors.push(message)
      return
    }
    showError(message)
  })

  api.onFileOpened((data) => {
    currentMarkdown = data.content
    if (!editorReady) {
      pendingOpenedContent = data.content
      return
    }
    resetAgentTimeline()
    setMarkdown(data.content)
  })

  // Restore custom theme CSS from disk
  if (savedTheme.startsWith('custom:')) {
    const fileName = savedTheme.slice(7)
    const css = await api.loadThemeCSS(fileName)
    if (css) applyTheme(savedTheme, css)
  }

  const editorModule = await import('./editor/editor')
  await editorModule.createEditor('editor', (markdown) => {
    currentMarkdown = markdown
  })
  getMarkdown = editorModule.getMarkdown
  getHTML = editorModule.getHTML
  setMarkdown = editorModule.setMarkdown
  editorReady = true
  currentMarkdown = getMarkdown()

  if (pendingOpenedContent !== null) {
    setMarkdown(pendingOpenedContent)
  }
  for (const message of pendingErrors) {
    showError(message)
  }

  api.onMenuOpen(async () => {
    const result = await api.openFile()
    if (result) {
      currentMarkdown = result.content
      resetAgentTimeline()
      setMarkdown(result.content)
    }
  })

  api.onMenuSave(() => api.saveFile(currentMarkdown))
  api.onMenuSaveAs(() => api.saveFileAs(currentMarkdown))
  api.onMenuExportPDF(() => api.exportPDF())

  api.onMenuExportHTML(() => {
    const s = getComputedStyle(document.body)
    const v = (name: string) => s.getPropertyValue(name).trim()
    const bgColor = v('--bg-color')
    const textColor = v('--text-color')
    const textMuted = v('--text-muted')
    const borderColor = v('--border-color')
    const linkColor = v('--link-color')
    const codeBg = v('--code-bg')
    const codeBlockBg = v('--code-block-bg')
    const codeBlockText = v('--code-block-text') || textColor
    const blockquoteBorder = v('--blockquote-border')
    const blockquoteBg = v('--blockquote-bg') || 'transparent'
    const tableHeaderBg = v('--table-header-bg')
    const selectionBg = v('--selection-bg')

    const editor = document.querySelector('#editor .ProseMirror')
    const fontFamily = editor ? getComputedStyle(editor).fontFamily : '-apple-system,BlinkMacSystemFont,sans-serif'

    const getElColor = (selector: string, fallback: string): string => {
      const el = document.querySelector(`#editor .ProseMirror ${selector}`)
      return el ? getComputedStyle(el).color : fallback
    }
    const strongColor = getElColor('strong', textColor)
    const codeColor = getElColor('code', textColor)

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ColaMD Export</title>
<style>
body{max-width:780px;margin:40px auto;padding:20px;font-family:${fontFamily};line-height:1.75;background:${bgColor};color:${textColor}}
h1{font-size:2em;font-weight:700;border-bottom:1px solid ${borderColor};padding-bottom:.3em}
h2{font-size:1.5em;font-weight:600;border-bottom:1px solid ${borderColor};padding-bottom:.25em}
h3{font-size:1.25em;font-weight:600}
strong{color:${strongColor}}
a{color:${linkColor};text-decoration:none}
code{background:${codeBg};color:${codeColor};padding:2px 6px;border-radius:3px;font-size:.875em;font-family:'SF Mono','Fira Code',Menlo,monospace}
pre{background:${codeBlockBg};color:${codeBlockText};padding:16px;border-radius:6px;overflow-x:auto;margin:1em 0}
pre code{background:none;padding:0;color:inherit}
blockquote{border-left:4px solid ${blockquoteBorder};background:${blockquoteBg};padding-left:16px;margin:1em 0;color:${textMuted}}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid ${borderColor};padding:8px 12px}
th{background:${tableHeaderBg};font-weight:600}
hr{border:none;border-top:2px solid ${borderColor};margin:2em 0}
img{max-width:100%}
::selection{background:${selectionBg}}
</style>
</head><body>${sanitizeHTMLFragment(getHTML())}</body></html>`
    api.exportHTML(html)
  })

  api.onNewFile(() => {
    currentMarkdown = ''
    pendingOpenedContent = null
    resetAgentTimeline()
    setMarkdown('')
  })

  // file-changed: show diff highlight for agent changes
  api.onFileChanged((content) => {
    if (content === currentMarkdown) return

    const previousMarkdown = currentMarkdown
    const editorEl = document.getElementById('editor')
    const scrollTop = editorEl?.scrollTop ?? 0
    currentMarkdown = content
    lastAgentUpdateAt = Date.now()
    agentUpdateCount += 1
    const changeInfo = analyzeAgentChange(previousMarkdown, content)
    agentChanges = [
      {
        id: ++agentChangeId,
        summary: changeInfo.summary,
        timestamp: lastAgentUpdateAt,
        targetText: changeInfo.targetText
      },
      ...agentChanges
    ].slice(0, MAX_AGENT_CHANGES)
    renderAgentUI()
    setMarkdown(content, true)
    requestAnimationFrame(() => {
      if (editorEl) editorEl.scrollTop = scrollTop
    })
  })

  api.onSetTheme((theme) => applyTheme(theme))
  api.onSetCustomCSS((css) => {
    const theme = loadSavedTheme()
    applyTheme(theme, css)
  })

  api.onMenuImportTheme(async () => {
    const result = await api.loadCustomTheme()
    if (result) applyTheme(`custom:${result.name}`, result.css)
  })

  const agentDot = document.getElementById('agent-dot')
  api.onAgentActivity((state) => {
    agentState = state as 'idle' | 'active' | 'cooldown'
    renderAgentUI()
    if (agentDot) agentDot.className = state === 'idle' ? '' : state
  })

  // Handle drag-and-drop of text files
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (!filePath) return
    const result = await api.openFilePath(filePath)
    if (result) {
      currentMarkdown = result.content
      resetAgentTimeline()
      setMarkdown(result.content)
    }
  })
}

init().catch((e) => console.error('ColaMD init failed:', e))
