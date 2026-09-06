import { $view } from '@milkdown/kit/utils'
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'

import { openLightbox } from './lightbox'
import { saveImageToAssets } from './core'

// Node view for markdown `![](src)` images. The wrapper is our own DOM, so
// loading/error state can be rendered without tripping ProseMirror's
// unexpected-mutation redraw (see the code-copy button note in editor.ts).
// Selection, drag and keyboard deletion stay with ProseMirror.
export const imageView = $view(imageSchema.node, (): NodeViewConstructor => {
  return (node, view: EditorView, getPos) => {
    const dom = document.createElement('span')
    dom.className = 'cmd-image'

    const img = document.createElement('img')
    img.src = node.attrs.src
    img.alt = node.attrs.alt ?? ''
    img.title = node.attrs.title || node.attrs.alt || ''
    img.draggable = false
    dom.appendChild(img)

    const errorBox = document.createElement('span')
    errorBox.className = 'cmd-image-error'
    const errorText = document.createElement('span')
    errorText.textContent = '图片无法加载'
    const relocateBtn = document.createElement('button')
    relocateBtn.type = 'button'
    relocateBtn.textContent = '重新选择文件'
    const revealBtn = document.createElement('button')
    revealBtn.type = 'button'
    revealBtn.textContent = '打开所在文件夹'
    errorBox.append(errorText, relocateBtn, revealBtn)
    dom.appendChild(errorBox)

    const markLoaded = (): void => {
      dom.classList.add('loaded')
      dom.classList.remove('broken')
    }
    img.addEventListener('load', markLoaded)
    img.addEventListener('error', () => {
      dom.classList.remove('loaded')
      dom.classList.add('broken')
    })
    if (img.complete && img.naturalWidth > 0) markLoaded()

    img.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openLightbox(img?.currentSrc || node.attrs.src, node.attrs.alt ?? '')
    })

    relocateBtn.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      const paths = await window.electronAPI.pickImages()
      if (!paths || paths.length === 0) return
      const asset = await saveImageToAssets({ srcPath: paths[0] })
      if (!asset) return
      const pos = typeof getPos === 'function' ? getPos() : null
      if (pos == null) return
      const current = view.state.doc.nodeAt(pos)
      if (!current || current.type.name !== 'image') return
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, src: asset.fileUrl }))
    })

    revealBtn.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      await window.electronAPI.revealPath(node.attrs.src)
    })

    return {
      dom,
      update(updated) {
        if (updated.type.name !== 'image') return false
        if (updated.attrs.src !== node.attrs.src) {
          dom.classList.remove('loaded', 'broken')
          if (img) img.src = updated.attrs.src
        }
        node = updated
        if (img) {
          if (img.alt !== updated.attrs.alt) img.alt = updated.attrs.alt ?? ''
          const title = updated.attrs.title || updated.attrs.alt || ''
          if (img.title !== title) img.title = title
        }
        if (img?.complete && img.naturalWidth > 0) markLoaded()
        return true
      },
      ignoreMutation: () => true,
      destroy() {
        // Nothing persistent — the img element dies with the dom.
      },
    }
  }
})
