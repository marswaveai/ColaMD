import { NodeSelection, Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

import { openLightbox } from './lightbox'
import { filePathFromFileUrl, saveImageToAssets } from './core'

// Floating image toolbar, modeled on the code-copy button in editor.ts: ONE
// overlay rendered OUTSIDE the ProseMirror-managed DOM, absolutely positioned
// inside the scroll container #editor. Following Feishu's interaction model:
// hovering an image floats the toolbar (centered above it) with four corner
// drag handles for proportional resizing; caption text renders below the
// image (see node-view.ts), the toolbar only edits it.

interface Target {
  kind: 'node' | 'html'
  img: HTMLImageElement
}

const HANDLE_MIN_WIDTH = 48
const HOVER_SHOW_DELAY = 180
const HOVER_HIDE_DELAY = 280

let editorView: EditorView | null = null
let activeTarget: Target | null = null
let toolbar: HTMLDivElement | null = null
let captionRow: HTMLDivElement | null = null
let captionInput: HTMLInputElement | null = null
let handles: HTMLDivElement[] = []
let host: HTMLElement | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

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

// Locate the document position of any rendered <img>, both node-view images
// (leaf position lands on the node) and inline-HTML images.
function resolveDocInfo(img: HTMLImageElement): { pos: number; type: 'image' | 'html'; nodeValue?: string } | null {
  if (!editorView) return null
  const probe = (pos: number): { pos: number; type: 'image' | 'html'; nodeValue?: string } | null => {
    const node = editorView?.state.doc.nodeAt(pos)
    if (!node) return null
    if (node.type.name === 'image') return { pos, type: 'image' }
    if (node.type.name === 'html') return { pos, type: 'html', nodeValue: String(node.attrs.value ?? '') }
    return null
  }
  try {
    const pos = editorView.posAtDOM(img, 0)
    return probe(pos) ?? probe(Math.max(0, pos - 1))
  } catch {
    return null
  }
}

function hideToolbar(): void {
  activeTarget = null
  if (toolbar) toolbar.hidden = true
  for (const handle of handles) handle.hidden = true
  if (captionRow) captionRow.hidden = true
}

function toolbarImage(): HTMLImageElement | null {
  return activeTarget?.img ?? null
}

function positionOverlay(): void {
  const img = toolbarImage()
  if (!img || !toolbar || !host || !img.isConnected) {
    hideToolbar()
    return
  }
  const base = host.getBoundingClientRect()
  const editor = host
  const rect = img.getBoundingClientRect()
  const left = rect.left - base.left + editor.scrollLeft
  const top = rect.top - base.top + editor.scrollTop
  // Centered above the image, clamped into the editor's visible column —
  // Feishu's placement, not a left-anchored strip.
  const toolbarWidth = toolbar.offsetWidth || 200
  const centered = left + rect.width / 2 - toolbarWidth / 2
  const maxLeft = Math.max(4, host.clientWidth - toolbarWidth - 4)
  toolbar.style.top = `${Math.max(4, top - toolbar.offsetHeight - 8)}px`
  toolbar.style.left = `${Math.max(4, Math.min(centered, maxLeft))}px`
  const handleOffset = 6
  const corners: Array<[number, number]> = [
    [left - handleOffset, top - handleOffset],
    [left + rect.width - handleOffset, top - handleOffset],
    [left - handleOffset, top + rect.height - handleOffset],
    [left + rect.width - handleOffset, top + rect.height - handleOffset],
  ]
  handles.forEach((handle, index) => {
    const [hx, hy] = corners[index]
    handle.style.left = `${hx}px`
    handle.style.top = `${hy}px`
  })
}

function showToolbar(target: Target): void {
  if (!toolbar || !host) return
  activeTarget = target
  toolbar.hidden = false
  for (const handle of handles) handle.hidden = false
  positionOverlay()
}

function cancelTimers(): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function targetForImg(img: HTMLImageElement): Target {
  return { kind: img.closest('.cmd-image') ? 'node' : 'html', img }
}

function scheduleShow(img: HTMLImageElement): void {
  cancelTimers()
  showTimer = setTimeout(() => {
    if (img.isConnected) showToolbar(targetForImg(img))
  }, HOVER_SHOW_DELAY)
}

function scheduleHide(): void {
  cancelTimers()
  hideTimer = setTimeout(() => hideToolbar(), HOVER_HIDE_DELAY)
}

// Width application converts a markdown image into an inline `<img … width>`
// node (Typora's model: width cannot live in `![]()` syntax). Removing the
// width restores the plain markdown form.
function applyWidth(width: number): void {
  if (!editorView || !activeTarget) return
  const view = editorView
  const img = activeTarget.img
  const info = resolveDocInfo(img)
  if (!info) {
    hideToolbar()
    return
  }
  if (info.type === 'image') {
    const node = view.state.doc.nodeAt(info.pos)
    if (!node) {
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
    view.dispatch(view.state.tr.replaceWith(info.pos, info.pos + node.nodeSize, htmlType.create({ value })))
    rebindAfterConversion(info.pos)
    return
  }

  const node = view.state.doc.nodeAt(info.pos)
  if (!node) {
    hideToolbar()
    return
  }
  view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, {
    ...node.attrs,
    value: htmlValueSetWidth(String(node.attrs.value ?? ''), width),
  }))
  positionOverlay()
}

// After image→html conversion the node occupies the same position (both are
// leaf nodes); rebind so the overlay stays attached to the new DOM.
function rebindAfterConversion(pos: number): void {
  if (!editorView) return
  const dom = editorView.nodeDOM(pos) as HTMLElement | null
  const img = dom instanceof HTMLElement ? dom.querySelector('img') : null
  if (img) {
    activeTarget = { kind: 'html', img }
    showToolbar(activeTarget)
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
  const img = activeTarget.img
  const info = resolveDocInfo(img)
  if (!info) return
  const node = view.state.doc.nodeAt(info.pos)
  if (!node) return
  if (info.type === 'image') {
    view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, { ...node.attrs, src: asset.fileUrl }))
  } else {
    view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, {
      ...node.attrs,
      value: String(node.attrs.value ?? '').replace(/src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `src="${escapeHtmlAttr(asset.fileUrl)}"`),
    }))
  }
}

function deleteImage(): void {
  if (!editorView || !activeTarget) return
  const view = editorView
  const info = resolveDocInfo(activeTarget.img)
  if (!info) return
  const node = view.state.doc.nodeAt(info.pos)
  if (!node) return
  view.dispatch(view.state.tr.delete(info.pos, info.pos + node.nodeSize))
  hideToolbar()
}

function applyCaption(alt: string): void {
  if (!editorView || !activeTarget) return
  const view = editorView
  const info = resolveDocInfo(activeTarget.img)
  if (!info) return
  const node = view.state.doc.nodeAt(info.pos)
  if (!node) return
  if (info.type === 'image') {
    view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, { ...node.attrs, alt }))
  } else {
    view.dispatch(view.state.tr.setNodeMarkup(info.pos, undefined, {
      ...node.attrs,
      value: htmlValueSetAlt(String(node.attrs.value ?? ''), alt),
    }))
  }
}

// Proportional resize from a corner handle: drag distance maps 1:1 onto the
// new width (height follows naturally). Left-corner handles shrink when
// dragged right; right-corner handles grow — matching Feishu's feel.
function startResize(event: PointerEvent, handle: HTMLDivElement): void {
  const img = toolbarImage()
  if (!img) return
  event.preventDefault()
  handle.setPointerCapture(event.pointerId)
  const corner = handle.dataset.corner ?? 'se'
  const dir = corner === 'nw' || corner === 'sw' ? -1 : 1
  const startClientX = event.clientX
  const startWidth = currentImageWidth(img)
  const maxWidth = Math.max(contentWidth(), startWidth)

  const widthFor = (clientX: number): number =>
    Math.min(maxWidth, Math.max(HANDLE_MIN_WIDTH, Math.round(startWidth + dir * (clientX - startClientX))))

  const onMove = (moveEvent: PointerEvent): void => {
    img.style.width = `${widthFor(moveEvent.clientX)}px`
    positionOverlay()
  }
  const onFinish = (upEvent: PointerEvent): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onFinish)
    handle.removeEventListener('pointercancel', onFinish)
    const next = widthFor(upEvent.clientX)
    img.style.width = ''
    // A plain click (no real drag) must not rewrite the document.
    if (Math.abs(next - startWidth) < 2) return
    applyWidth(next)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onFinish)
  handle.addEventListener('pointercancel', onFinish)
}

function makeToolbarDom(): void {
  const hostEl = host
  if (!hostEl) return
  const toolbarEl = document.createElement('div')
  toolbarEl.className = 'cmd-image-toolbar'
  toolbarEl.hidden = true

  const row = document.createElement('div')
  row.className = 'cmd-image-toolbar-row'

  const button = (label: string, title: string, action: () => void): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    btn.title = title
    btn.addEventListener('mousedown', (event) => event.preventDefault())
    btn.addEventListener('click', action)
    return btn
  }

  row.appendChild(button('图注', '编辑图片描述（显示在图片下方）', () => {
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
  input.placeholder = '图片描述（显示在图片下方）'
  const okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.textContent = '确定'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  captionEl.append(input, okBtn, cancelBtn)
  toolbarEl.appendChild(captionEl)

  hostEl.appendChild(toolbarEl)
  toolbar = toolbarEl
  captionRow = captionEl
  captionInput = input

  const captionRowRef = captionEl
  const captionInputRef = input
  const submitCaption = (): void => {
    applyCaption(captionInputRef.value.trim())
    captionRowRef.hidden = true
  }
  okBtn.addEventListener('click', submitCaption)
  cancelBtn.addEventListener('click', () => { captionRowRef.hidden = true })
  captionInputRef.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitCaption()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      captionRowRef.hidden = true
    }
  })

  // Four corner handles (Feishu model): proportional drag on any corner.
  handles = (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
    const handle = document.createElement('div')
    handle.className = `cmd-image-resize-handle cmd-image-handle-${corner}`
    handle.dataset.corner = corner
    handle.title = '拖拽调整大小'
    handle.hidden = true
    handle.addEventListener('pointerdown', (event) => startResize(event, handle))
    hostEl.appendChild(handle)
    return handle
  })
}

// Bridge ProseMirror selection into the overlay: selecting an image node
// (click) floats the toolbar exactly like hovering does.
export const imageSelectionBridge = $prose(() => {
  return new Plugin({
    view(editorViewInstance: EditorView) {
      editorView = editorViewInstance
      return {
        update(view, prevState) {
          const next = view.state.selection
          if (prevState.selection.eq(next)) return
          if (next instanceof NodeSelection && next.node.type.name === 'image') {
            const dom = view.nodeDOM(next.from) as HTMLElement | null
            const img = dom instanceof HTMLElement ? dom.querySelector('img') : null
            if (img) {
              cancelTimers()
              showToolbar({ kind: 'node', img })
            }
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
  makeToolbarDom()

  // Hover an image → toolbar floats in (Feishu behavior). The toolbar and
  // handles keep it alive; leaving both hides it after a short grace delay.
  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.cmd-image-toolbar') || target.closest('.cmd-image-resize-handle')) {
      cancelTimers()
      return
    }
    const img = target.closest('.cmd-image img, .milkdown-html-inline img')
    if (img instanceof HTMLImageElement) {
      scheduleShow(img)
    }
  })
  root.addEventListener('mouseout', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.cmd-image-toolbar') || target.closest('.cmd-image-resize-handle')) return
    const img = target.closest('.cmd-image img, .milkdown-html-inline img')
    if (img instanceof HTMLImageElement) scheduleHide()
  })

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.cmd-image-toolbar') || target.closest('.cmd-image-resize-handle')) return
    if (target.closest('.cmd-image img, .milkdown-html-inline img')) return
    hideToolbar()
  })

  root.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement
    const img = target.closest('.cmd-image img, .milkdown-html-inline img')
    if (img instanceof HTMLImageElement) {
      event.preventDefault()
      openLightbox(img.currentSrc || img.src, img.alt)
    }
  })

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toolbar && !toolbar.hidden) {
      if (captionRow) captionRow.hidden = true
      hideToolbar()
    }
  })

  root.addEventListener('scroll', positionOverlay, { passive: true })
  window.addEventListener('resize', positionOverlay)
}

// Export flows (PDF/HTML/image snapshot) render the live editor DOM; a stuck
// toolbar or resize handle must never leak into exported files.
export function hideImageToolbar(): void {
  hideToolbar()
}
