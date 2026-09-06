import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

const key = new PluginKey<DecorationSet>('inline-image-source')

// A widget belongs to the editor's layout, but never to the Markdown document.
// Let ProseMirror own it so redraws, undo and document switches remove it safely.
export const imageSourcePlugin = $prose(() => new Plugin({
  key,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, previous) {
      return tr.getMeta(key) ?? (tr.docChanged ? DecorationSet.empty : previous)
    }
  },
  props: { decorations: (state) => key.getState(state) }
}))

export function mountImageSource(view: EditorView, position: number, size: number, dom: HTMLElement, onClose: () => void): () => void {
  const decorations = DecorationSet.create(view.state.doc, [
    Decoration.node(position, position + size, { class: 'image-source-selected' }),
    Decoration.widget(position, dom, { side: -1, stopEvent: () => true, ignoreSelection: true, destroy: onClose })
  ])
  view.dispatch(view.state.tr.setMeta(key, decorations))
  return () => {
    if (!view.isDestroyed && key.getState(view.state) === decorations) {
      view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty))
    }
  }
}

export function clearImageSource(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty))
}
