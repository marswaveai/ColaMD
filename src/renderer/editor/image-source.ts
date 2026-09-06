import { captureImageSource } from './editor'
import { showImageMessage } from './image-settings'

const t = (cn: string, en: string): string => navigator.language.toLowerCase().startsWith('zh') ? cn : en

export function setupImageSource(host: { documentId: () => number; documentPath: () => string | null; source: () => HTMLTextAreaElement | null }): void {
  const editor = document.getElementById('editor')!
  let active: { image: HTMLImageElement; finish: () => Promise<boolean>; cancel: () => void } | null = null
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !active || !(event.target instanceof Node)) return
    if (document.querySelector('.image-source-inline')?.contains(event.target) || event.target === active.image) return
    void active.finish()
  }, true)
  // A second click used to move focus from the source field into ProseMirror:
  // focusout removed the widget, then click mounted it again. Keep the current
  // focus/selection and DOM when clicking the already expanded image.
  editor.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.target !== active?.image) return
    event.preventDefault(); event.stopPropagation()
  }, true)

  editor.addEventListener('contextmenu', (event) => {
    if (host.source() || document.querySelector('dialog[open]')) return
    const image = event.target instanceof Element ? event.target.closest('img') : null
    if (!(image instanceof HTMLImageElement)) return
    const initial = captureImageSource(image)
    if (!initial) return
    event.preventDefault(); event.stopPropagation()
    const identity = host.documentId()
    const path = host.documentPath()
    void (async () => {
      if (active && !await active.finish()) return
      if (host.documentId() !== identity || host.documentPath() !== path || host.source()) return
      const element = initial.element()
      const target = element && captureImageSource(element)
      if (!target) return
      const value = await window.electronAPI.showImageScaleMenu(target.scale)
      if (value === null || host.documentId() !== identity || host.documentPath() !== path || host.source()) return
      if (!target.setScale(value)) showImageMessage(t('文档已发生变化，请重新选择图片。', 'The document changed. Select the image again.'))
    })().catch((error) => showImageMessage(String(error)))
  }, true)

  editor.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || host.source() || document.querySelector('dialog[open]')) return
    const image = event.target instanceof Element ? event.target.closest('img') : null
    if (!(image instanceof HTMLImageElement)) return
    event.preventDefault(); event.stopPropagation()
    if (active?.image === image) return
    void (async () => {
      if (active && !await active.finish()) return
      if (!image.isConnected) return
      const target = captureImageSource(image)
      if (!target) return
      const identity = host.documentId()
      const documentPath = host.documentPath()
      const current = (): boolean => host.documentId() === identity && host.documentPath() === documentPath && !host.source()
      const panel = document.createElement('span')
      panel.className = 'image-source-inline'
      panel.contentEditable = 'false'
      const input = document.createElement('textarea')
      input.id = 'image-source-markdown'
      input.setAttribute('aria-label', t('图片源代码', 'Image source'))
      input.spellcheck = false
      input.rows = 1
      input.disabled = true
      const actions = document.createElement('span')
      actions.className = 'image-source-actions'
      const hint = document.createElement('span')
      hint.textContent = t('Enter 确认 · Esc 取消', 'Enter to confirm · Esc to cancel')
      const status = document.createElement('span')
      status.className = 'image-source-status'
      status.setAttribute('role', 'status')
      let pending = true
      let original = ''
      let disposed = false
      let finishing: Promise<boolean> | null = null
      let close = (): void => {}
      const resize = (): void => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px` }
      const valid = (): boolean => target.path(input.value) !== null
      const update = (): void => {
        input.setAttribute('aria-invalid', String(!pending && !valid()))
        status.textContent = !pending && !valid() ? t('请输入有效的 ![说明](路径) 或 <img> 语法。', 'Enter a valid ![alt](path) or <img> element.') : ''
        resize()
      }
      const finish = (): Promise<boolean> => {
        if (finishing) return finishing
        if (!current() || disposed) { close(); return Promise.resolve(true) }
        if (pending) return Promise.resolve(false)
        if (input.value === original) { close(); return Promise.resolve(true) }
        if (!valid()) { update(); return Promise.resolve(false) }
        pending = true
        input.disabled = true
        finishing = window.electronAPI.convertImageSource(input.value, documentPath, 'display').then((markdown) => {
          if (!current() || disposed) return false
          if (!target.apply(markdown)) throw new Error(t('文档已发生变化，请重新选择图片。', 'The document changed. Select the image again.'))
          close()
          return true
        }).catch((error) => { if (!disposed) status.textContent = String(error); return false }).finally(() => {
          pending = false; input.disabled = false; finishing = null
        })
        return finishing
      }
      const button = (label: string, className: string, run: () => void): HTMLButtonElement => {
        const element = document.createElement('button')
        element.type = 'button'; element.className = className; element.textContent = label
        element.addEventListener('click', run)
        return element
      }
      const copy = button(t('复制', 'Copy'), 'image-source-copy', () => {
        if (pending) return
        void navigator.clipboard.writeText(input.value).then(() => { status.textContent = t('已复制', 'Copied') }).catch((error) => { status.textContent = String(error) })
      })
      const replace = button(t('替换图片…', 'Replace image…'), 'image-source-replace', () => {
        if (pending) return
        if (!documentPath) { status.textContent = t('请先保存文档，再替换图片。', 'Save the document before replacing an image.'); return }
        pending = true
        void (async () => {
          const inputs = await window.electronAPI.selectImageFiles()
          if (!inputs.length || disposed || !current()) return
          if (inputs.length !== 1) throw new Error(t('请选择一个图片文件。', 'Choose one image file.'))
          const result = await window.electronAPI.importImages(inputs, documentPath)
          if (disposed || !current()) return
          if (!result.images.length) throw new Error(result.errors.join('\n'))
          const image = result.images[0]
          if (!target.apply(target.replacement(image.src, image.alt))) throw new Error(t('文档已发生变化，请重新选择图片。', 'The document changed. Select the image again.'))
          close()
        })().catch((error) => { if (!disposed) status.textContent = String(error) }).finally(() => { pending = false })
      })
      actions.append(hint, copy, replace)
      panel.append(input, actions, status)
      input.addEventListener('input', update)
      input.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); close(); target.focus() }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void finish().then((applied) => { if (applied && current()) target.focus() })
        }
      })
      panel.addEventListener('focusout', (event) => {
        if (event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) return
        if (!pending) void finish()
      })
      close = target.mount(panel, () => {
        disposed = true
        if (active?.cancel === close) active = null
      })
      active = { image: target.element() ?? image, finish, cancel: close }
      void window.electronAPI.convertImageSource(target.markdown, documentPath, 'markdown').then((markdown) => {
        if (disposed) return
        if (!current()) { close(); return }
        original = input.value = markdown.trim()
        input.disabled = false; pending = false
        update(); input.focus()
        const path = target.path(input.value)
        const start = path ? input.value.indexOf(path) : -1
        if (start >= 0) input.setSelectionRange(start, start + path!.length)
      }).catch((error) => { if (!disposed) { close(); showImageMessage(String(error)) } })
    })().catch((error) => showImageMessage(String(error)))
  }, true)
}
