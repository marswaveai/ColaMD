import mermaid from 'mermaid'

// Runs inside the hidden sandbox iframe. Mermaid is statically imported here so
// it is bundled into this entry's chunk only — the main app never loads it.

type RenderRequest = { type: 'render'; id: number; code: string; theme: 'default' | 'dark'; bg?: string }

const BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict' as const,
  // The sandbox iframe has no inherited app fonts; without an explicit CJK-capable
  // family Mermaid measures CJK labels too small and clips them vertically.
  fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  themeCSS: `
    .nodeLabel { line-height: 1.45; padding: 2px 3px; }
    .edgeLabel { line-height: 1.45; padding: 1px 3px; }
  `,
}

mermaid.initialize({ ...BASE_CONFIG, theme: 'default' })

window.addEventListener('message', (event) => {
  const data = event.data as RenderRequest | undefined
  if (!data || data.type !== 'render' || typeof data.id !== 'number' || typeof data.code !== 'string') return

  // Edge labels carry a masking background by default; match it to the editor's
  // code-block background so labels don't show up as stray blocks.
  mermaid.initialize({
    ...BASE_CONFIG,
    theme: data.theme === 'dark' ? 'dark' : 'default',
    themeVariables: { edgeLabelBackground: data.bg || 'transparent' },
  })
  mermaid.render(`mermaid-sandbox-${data.id}`, data.code)
    .then(({ svg }) => {
      window.parent.postMessage({ type: 'result', id: data.id, ok: true, svg }, '*')
    })
    .catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      window.parent.postMessage({ type: 'result', id: data.id, ok: false, error: message }, '*')
    })
})

window.parent.postMessage({ type: 'ready' }, '*')
