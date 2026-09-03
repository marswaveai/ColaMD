import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import remarkBreaks from 'remark-breaks'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { replaceAll, $prose } from '@milkdown/kit/utils'
import { remarkMathPlugin, katexOptionsCtx, mathInlineSchema, mathBlockSchema } from '@milkdown/plugin-math'
import { htmlView } from './html-view'
import { mermaidView } from './mermaid-view'
import { mathModal } from './math-modal'
import { highlight, remarkHighlight, highlightStringifyHandler } from './highlight'
import { revealElementInPagedLayout } from './page-layout'

import 'katex/dist/katex.min.css'
import '@milkdown/kit/prose/view/style/prosemirror.css'

export const searchPluginKey = new PluginKey('search-highlight')

// --- Heading anchors for intra-document links (#50) ---

// GitHub-style heading slug: lowercase, strip punctuation (CJK and letters
// survive), spaces become hyphens. Repeated slugs get -1, -2 … suffixes.
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

function headingAnchorMap(root: HTMLElement): Map<string, Element> {
  const map = new Map<string, Element>()
  const seen = new Map<string, number>()
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const base = slugifyHeading(heading.textContent || '')
    if (!base) return
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const slug = count === 0 ? base : `${base}-${count}`
    map.set(slug.toLowerCase(), heading)
  })
  return map
}

function findHeadingAnchor(root: HTMLElement, rawTarget: string): Element | null {
  let decoded = rawTarget
  try {
    decoded = decodeURIComponent(rawTarget)
  } catch {
    // Malformed percent-encoding — fall back to the raw text.
  }
  const map = headingAnchorMap(root)
  return (
    map.get(decoded.toLowerCase()) ??
    map.get(slugifyHeading(decoded).toLowerCase()) ??
    null
  )
}

const searchHighlight = $prose(() => {
  return new Plugin({
    key: searchPluginKey,
    state: {
      init() {
        return DecorationSet.empty
      },
      apply(tr, old) {
        const meta = tr.getMeta(searchPluginKey)
        if (meta !== undefined) return meta
        return old.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return searchPluginKey.getState(state)
      }
    }
  })
})

const mathEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'math_inline' || node.type.name === 'math_block') {
          const isBlock = node.type.name === 'math_block'
          const currentValue = isBlock ? node.attrs.value : node.textContent
          mathModal.show(currentValue, isBlock, nodePos)
          return true
        }
        return false
      }
    }
  })
})

export function showMathModal(): void {
  mathModal.show()
}

let editorInstance: Editor | null = null

const inlineStyles: Record<string, string> = {
  'h1': 'font-size:1.8em;margin:1em 0 .5em;padding-bottom:.3em;border-bottom:1px solid #eee;',
  'h2': 'font-size:1.4em;margin:1em 0 .5em;padding-bottom:.25em;border-bottom:1px solid #eee;',
  'h3': 'font-size:1.2em;margin:.8em 0 .4em;',
  'h4': 'margin:.8em 0 .4em;',
  'h5': 'margin:.8em 0 .4em;',
  'h6': 'margin:.8em 0 .4em;',
  'p': 'margin:.5em 0;line-height:1.75;',
  'strong': 'font-weight:600;',
  'a': 'color:#0969da;text-decoration:none;',
  'code': 'background:rgba(175,184,193,0.2);padding:2px 6px;border-radius:3px;font-size:.875em;font-family:Menlo,Monaco,monospace;',
  'pre': 'background:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;margin:1em 0;',
  'blockquote': 'border-left:4px solid #ddd;padding-left:16px;margin:1em 0;color:#666;',
  'ul': 'padding-left:24px;margin:.5em 0;',
  'ol': 'padding-left:24px;margin:.5em 0;',
  'li': 'margin:.25em 0;',
  'table': 'border-collapse:collapse;width:100%;margin:1em 0;',
  'th': 'border:1px solid #ddd;padding:8px 12px;text-align:left;background:#f6f8fa;',
  'td': 'border:1px solid #ddd;padding:8px 12px;text-align:left;',
  'hr': 'border:none;border-top:2px solid #ddd;margin:2em 0;',
  'img': 'max-width:100%;',
}

function enhanceClipboard(e: ClipboardEvent): void {
  const html = e.clipboardData?.getData('text/html')
  if (!html) return

  const doc = new DOMParser().parseFromString(html, 'text/html')

  for (const [tag, style] of Object.entries(inlineStyles)) {
    doc.querySelectorAll(tag).forEach((el) => {
      ;(el as HTMLElement).setAttribute('style', style)
    })
  }

  // pre > code: override code style inside code blocks
  doc.querySelectorAll('pre code').forEach((el) => {
    ;(el as HTMLElement).setAttribute('style', 'background:none;padding:0;font-size:.875em;line-height:1.6;font-family:Menlo,Monaco,monospace;')
  })

  e.clipboardData?.setData('text/html', doc.body.innerHTML)
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

// Code-block copy button: ONE overlay button rendered OUTSIDE the
// ProseMirror-managed DOM. ProseMirror re-syncs the DOM it owns from its
// document state, so inserting UI nodes inside <pre> gets wiped (or previously
// triggered an infinite rebuild loop — observed as 100% CPU with any fenced
// code block). No MutationObserver is used to avoid self-triggering loops;
// instead the button follows the hovered block and repositions on scroll.
let copyButton: HTMLButtonElement | null = null
let copyButtonPre: HTMLPreElement | null = null
let copyButtonResetTimer: ReturnType<typeof setTimeout> | null = null

function editorRect(): DOMRect {
  return (document.getElementById('editor') as HTMLElement).getBoundingClientRect()
}

function positionCopyButton(pre: HTMLPreElement): void {
  if (!copyButton) return
  const editor = document.getElementById('editor') as HTMLElement
  const rect = pre.getBoundingClientRect()
  const base = editorRect()
  // The button is absolutely positioned inside the scroll container #editor, so
  // its top/left are measured from the scroll-content origin, not from the
  // editor's border box. Add the scroll offsets so it tracks the block.
  copyButton.style.left = `${rect.left - base.left + editor.scrollLeft + rect.width - 8}px`
  copyButton.style.top = `${rect.top - base.top + editor.scrollTop + 8}px`
}

function createCopyButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'code-copy-btn'
  button.textContent = '复制'
  button.title = '复制代码'
  button.setAttribute('aria-label', '复制代码')
  button.style.position = 'absolute'
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!copyButtonPre) return
    const code = copyButtonPre.querySelector('code')?.textContent ?? ''
    try {
      await copyText(code)
      button.textContent = '已复制 ✓'
      button.classList.add('copied')
      if (copyButtonResetTimer) clearTimeout(copyButtonResetTimer)
      copyButtonResetTimer = setTimeout(() => {
        button.textContent = '复制'
        button.classList.remove('copied')
      }, 1500)
    } catch {
      button.textContent = '复制失败'
      if (copyButtonResetTimer) clearTimeout(copyButtonResetTimer)
      copyButtonResetTimer = setTimeout(() => { button.textContent = '复制' }, 1500)
    }
  })
  document.getElementById('editor')?.appendChild(button)
  return button
}

function setupCodeBlockCopy(root: HTMLElement): void {
  copyButton = createCopyButton()
  const btn = copyButton

  const inButton = (node: Node | null): boolean =>
    !!node && (node === btn || btn.contains(node))

  const showFor = (pre: HTMLPreElement): void => {
    copyButtonPre = pre
    btn.classList.add('hovering')
    positionCopyButton(pre)
  }

  const hide = (): void => {
    copyButtonPre = null
    btn.classList.remove('hovering')
  }

  const positionActive = (): void => {
    if (copyButtonPre) positionCopyButton(copyButtonPre)
  }

  // Show the copy button when the pointer enters a fenced code block.
  root.addEventListener('mouseover', (event) => {
    if (inButton(event.target as Node)) return
    const pre = (event.target as Element | null)?.closest?.('pre') as HTMLPreElement | null
    if (pre && pre.querySelector('code')) showFor(pre)
  })

  // Keep the button visible until the pointer leaves BOTH the block and the
  // button. The button is a sibling overlay sitting on top of the <pre>, so
  // hovering it makes `pre:hover` false — we must not gate visibility on
  // `:hover` or the button disappears mid-interaction (original bug).
  root.addEventListener('mouseout', (event) => {
    const from = (event.target as Element | null)?.closest?.('pre') as HTMLPreElement | null
    if (!from || from !== copyButtonPre) return
    const to = event.relatedTarget as Node | null
    if (inButton(to)) return
    if (to && from.contains(to)) return
    hide()
  })

  btn.addEventListener('mouseout', (event) => {
    const to = event.relatedTarget as Node | null
    if (copyButtonPre && to && copyButtonPre.contains(to)) return
    hide()
  })

  // #editor is the scroll container; reposition when the block moves.
  root.addEventListener('scroll', positionActive, { passive: true })
  // Paged layouts scroll the centered Milkdown stage horizontally while the
  // outer editor remains fixed, so follow that inner scroller as well.
  root.querySelector(':scope > .milkdown')?.addEventListener('scroll', positionActive, { passive: true })
  window.addEventListener('scroll', positionActive, { passive: true })
  const resizeObserver = new ResizeObserver(positionActive)
  resizeObserver.observe(root)
}

function toggleStrongMark(): void {
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const { from, to, empty } = view.state.selection
    if (empty) return
    const strong = view.state.schema.marks.strong
    if (!strong) return
    const transaction = view.state.doc.rangeHasMark(from, to, strong)
      ? view.state.tr.removeMark(from, to, strong)
      : view.state.tr.addMark(from, to, strong.create())
    view.dispatch(transaction)
  })
}

const defaultContent = navigator.language.toLowerCase().startsWith('zh')
  ? '# **欢迎使用 ColaMD**\n\n开始写作...\n'
  : '# **Welcome to ColaMD**\n\nStart typing here...\n'

export async function createEditor(
  rootId: string,
  onChange?: (markdown: string) => void,
  onDocumentChange?: () => void
): Promise<Editor> {
  const root = document.getElementById(rootId)
  if (!root) throw new Error(`Element #${rootId} not found`)

  const documentChangePlugin = onDocumentChange
    ? $prose(() => new Plugin({
      state: {
        init: () => null,
        apply(tr, value) {
          if (tr.docChanged) onDocumentChange()
          return value
        }
      }
    }))
    : null

  setupCodeBlockCopy(root)

  let editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, defaultContent)
      ctx.set(remarkPluginsCtx, [
        { plugin: remarkBreaks, options: {} },
        { plugin: remarkHighlight, options: {} },
      ])
      ctx.set(katexOptionsCtx.key, { throwOnError: false })
      // Teach remark-stringify how to emit our custom ==highlight== node
      const stringifyOptions = ctx.get(remarkStringifyOptionsCtx)
      ctx.set(remarkStringifyOptionsCtx, {
        ...stringifyOptions,
        // Keep the editor's smart line breaks as plain Markdown newlines.
        // remark-breaks restores them on parse, so source mode never leaks `\`.
        handlers: {
          ...stringifyOptions.handlers,
          mark: highlightStringifyHandler,
          break: () => '\n'
        } as typeof stringifyOptions.handlers,
      })
      if (onChange) {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChange(markdown)
        })
      }
    })
    .use(commonmark)
    .use(gfm)
    .use(highlight)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(htmlView)
    .use(mermaidView)
    .use([remarkMathPlugin, katexOptionsCtx, mathInlineSchema, mathBlockSchema].flat())
    .use(mathEditorPlugin)
    .use(searchHighlight)

  if (documentChangePlugin) editor = editor.use(documentChangePlugin)
  editorInstance = await editor.create()

  // Enhance clipboard with inline styles for rich text paste (e.g. WeChat)
  root.addEventListener('copy', enhanceClipboard)
  root.addEventListener('cut', enhanceClipboard)

  // Cmd/Ctrl+B toggles the strong mark for an existing selection. This keeps
  // basic formatting editable without adding a permanent toolbar.
  root.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'b') return
    e.preventDefault()
    toggleStrongMark()
  })

  // Intra-document anchor links are pure navigation: handle them in the
  // capture phase and keep ProseMirror out, so placing the caret (and its
  // async scroll-to-selection) can't override the heading jump (#50).
  root.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href')
    if (!href || !href.startsWith('#')) return
    e.preventDefault()
    e.stopPropagation()
    const heading = findHeadingAnchor(root, href.slice(1))
    if (heading instanceof HTMLElement && !revealElementInPagedLayout(heading)) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, true)

  // Cmd/Ctrl+click (Mac/Win/Linux) opens other links in the browser.
  root.addEventListener('click', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href')
    if (href && !href.startsWith('#')) {
      e.preventDefault()
      window.electronAPI.openExternal(href)
    }
  })

  // Click the checkbox of a task list item to toggle its checked state
  root.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLElement)) return
    const li = e.target.closest('li[data-item-type="task"]') as HTMLElement | null
    if (!li) return
    // Only the checkbox area toggles — clicks on the text still place the cursor
    const rect = li.getBoundingClientRect()
    if (e.clientX - rect.left > 24) return
    e.preventDefault()
    toggleTaskListItem(e)
  })

  // Cmd/Ctrl+Enter toggles the task list item under the cursor
  root.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
    e.preventDefault()
    if (!editorInstance) return
    editorInstance.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const $pos = view.state.doc.resolve(view.state.selection.from)
      for (let d = $pos.depth; d >= 0; d--) {
        const node = $pos.node(d)
        if (node.type.name === 'list_item' && node.attrs.checked != null) {
          const tr = view.state.tr.setNodeMarkup($pos.before(d), undefined, {
            ...node.attrs,
            checked: !node.attrs.checked,
          })
          view.dispatch(tr)
          return
        }
      }
    })
  })

  return editorInstance
}

function toggleTaskListItem(e: MouseEvent): void {
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    // posAtDOM(li, 0) lands inside the li (on its first child), not on the
    // list_item node itself — locate by click coordinates instead and walk up
    // the tree, same as the ⌘+Enter path.
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!coords) return
    const $pos = view.state.doc.resolve(coords.pos)
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d)
      if (node.type.name === 'list_item' && node.attrs.checked != null) {
        const tr = view.state.tr.setNodeMarkup($pos.before(d), undefined, {
          ...node.attrs,
          checked: !node.attrs.checked,
        })
        view.dispatch(tr)
        return
      }
    }
  })
}

export function getMarkdown(): string {
  if (!editorInstance) return ''
  let markdown = ''
  editorInstance.action((ctx) => {
    const serializer = ctx.get(serializerCtx)
    const view = ctx.get(editorViewCtx)
    markdown = serializer(view.state.doc)
  })
  return markdown
}

export function setMarkdown(content: string): void {
  if (!editorInstance) return
  editorInstance.action(replaceAll(content))
}

export function getEditorView(): EditorView | null {
  if (!editorInstance) return null
  let view: EditorView | null = null
  editorInstance.action((ctx) => {
    view = ctx.get(editorViewCtx)
  })
  return view
}
