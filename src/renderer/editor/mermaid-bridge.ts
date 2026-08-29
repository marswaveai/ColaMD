// Single hidden iframe that owns Mermaid rendering. Mermaid runs in the
// sandbox document (its own chunk), keeping the main bundle and main thread
// free of it. The iframe is created lazily on the first Mermaid block.

const DARK_THEME_CLASSES = new Set([
  'theme-dark',
  'theme-solarized-dark',
  'theme-nord',
  'theme-gruvbox',
  'theme-dracula',
  'theme-midnight',
])

const RENDER_TIMEOUT_MS = 15_000

type Pending = {
  resolve: (svg: string) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type SandboxMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; svg: string }
  | { type: 'result'; id: number; ok: false; error: string }

let iframe: HTMLIFrameElement | null = null
let ready = false
let nextRenderId = 0
const pending = new Map<number, Pending>()
type QueuedRender = { run: () => void; reject: (reason: Error) => void }

const waitingForReady: QueuedRender[] = []

function currentTheme(): 'default' | 'dark' {
  for (const cls of DARK_THEME_CLASSES) {
    if (document.body.classList.contains(cls)) return 'dark'
  }
  return 'default'
}

// Diagrams render on the code-block background, which can disagree with the
// app theme's overall brightness (elegant/bear are light themes with dark
// code blocks). Pick the Mermaid palette by background luminance instead.
function mermaidThemeForBackground(bg: string): 'default' | 'dark' {
  const match = bg.trim().match(/^#([0-9a-f]{6})$/i)
  if (!match) return currentTheme()
  const value = parseInt(match[1], 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'default'
}

function rejectAllPending(reason: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(reason)
  }
  pending.clear()
}

// A hung render (e.g. known Mermaid gantt OOM cases) must not poison later
// ones: destroy the sandbox wholesale and let the next request rebuild it.
function destroyIframe(): void {
  if (iframe) {
    iframe.remove()
    iframe = null
  }
  ready = false
  // Queued requests never reached `pending`, so reject them here too or their
  // promises never settle and the blocks hang on the source view forever.
  const queued = waitingForReady.splice(0)
  for (const entry of queued) entry.reject(new Error('渲染超时，已重置渲染器'))
}

function ensureIframe(): void {
  if (iframe) return
  iframe = document.createElement('iframe')
  // Not display:none — hidden iframes still need layout for text measurement,
  // otherwise rendered SVGs come out with zero size.
  iframe.style.position = 'fixed'
  iframe.style.left = '-9999px'
  iframe.style.width = '1024px'
  iframe.style.height = '768px'
  iframe.style.visibility = 'hidden'
  iframe.style.border = '0'
  iframe.src = './mermaid-sandbox.html'
  document.body.appendChild(iframe)
}

function dispatchRender(code: string, resolve: (svg: string) => void, reject: (reason: Error) => void): void {
  const id = ++nextRenderId
  const timer = setTimeout(() => {
    pending.delete(id)
    rejectAllPending(new Error('渲染超时，已重置渲染器'))
    destroyIframe()
  }, RENDER_TIMEOUT_MS)
  pending.set(id, { resolve, reject, timer })
  const bg = getComputedStyle(document.body).getPropertyValue('--code-block-bg').trim()
  iframe?.contentWindow?.postMessage({ type: 'render', id, code, theme: mermaidThemeForBackground(bg), bg }, '*')
}

window.addEventListener('message', (event) => {
  if (!iframe || event.source !== iframe.contentWindow) return
  const data = event.data as SandboxMessage | undefined
  if (!data) return

  if (data.type === 'ready') {
    ready = true
    const queued = waitingForReady.splice(0)
    for (const entry of queued) entry.run()
    return
  }

  if (data.type === 'result') {
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    clearTimeout(entry.timer)
    if (data.ok) entry.resolve(data.svg)
    else entry.reject(new Error(data.error || '语法错误'))
  }
})

export function renderMermaid(code: string): Promise<string> {
  ensureIframe()
  return new Promise<string>((resolve, reject) => {
    if (ready) {
      dispatchRender(code, resolve, reject)
    } else {
      waitingForReady.push({ run: () => dispatchRender(code, resolve, reject), reject })
    }
  })
}