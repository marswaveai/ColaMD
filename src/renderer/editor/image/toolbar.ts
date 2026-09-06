import { NodeSelection, Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

import { openLightbox } from './lightbox'
import { filePathFromFileUrl, saveImageToAssets } from './core'

// Floating image toolbar, modeled on the code-copy button in editor.ts: ONE
// overlay rendered OUTSIDE the ProseMirror-managed DOM, absolutely positioned
// inside the scroll container #editor. It appears when an image is selected
// (markdown `![](src)` via NodeSelection, or an inline-HTML <img> via click)
// and offers width presets, drag-resize, caption, replace/copy/reveal/delete.

interface NodeTarget {
  kind: 'node'
  pos: number
  img: HTMLImageElement
}

interface HtmlTarget {
  kind: 'html'
  img: HTMLImageElement
}

type Target = NodeTarget | HtmlTarget

const WIDTH_PRESETS = [1, 0.75, 0.5, 0.25]
const HANDLE_MIN_WIDTH = 48

let editorView: EditorView | null = null
let activeTarget: Target | null = null
let toolbar: HTMLDivElement | null = null
let captionRow: HTMLDivElement | null = null
let captionInput: HTMLInputElement | null = null
let resizeHandle: HTMLDivElement | null = null
let host: HTMLElement | null = null

function prosemirrorElement(): HTMLElement | null {
  return host?.querySelector('.ProseMirror') ?? null
}

function contentWidth(): number {
  return prosemirrorElement()?.clientWidth ?? 720
}

function currentImageWidth(img: HTMLImageElement): number {
  const attr = Number.parseInt(img.getAttribute('width') ?? '', 10)
  if (Number.isFinite(attr) && attr > 0) return attr
  return Math.round(img.getBoundingClientRect().width) || Math.round(contentWidth())
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface ImgAttrs {
  src: string
  alt: string
  title: string
}

function imgAttrsFromHtmlValue(value: string): ImgAttrs | null {
  const parsed = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html')
  const img = parsed.body.querySelector('img')
  if (!img) return null
  return {
    src: img.getAttribute('src') ?? '',
    alt: img.getAttribute('alt') ?? '',
    title: img.getAttribute('title') ?? '',
  }
}

function htmlValueFromAttrs(attrs: ImgAttrs, width: number | null): string {
  let html = `<img src="${escapeHtmlAttr(attrs.src)}"`
  if (attrs.alt) html += ` alt="${escapeHtmlAttr(attrs.alt)}"`
  if (attrs.title) html += ` title="${escapeHtmlAttr(attrs.title)}"`
  if (width != null) html += ` width="${width}"`
  return `${html}>`
}

function htmlValueSetWidth(value: string, width: number | null): string {
  const stripped = value.replace(/\s+width\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
  if (width == null) return stripped
  return stripped.replace(/>$/, ` width="${width}">`)
}

function htmlValueSetAlt(value: string, alt: string): string {
  const stripped = value.replace(/\s+alt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
  if (!alt) return stripped
  return stripped.replace(/>$/, ` alt="${escapeHtmlAttr(alt)}">`)
}

// Resolve the doc position of an inline-HTML <img>. The html node is a leaf,
// so posAtDOM lands at its start either way; verify with nodeAt to be safe.
function htmlNodeInfo(img: HTMLImageElement): { pos: number; value: string } | null {
  if (!editorView) return null
  try {
    const pos = editorView.posAtDOM(img, 0)
    const node = editorView.state.doc.nodeAt(pos)
    if (node && node.type.name === 'html') return { pos, value: String(node.attrs.value ?? '') }
    const before = editorView.state.doc.nodeAt(Math.max(0, pos - 1))
    if (before && before.type.name === 'html') {
      return { pos: Math.max(0, pos - 1), value: String(before.attrs.value ?? '') }
    }
  } catch {
    // Element left the document between interaction and action.
  }
  return null
}

function hideToolbar(): void {
  activeTarget = null
  if (toolbar) toolbar.hidden = true
  if (resizeHandle) resizeHandle.hidden = true
  if (captionRow) captionRow.hidden = true
}

function toolbarImage(): HTMLImageElement | null {
  return activeTarget?.img ?? null
}

function positionToolbar(): void {
  const img = toolbarImage()
  if (!img || !toolbar || !host || !img.isConnected) {
    hideToolbar()
    return
  }
  const base = host.getBoundingClientRect()
  const editor = host
  const rect = img.getBoundingClientRect()
  const top = rect.top - base.top + editor.scrollTop
  const left = rect.left - base.left + editor.scrollLeft
  toolbar.style.top = `${Math.max(4, top - 38)}px`
  toolbar.style.left = `${Math.max(4, left)}px`
  toolbar.style.maxWidth = `${Math.max(200, rect.width)}px`
  if (resizeHandle) {
    resizeHandle.style.top = `${top + rect.height - 6}px`
    resizeHandle.style.left = `${left + rect.width - 6}px`
  }
}

function bindNodeImage(view: EditorView, pos: number): void {
  const dom = view.nodeDOM(pos) as HTMLElement | null
  const img = dom instanceof HTMLElement ? dom.querySelector('img') : null
  if (!img) {
    hideToolbar()
    return
  }
  activeTarget = { kind: 'node', pos, img }
  showToolbar()
}

function bindHtmlImage(img: HTMLImageElement): void {
  activeTarget = { kind: 'html', img }
  showToolbar()
}

function showToolbar(): void {
  if (!toolbar || !resizeHandle || !host) return
  // The toolbar only makes sense in the visual editor; source mode hides it
  // through the root being hidden, but an explicit refresh keeps it honest.
  toolbar.hidden = false
  resizeHandle.hidden = false
  positionToolbar()
}

// Width presets and drag-resize both funnel here. Applying a width converts a
// markdown image into an inline `<img … width>` node (Typora's model: width
// cannot live in `![]()` syntax), and removing it converts back.
function applyWidth(width: number | null): void {
  if (!editorView || !activeTarget) return
  const view = editorView
  if (activeTarget.kind === 'node') {
    if (width == null) return
    const { pos, img } = activeTarget
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'image') {
      hideToolbar()
      return
    }
    const htmlType = view.state.schema.nodes.html
    if (!htmlType) return
    const value = htmlValueFromAttrs({
      src: node.attrs.src ?? '',
      alt: node.attrs.alt ?? '',
      title: node.attrs.title ?? '',
    }, width)
    if (!value) return
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, htmlType.create({ value })))
    rebindAfterConversion(pos)
    return
  }

  const info = htmlNodeInfo(activeTarget.img)
  if (!info) {
    hideToolbar()
    return
  }
  if (width == null) {
    // Dropping the size restores the plain markdown form.
    const attrs = imgAttrsFromHtmlValue(info.value)
    const imageType = view.state.schema.nodes.image
    if (!attrs || !imageType) return
    view.dispatch(view.state.tr.replaceWith(
      info.pos,
      info.pos + 1,
      imageType.create({ src: attrs.src, alt: attrs.alt, title: attrs.title })
    ))
    hideToolbar()
    return
  }
  const node = view.state.doc.nodeAt(info.pos)
  if (!node || node.type.name !== 'html') {
    hideToolbar()
    return
  }
  view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, {
    ...node.attrs,
    value: htmlValueSetWidth(String(node.attrs.value ?? ''), width),
  }))
  // The img element survives an attribute-level rewrite; keep the toolbar.
  positionToolbar()
}

// After image→html conversion the node occupies the same position (both are
// leaf nodes); rebind so the toolbar stays attached to the new DOM.
function rebindAfterConversion(pos: number): void {
  if (!editorView) return
  const dom = editorView.nodeDOM(pos) as HTMLElement | null
  const img = dom instanceof HTMLElement ? dom.querySelector('img') : null
  if (img) {
    activeTarget = { kind: 'html', img }
    showToolbar()
  } else {
    hideToolbar()
  }
}

async function replaceImage(): Promise<void> {
  if (!editorView || !activeTarget) return
  const paths = await window.electronAPI.pickImages()
  if (!paths || paths.length === 0) return
  const asset = await saveImageToAssets({ srcPath: paths[0] })
  if (!asset) return
  const view = editorView
  if (activeTarget.kind === 'node') {
    const node = view.state.doc.nodeAt(activeTarget.pos)
    if (!node || node.type.name !== 'image') return
    view.dispatch(view.state.tr.setNodeMarkup(activeTarget.pos, undefined, { ...node.attrs, src: asset.fileUrl }))
    return
  }
  const info = htmlNodeInfo(activeTarget.img)
  if (!info) return
  const node = view.state.doc.nodeAt(info.pos)
  if (!node || node.type.name !== 'html') return
  view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, {
    ...node.attrs,
    value: String(node.attrs.value ?? '').replace(/src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `src="${escapeHtmlAttr(asset.fileUrl)}"`),
  }))
}

function deleteImage(): void {
  if (!editorView || !activeTarget) return
  const view = editorView
  if (activeTarget.kind === 'node') {
    const node = view.state.doc.nodeAt(activeTarget.pos)
    if (!node) return
    view.dispatch(view.state.tr.delete(activeTarget.pos, activeTarget.pos + node.nodeSize))
  } else {
    const info = htmlNodeInfo(activeTarget.img)
    if (!info) return
    view.dispatch(view.state.tr.delete(info.pos, info.pos + 1))
  }
  hideToolbar()
}

function applyCaption(alt: string): void {
  if (!editorView || !activeTarget) return
  const view = editorView
  if (activeTarget.kind === 'node') {
    const node = view.state.doc.nodeAt(activeTarget.pos)
    if (!node || node.type.name !== 'image') return
    view.dispatch(view.state.tr.setNodeMarkup(activeTarget.pos, undefined, { ...node.attrs, alt }))
    if (activeTarget.img) activeTarget.img.alt = alt
    return
  }
  const info = htmlNodeInfo(activeTarget.img)
  if (!info) return
  const node = view.state.doc.nodeAt(info.pos)
  if (!node || node.type.name !== 'html') return
  view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, {
    ...node.attrs,
    value: htmlValueSetAlt(String(node.attrs.value ?? ''), alt),
  }))
}

function startResize(event: PointerEvent): void {
  const img = toolbarImage()
  if (!img || !resizeHandle) return
  event.preventDefault()
  resizeHandle.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startWidth = currentImageWidth(img)
  const maxWidth = Math.max(contentWidth(), startWidth)

  const onMove = (moveEvent: PointerEvent): void => {
    const next = Math.min(maxWidth, Math.max(HANDLE_MIN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX))))
    img.style.width = `${next}px`
  }
  const onFinish = (upEvent: PointerEvent): void => {
    resizeHandle?.removeEventListener('pointermove', onMove)
    resizeHandle?.removeEventListener('pointerup', onFinish)
    resizeHandle?.removeEventListener('pointercancel', onFinish)
    const next = Math.min(maxWidth, Math.max(HANDLE_MIN_WIDTH, Math.round(startWidth + (upEvent.clientX - startX))))
    img.style.width = ''
    applyWidth(next)
  }
  resizeHandle.addEventListener('pointermove', onMove)
  resizeHandle.addEventListener('pointerup', onFinish)
  resizeHandle.addEventListener('pointercancel', onFinish)
}

function makeToolbarDom(): { toolbarEl: HTMLDivElement; handle: HTMLDivElement } {
  const toolbarEl = document.createElement('div')
  toolbarEl.className = 'cmd-image-toolbar'
  toolbarEl.hidden = true

  const row = document.createElement('div')
  row.className = 'cmd-image-toolbar-row'

  const button = (label: string, title: string, action: (event: MouseEvent) => void): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    btn.title = title
    btn.addEventListener('mousedown', (event) => event.preventDefault())
    btn.addEventListener('click', action)
    return btn
  }

  WIDTH_PRESETS.forEach((preset) => {
    const label = `${Math.round(preset * 100)}%`
    row.appendChild(button(label, `宽度设为内容区的 ${label}`, () => {
      const img = toolbarImage()
      if (!img) return
      const target = Math.min(Math.round(contentWidth() * preset), img.naturalWidth || Infinity)
      applyWidth(Math.round(Math.min(target, Number.MAX_SAFE_INTEGER)))
    }))
  })

  row.appendChild(button('适应', '恢复原始宽度', () => applyWidth(null)))

  const separator = document.createElement('span')
  separator.className = 'cmd-image-toolbar-sep'
  row.appendChild(separator)

  row.appendChild(button('图注', '编辑图片描述（alt 文本）', () => {
    if (!captionRow || !captionInput) return
    const img = toolbarImage()
    captionInput.value = img?.alt ?? ''
    captionRow.hidden = false
    captionInput.focus()
  }))
  row.appendChild(button('替换', '替换为其他图片', () => { void replaceImage() }))
  row.appendChild(button('复制', '复制图片', () => {
    const img = toolbarImage()
    if (!img) return
    void window.electronAPI.copyImage(img.currentSrc || img.src)
  }))
  row.appendChild(button('文件夹', '在文件夹中显示', () => {
    const img = toolbarImage()
    if (!img) return
    void window.electronAPI.revealPath(filePathFromFileUrl(img.currentSrc || img.src) ?? '')
  }))
  row.appendChild(button('放大', '全屏查看（双击图片也可以）', () => {
    const img = toolbarImage()
    if (!img) return
    openLightbox(img.currentSrc || img.src, img.alt)
  }))
  row.appendChild(button('删除', '删除图片', () => deleteImage()))
  toolbarEl.appendChild(row)

  const captionEl = document.createElement('div')
  captionEl.className = 'cmd-image-caption-row'
  captionEl.hidden = true
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '图片描述（alt 文本）'
  const okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.textContent = '确定'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  captionEl.append(input, okBtn, cancelBtn)
  toolbarEl.appendChild(captionEl)

  const handle = document.createElement('div')
  handle.className = 'cmd-image-resize-handle'
  handle.hidden = true
  handle.title = '拖拽调整宽度'

  return { toolbarEl, handle: handle }
}

function toggleCaptionRow(visible: boolean): void {
  if (captionRow) captionRow.hidden = !visible
}

// Bridge ProseMirror selection state into the overlay: selecting an image
// node raises the toolbar, moving away lowers it.
export const imageSelectionBridge = $prose(() => {
  return new Plugin({
    view(editorViewInstance: EditorView) {
      editorView = editorViewInstance
      return {
        update(view, prevState) {
          const next = view.state.selection
          if (prevState.selection.eq(next)) return
          if (next instanceof NodeSelection && next.node.type.name === 'image') {
            bindNodeImage(view, next.from)
          } else if (activeTarget?.kind === 'node') {
            hideToolbar()
          }
        },
        destroy() {
          editorView = null
          hideToolbar()
        },
      }
    },
  })
})

export function initImageToolbar(root: HTMLElement): void {
  host = root
  const { toolbarEl, handle } = makeToolbarDom()
  toolbar = toolbarEl
  resizeHandle = handle
  root.appendChild(toolbarEl)
  root.appendChild(handle)

  captionRow = toolbarEl.querySelector('.cmd-image-caption-row')
  captionInput = toolbarEl.querySelector('input')

  resizeHandle.addEventListener('pointerdown', startResize)

  // Caption confirm/cancel wiring (queried lazily: the row is rebuilt never,
  // so one-time listeners are fine).
  const okBtn = captionRow?.querySelector('button')
  const cancelBtn = captionRow?.querySelectorAll('button')[1]
  const submitCaption = (): void => {
    if (!captionInput) return
    applyCaption(captionInput.value.trim())
    toggleCaptionRow(false)
  }
  okBtn?.addEventListener('click', submitCaption)
  cancelBtn?.addEventListener('click', () => toggleCaptionRow(false))
  captionInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitCaption()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      toggleCaptionRow(false)
    }
  })

  // Inline-HTML images don't produce NodeSelection (their node view swallows
  // events), so the toolbar binds from clicks and double-clicks instead.
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.cmd-image-toolbar') || target.closest('.cmd-image-resize-handle')) return
    const htmlImg = target.closest('.milkdown-html-inline img')
    if (htmlImg instanceof HTMLImageElement) {
      bindHtmlImage(htmlImg)
      return
    }
    if (target.closest('.cmd-image')) return // node images bind via selection
    hideToolbar()
  })

  root.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement
    const htmlImg = target.closest('.milkdown-html-inline img')
    if (htmlImg instanceof HTMLImageElement) {
      event.preventDefault()
      openLightbox(htmlImg.currentSrc || htmlImg.src, htmlImg.alt)
    }
  })

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !toolbar?.hidden) {
      toggleCaptionRow(false)
      hideToolbar()
    }
  })

  root.addEventListener('scroll', positionToolbar, { passive: true })
  window.addEventListener('resize', positionToolbar)
}
