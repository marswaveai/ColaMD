import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'
import { renderMermaid } from './mermaid-bridge'

const RENDER_DEBOUNCE_MS = 400

function isMermaid(node: { attrs: { language?: string } }): boolean {
  return String(node.attrs.language ?? '').trim().toLowerCase() === 'mermaid'
}

const mermaidViewConstructor: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('div')
  dom.className = 'colamd-code-block'

  const diagram = document.createElement('div')
  diagram.className = 'mermaid-diagram'
  diagram.hidden = true

  const pre = document.createElement('pre')
  const code = document.createElement('code')
  pre.appendChild(code)

  const error = document.createElement('div')
  error.className = 'mermaid-error'
  error.hidden = true

  dom.append(diagram, pre, error)

  let renderToken = 0
  let currentNode = node
  let editing = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const showSource = (): void => {
    diagram.hidden = true
    pre.hidden = false
    error.hidden = true
  }

  const renderNow = (target: typeof node): void => {
    const token = ++renderToken
    // Keep the previous SVG on screen during re-renders (no layout jump);
    // the first render simply shows the source until the SVG arrives.
    renderMermaid(target.textContent)
      .then((svg) => {
        if (token !== renderToken || editing) return
        diagram.innerHTML = svg
        diagram.hidden = false
        pre.hidden = true
        error.hidden = true
      })
      .catch((reason: Error) => {
        if (token !== renderToken || editing) return
        diagram.hidden = true
        pre.hidden = false
        error.textContent = `Mermaid 渲染失败：${reason.message}`
        error.hidden = false
      })
  }

  const scheduleRender = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (editing || !isMermaid(currentNode)) return
      if (!currentNode.textContent.trim()) {
        showSource()
        return
      }
      renderNow(currentNode)
    }, RENDER_DEBOUNCE_MS)
  }

  const exitEditMode = (): void => {
    if (!editing) return
    editing = false
    view?.dom.removeEventListener('mousedown', onOutsideMousedown, true)
    scheduleRender()
  }

  // Editing mode ends on any mousedown outside this block — covers plain
  // clicks elsewhere in the editor, which never trigger deselectNode
  // (that only fires when an actual NodeSelection moves away).
  const onOutsideMousedown = (event: MouseEvent): void => {
    if (dom.contains(event.target as Node)) return
    exitEditMode()
  }

  const enterEditMode = (): void => {
    if (editing) return
    editing = true
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    renderToken++
    showSource()
    view?.dom.addEventListener('mousedown', onOutsideMousedown, true)
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (view && pos != null) {
      // Move the caret into the source so typing edits it immediately
      // instead of replacing the whole node (NodeSelection hazard).
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))).scrollIntoView())
      view.focus()
    }
  }

  // Clicking the rendered diagram goes back to source editing.
  diagram.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    enterEditMode()
  })

  queueMicrotask(() => {
    if (isMermaid(currentNode)) scheduleRender()
  })

  return {
    dom,
    contentDOM: code,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) return false
      currentNode = nextNode
      if (editing) return true
      if (!isMermaid(nextNode)) {
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }
        renderToken++
        showSource()
        return true
      }
      scheduleRender()
      return true
    },
    selectNode: enterEditMode,
    deselectNode: exitEditMode,
    stopEvent: () => false,
    // Only contentDOM mutations are editor content. Anything else (SVG swaps
    // in the diagram area, error text) is view-internal — letting ProseMirror
    // see them makes it redraw the node view, which re-triggers rendering and
    // loops forever (this was the v1.7.4 CPU-storm mechanism).
    ignoreMutation: (mutation) => mutation.target !== code && !code.contains(mutation.target),
    destroy() {
      if (debounceTimer) clearTimeout(debounceTimer)
      renderToken++
      view?.dom.removeEventListener('mousedown', onOutsideMousedown, true)
    },
  }
}

// This view keeps ordinary code blocks as editable pre/code nodes and only
// replaces Mermaid blocks with a sandbox-rendered SVG when rendering succeeds.
export const mermaidView = $view(codeBlockSchema.node, () => mermaidViewConstructor)
