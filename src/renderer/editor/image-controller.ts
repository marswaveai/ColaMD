import type { ImageInput, ImportedImage } from '../../image-types'
import { getEditorView, captureImageCollection } from './editor'
import { captureImageInsertion } from './image-insertion'
import { imageDialog, imageButton, showImageMessage, showImageSettings } from './image-settings'
import { setupImageSource } from './image-source'

const t = (cn: string, en: string): string => navigator.language.toLowerCase().startsWith('zh') ? cn : en
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function setupImageController(host: {
  documentId: () => number
  documentPath: () => string | null
  ensureSaved: () => Promise<boolean>
  source: () => HTMLTextAreaElement | null
  sourceChanged: () => void
}): void {
  setupImageSource(host)
  const api = window.electronAPI
  const capture = (position?: number): { insert: (images: ImportedImage[], html?: string) => boolean; cancel: () => void } | null => {
    const source = host.source()
    if (source) {
      const text = source.value
      const start = source.selectionStart
      const end = source.selectionEnd
      return {
        cancel: () => {},
        insert(images) {
          if (host.source() !== source || source.value !== text) return false
          const md = images.map(({ src, alt }) => `![${alt.replace(/[\[\]\\]/g, '\\$&')}](${/[\s()]/.test(src) ? '<' + src + '>' : src})`).join('\n')
          source.setRangeText(md, start, end, 'end')
          host.sourceChanged()
          source.focus()
          return true
        }
      }
    }
    const view = getEditorView()
    return view ? captureImageInsertion(view, position) : null
  }

  const insert = async (getInputs: () => Promise<ImageInput[]>, position?: number, html?: string): Promise<void> => {
    const target = capture(position)
    if (!target) return
    const identity = host.documentId()
    try {
      const inputs = await getInputs()
      if (!inputs.length || host.documentId() !== identity) return
      if (!host.documentPath() && !await host.ensureSaved()) return
      if (host.documentId() !== identity) return
      const path = host.documentPath()
      if (!path) return
      const result = await api.importImages(inputs, path)
      if (host.documentId() !== identity || host.documentPath() !== path) return
      if ((result.images.length || html) && !target.insert(result.images, html)) {
        showImageMessage(t('文档已发生变化，图片已保存到目录，请重新插入。', 'The document changed while importing. The files are saved; insert them again.'))
      }
      if (result.errors.length) showImageMessage(t('部分图片未能导入：\n', 'Some images could not be imported:\n') + result.errors.join('\n'))
    } catch (error) { if (host.documentId() === identity) showImageMessage(t('无法导入图片：\n', 'Unable to import images:\n') + errorText(error)) }
    finally { target.cancel() }
  }

  const fileInputs = async (files: File[], origin: 'file' | 'clipboard'): Promise<ImageInput[]> => {
    if (files.length > 100 || files.some((file) => file.size > 50 * 1024 * 1024)) {
      throw new Error(t('一次最多插入 100 张图片，每张不超过 50 MB。', 'Import up to 100 images, each no larger than 50 MB.'))
    }
    return Promise.all(files.map(async (file): Promise<ImageInput> => {
      const path = api.getPathForFile(file)
      // Native screenshots have no filesystem path. Finder file copies do,
      // and should use the existing-file naming preference even when pasted.
      return path ? { name: file.name, path, origin: 'file' } : { name: file.name || 'image.png', data: new Uint8Array(await file.arrayBuffer()), origin }
    }))
  }
  const isImage = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name)
  const editor = document.getElementById('editor')!
  const sourceEditor = document.getElementById('source-editor')!
  const onPaste = (event: ClipboardEvent): void => {
    if (event.target instanceof Element && event.target.closest('.image-source-inline')) return
    const view = getEditorView()
    if (!host.source() && view?.state.selection.$from.parent.type.spec.code) return
    const clipboard = event.clipboardData
    if (!clipboard) return
    const files = Array.from(clipboard.files).filter(isImage)
    if (files.length) {
      event.preventDefault(); event.stopPropagation()
      void insert(() => fileInputs(files, 'clipboard'))
      return
    }
    const html = clipboard.getData('text/html')
    if (!html) return
    const dom = new DOMParser().parseFromString(html, 'text/html')
    const images = [...dom.querySelectorAll('img[src]')]
    // In source mode, mixed HTML keeps the native plain-text paste behavior.
    if (!images.length || (host.source() && dom.body.textContent?.trim())) return
    const inputs = images.map((image): ImageInput => ({ name: image.getAttribute('alt') || 'image', url: image.getAttribute('src')!, origin: 'clipboard' }))
    event.preventDefault(); event.stopPropagation()
    void insert(async () => inputs, undefined, host.source() ? undefined : html)
  }
  const onDrop = (event: DragEvent): void => {
    if (event.target instanceof Element && event.target.closest('.image-source-inline')) return
    const files = Array.from(event.dataTransfer?.files || []).filter(isImage)
    if (!files.length) return
    event.preventDefault(); event.stopPropagation()
    const view = getEditorView()
    const position = host.source() ? undefined : view?.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
    void insert(() => fileInputs(files, 'file'), position)
  }
  for (const element of [editor, sourceEditor]) {
    element.addEventListener('paste', onPaste as EventListener, true)
    element.addEventListener('drop', onDrop as EventListener, true)
  }

  const requestURL = (): Promise<ImageInput[]> => new Promise((resolve) => {
    const ui = imageDialog(t('插入图片链接', 'Insert Image URL'))
    const label = document.createElement('label')
    label.textContent = t('图片地址', 'Image URL')
    label.htmlFor = 'image-url'
    const input = document.createElement('input')
    input.id = label.htmlFor; input.type = 'url'; input.className = 'image-setting-control'; input.placeholder = 'https://…'
    const status = document.createElement('p'); status.setAttribute('role', 'status')
    const submit = (): void => {
      try {
        const url = new URL(input.value.trim())
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
        resolve([{ name: 'image', url: url.href, origin: 'remote' }]); ui.close()
      } catch { status.textContent = t('请输入有效的 HTTP 或 HTTPS 图片地址。', 'Enter a valid HTTP or HTTPS image URL.') }
    }
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit() })
    ui.body.append(label, input, status)
    ui.footer.append(imageButton(t('取消', 'Cancel'), ui.close), imageButton(t('插入', 'Insert'), submit, true))
    ui.body.closest('dialog')!.addEventListener('close', () => resolve([]))
    input.focus()
  })

  const collect = async (): Promise<void> => {
    const identity = host.documentId()
    const source = host.source()
    const original = source?.value
    const snapshot = captureImageCollection(original)
    if (!snapshot?.sources.length) { showImageMessage(t('当前文档没有图片。', 'This document has no images.')); return }
    if (snapshot.sources.length > 100) { showImageMessage(t('一次最多整理 100 张图片。', 'Organize up to 100 images at a time.')); return }
    const ui = imageDialog(t('复制文档图片到附件目录', 'Copy Document Images to Folder'))
    const message = document.createElement('p')
    message.textContent = t(`将按当前图片设置复制 ${snapshot.sources.length} 张图片并更新引用，包括下载网络图片。原图片文件保留。`, `Copy ${snapshot.sources.length} images using the current image settings and update references, including downloading remote images. Original files are kept.`)
    ui.body.append(message)
    ui.footer.append(imageButton(t('取消', 'Cancel'), ui.close), imageButton(t('复制并更新引用', 'Copy and Update References'), () => {
      ui.close()
      void (async () => {
        if (host.documentId() !== identity) return
        if (!host.documentPath() && !await host.ensureSaved()) return
        const path = host.documentPath()
        if (!path || host.documentId() !== identity) return
        const result = await api.importImages(snapshot.sources.map((url) => ({ name: 'image', url, origin: 'clipboard' })), path, true)
        if (host.documentId() !== identity || path !== host.documentPath() || (source && source.value !== original)) return
        const mapping = new Map(result.images.map((image) => [snapshot.sources[image.inputIndex!], image.src]))
        const content = snapshot.apply(mapping)
        if (content === null) { showImageMessage(t('文档已发生变化，请重新整理图片。', 'The document changed. Run the command again.')); return }
        if (source) { source.value = content; host.sourceChanged() }
        if (result.errors.length) showImageMessage(result.errors.join('\n'))
      })().catch((error) => showImageMessage(errorText(error)))
    }, true))
  }

  api.onImageCommand((command) => {
    if (document.querySelector('dialog[open]')) return
    if (command === 'settings') void showImageSettings().catch((error) => showImageMessage(errorText(error)))
    if (command === 'files') void insert(() => api.selectImageFiles())
    if (command === 'url') void insert(requestURL)
    if (command === 'collect') void collect()
    if (command === 'reveal') void api.revealImageDirectory().then((error) => { if (error) showImageMessage(error) })
  })
}
