import { Plugin, PluginKey, type SelectionBookmark, TextSelection } from '@milkdown/kit/prose/state'
import { Fragment, Slice, DOMParser as ProseMirrorDOMParser } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { ImportedImage } from '../../image-types'

const key = new PluginKey<Map<object, SelectionBookmark>>('image-insertion')
export const imageInsertionPlugin = $prose(() => new Plugin({
  key,
  state: {
    init: () => new Map(),
    apply(tr, previous) {
      const meta = tr.getMeta(key)
      if (meta?.clear) return new Map()
      const next = new Map<object, SelectionBookmark>()
      for (const [id, bookmark] of previous) next.set(id, bookmark.map(tr.mapping))
      if (meta?.add) next.set(meta.add, (meta.selection ?? tr.selection).getBookmark())
      if (meta?.remove) next.delete(meta.remove)
      return next
    }
  }
}))

export function clearImageInsertions(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, { clear: true }))
}

export function captureImageInsertion(view: EditorView, position?: number): { insert: (images: ImportedImage[], html?: string) => boolean; cancel: () => void } {
  const id = {}
  const selection = position === undefined ? view.state.selection : TextSelection.near(view.state.doc.resolve(position))
  view.dispatch(view.state.tr.setMeta(key, { add: id, selection }))
  const cancel = (): void => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { remove: id })) }
  return {
    cancel,
    insert(images, html) {
      if (view.isDestroyed) return false
      const bookmark = key.getState(view.state)?.get(id)
      if (!bookmark) return false
      const nodeType = view.state.schema.nodes.image
      if (!nodeType || (!images.length && !html)) { cancel(); return false }
      let slice: Slice
      if (html) {
        const dom = new DOMParser().parseFromString(html, 'text/html')
        const originals = [...dom.querySelectorAll('img[src]')]
        for (const image of images) originals[image.inputIndex ?? -1]?.setAttribute('src', image.src)
        slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(dom.body)
      } else {
        const nodes = images.map(({ src, alt }) => nodeType.create({ src, alt }))
        slice = new Slice(Fragment.fromArray(nodes), 0, 0)
      }
      const tr = view.state.tr.setSelection(bookmark.resolve(view.state.doc))
        .replaceSelection(slice).setMeta(key, { remove: id }).scrollIntoView()
      view.dispatch(tr)
      view.focus()
      return true
    }
  }
}
