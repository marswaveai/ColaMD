import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

import { imageHooks, isImageFile, isImageFileName, saveImageToAssets } from './core'

// Image input pipeline: paste, drag-and-drop and the menu picker all land
// here. Every image is written into the document's assets/ folder and
// inserted as a standard markdown image whose src is a file:// URL — the same
// representation loadFileInWindow uses, so restoreImagePaths keeps the saved
// markdown portable with relative paths. Nothing is ever embedded as base64.

let pasteView: EditorView | null = null

// Keeps a handle on the live ProseMirror view without a module cycle back to
// editor.ts (same pattern as the toolbar bridge).
export const imageInputBridge = $prose(() => {
  return new Plugin({
    view(view: EditorView) {
      pasteView = view
      return {
        destroy() {
          pasteView = null
        },
      }
    },
  })
})

const DATA_URI_RE = /^data:(image\/[a-z+d.+-]+);base64,([A-Za-z0-9+/=]+)$/i

function dataUriToFile(dataUri: string, name: string): File | null {
  const match = dataUri.trim().match(DATA_URI_RE)
  if (!match) return null
  try {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], name, { type: match[1] })
  } catch {
    return null
  }
}

function imageFilesFrom(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files).filter(isImageFile)
}

// Some apps (WeChat, some browsers) put the image only in the text/html
// clipboard flavor as a data: URI. When that HTML carries nothing but
// images, treat it as an image paste; mixed rich text still goes through the
// regular paste path.
function imagesFromRichText(dataTransfer: DataTransfer | null): File[] {
  const html = dataTransfer?.getData('text/html')
  if (!html) return []
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const images = Array.from(parsed.body.querySelectorAll('img'))
  if (images.length === 0) return []
  const hasOtherContent = Array.from(parsed.body.childNodes).some((child) => {
    if (child.nodeType === Node.TEXT_NODE) return (child.textContent ?? '').trim().length > 0
    if (child instanceof HTMLElement && child.tagName === 'IMG') return false
    // Whitespace-only wrappers (p/br/span) around images are still images.
    return child instanceof HTMLElement && (child.textContent ?? '').trim().length > 0
  })
  if (hasOtherContent) return []
  const files: File[] = []
  images.forEach((img, index) => {
    const src = img.getAttribute('src') ?? ''
    const file = dataUriToFile(src, `pasted-image-${Date.now()}-${index + 1}.png`)
    if (file) files.push(file)
  })
  return files
}

function escapeMarkdownDestination(path: string): string {
  return /[\s()]/.test(path) ? `<${path}>` : path
}

// Placeholder images enter the document with a blob: src and get their final
// file:// src once the asset is written. A save that lands inside that window
// would persist a dead blob: URL, so every write is tracked here and the host
// app drains it before saving (see saveCurrent in main.ts).
const pendingImageWrites = new Set<Promise<unknown>>()

function trackImageWrite(task: Promise<unknown>): void {
  const wrapped = task.finally(() => pendingImageWrites.delete(wrapped))
  pendingImageWrites.add(wrapped)
}

/** Resolves once no image asset write is in flight (including cascades). */
export function whenImageWritesSettled(): Promise<void> {
  if (pendingImageWrites.size === 0) return Promise.resolve()
  return Promise.all([...pendingImageWrites]).then(() => whenImageWritesSettled())
}

interface PlaceholderHit {
  pos: number
  nodeSize: number
}

function findImageBySrc(view: EditorView, src: string): PlaceholderHit | null {
  let hit: PlaceholderHit | null = null
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src) {
      hit = { pos, nodeSize: node.nodeSize }
      return false
    }
    return true
  })
  return hit
}

function insertPlaceholder(view: EditorView, blobUrl: string, insertPos?: number): void {
  const imageType = view.state.schema.nodes.image
  if (!imageType) return
  const node = imageType.create({ src: blobUrl, alt: '', title: '' })
  if (insertPos != null) {
    view.dispatch(view.state.tr.insert(insertPos, node))
  } else {
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
  }
}

async function insertImageFiles(files: File[], insertPos?: number): Promise<void> {
  const hooks = imageHooks()
  const view = pasteView
  if (!hooks || !view) return

  // Images must land in an assets folder that only exists once the document
  // is on disk — mirror VS Code's conservative rule for untitled buffers.
  const docPath = await hooks.ensureDocumentSaved()
  if (!docPath) {
    hooks.notify('请先保存文档（⌘S）后再插入图片')
    return
  }

  let cursorOffset = 0
  for (const file of files) {
    const blobUrl = URL.createObjectURL(file)
    insertPlaceholder(view, blobUrl, insertPos != null ? insertPos + cursorOffset : undefined)
    cursorOffset += 1
    const task = (async (): Promise<void> => {
      try {
        const asset = await saveImageToAssets({ file })
        if (!asset) throw new Error('save failed')
        const hit = findImageBySrc(view, blobUrl)
        if (!hit) throw new Error('placeholder lost')
        view.dispatch(view.state.tr.setNodeMarkup(hit.pos, undefined, { src: asset.fileUrl, alt: '', title: '' }))
      } catch {
        const hit = findImageBySrc(view, blobUrl)
        if (hit) view.dispatch(view.state.tr.delete(hit.pos, hit.pos + hit.nodeSize))
        hooks.notify('图片保存失败，请重试')
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
    })()
    trackImageWrite(task)
  }
}

async function insertImagePaths(paths: string[]): Promise<void> {
  const hooks = imageHooks()
  const view = pasteView
  if (!hooks || !view || paths.length === 0) return

  const docPath = await hooks.ensureDocumentSaved()
  if (!docPath) {
    hooks.notify('请先保存文档（⌘S）后再插入图片')
    return
  }

  for (const srcPath of paths) {
    if (!isImageFileName(srcPath)) continue
    const asset = await saveImageToAssets({ srcPath })
    if (!asset) {
      hooks.notify('图片复制失败，请重试')
      continue
    }
    const imageType = view.state.schema.nodes.image
    if (!imageType) return
    const node = imageType.create({ src: asset.fileUrl, alt: '', title: '' })
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
  }
}

async function insertIntoSourceMode(files: File[]): Promise<void> {
  const hooks = imageHooks()
  if (!hooks) return
  const docPath = await hooks.ensureDocumentSaved()
  if (!docPath) {
    hooks.notify('请先保存文档（⌘S）后再插入图片')
    return
  }
  const refs: string[] = []
  for (const file of files) {
    const asset = await saveImageToAssets({ file })
    if (asset) refs.push(`![](${escapeMarkdownDestination(asset.relPath)})`)
  }
  if (refs.length > 0) hooks.insertSourceText(refs.join('\n'))
}

function onPaste(event: ClipboardEvent): void {
  const hooks = imageHooks()
  if (!hooks) return
  // Never hijack plain inputs (search, caption field); the source editor is
  // a textarea and IS handled below.
  if (event.target instanceof HTMLInputElement) return
  const direct = imageFilesFrom(event.clipboardData)
  const files = direct.length > 0 ? direct : imagesFromRichText(event.clipboardData)
  if (files.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  if (hooks.isSourceMode()) {
    void insertIntoSourceMode(files)
  } else {
    void insertImageFiles(files)
  }
}

function onDrop(event: DragEvent): void {
  const hooks = imageHooks()
  if (event.target instanceof HTMLInputElement) return
  const all = Array.from(event.dataTransfer?.files ?? [])
  const files = all.filter(isImageFile)
  // Mixed drags (markdown + images) keep the "open the .md" behavior.
  if (!hooks || files.length === 0 || files.length !== all.length) return
  event.preventDefault()
  event.stopPropagation()
  if (hooks.isSourceMode()) {
    void insertIntoSourceMode(files)
    return
  }
  const view = pasteView
  const coords = view?.posAtCoords({ left: event.clientX, top: event.clientY })
  void insertImageFiles(files, coords?.pos)
}

export function initImageInput(): void {
  document.addEventListener('paste', onPaste, true)
  document.addEventListener('drop', onDrop, true)
}

/** Edit → 插入图片… (⌘⇧I): pick local files and insert them at the caret. */
export async function insertImagesFromPicker(): Promise<void> {
  const paths = await window.electronAPI.pickImages()
  if (!paths || paths.length === 0) return
  const hooks = imageHooks()
  if (!hooks) return
  if (hooks.isSourceMode()) {
    const docPath = await hooks.ensureDocumentSaved()
    if (!docPath) {
      hooks.notify('请先保存文档（⌘S）后再插入图片')
      return
    }
    const refs: string[] = []
    for (const srcPath of paths) {
      const asset = await saveImageToAssets({ srcPath })
      if (asset) refs.push(`![](${escapeMarkdownDestination(asset.relPath)})`)
    }
    if (refs.length > 0) hooks.insertSourceText(refs.join('\n'))
    return
  }
  await insertImagePaths(paths)
}
