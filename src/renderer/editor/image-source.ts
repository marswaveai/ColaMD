import { captureImageSource } from './editor'
import { imageButton, imageDialog, showImageMessage } from './image-settings'

const t = (cn: string, en: string): string => navigator.language.toLowerCase().startsWith('zh') ? cn : en

export function setupImageSource(host: { documentId: () => number; documentPath: () => string | null; source: () => HTMLTextAreaElement | null }): void {
  document.getElementById('editor')!.addEventListener('contextmenu', (event) => {
    if (host.source() || document.querySelector('dialog[open]')) return
    const image = event.target instanceof Element ? event.target.closest('img') : null
    if (!(image instanceof HTMLImageElement)) return
    const target = captureImageSource(image)
    if (!target) return
    event.preventDefault(); event.stopPropagation()
    const identity = host.documentId()
    const path = host.documentPath()
    void window.electronAPI.showImageScaleMenu(target.scale).then((value) => {
      if (value === null || host.documentId() !== identity || host.documentPath() !== path || host.source()) return
      if (!target.setScale(value)) showImageMessage(t('文档已发生变化，请重新选择图片。', 'The document changed. Select the image again.'))
    }).catch((error) => showImageMessage(String(error)))
  }, true)
  document.getElementById('editor')!.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || host.source() || document.querySelector('dialog[open]')) return
    const image = event.target instanceof Element ? event.target.closest('img') : null
    if (!(image instanceof HTMLImageElement)) return
    const target = captureImageSource(image)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    const identity = host.documentId()
    const documentPath = host.documentPath()
    const current = (): boolean => host.documentId() === identity && host.documentPath() === documentPath && !host.source()
    const ui = imageDialog(t('图片源代码', 'Image Markdown'))
    const label = document.createElement('label')
    label.htmlFor = 'image-source-markdown'
    label.textContent = t('Markdown / HTML 图片语法', 'Markdown / HTML image syntax')
    const input = document.createElement('textarea')
    input.id = label.htmlFor
    input.className = 'image-setting-control image-source-markdown'
    input.rows = 4
    input.spellcheck = false
    input.disabled = true
    const pathLabel = document.createElement('label')
    pathLabel.htmlFor = 'image-source-path'
    pathLabel.textContent = t('图片路径（从源码解析）', 'Image path (from Markdown)')
    const path = document.createElement('input')
    path.id = pathLabel.htmlFor
    path.className = 'image-setting-control'
    path.readOnly = true
    const hint = document.createElement('p')
    hint.className = 'image-setting-hint'
    hint.textContent = t('可修改 ![说明](路径 "标题")；缩放图片使用 HTML img 语法保存比例。修改路径只更新引用，从文件替换会按图片设置导入并保留原文件。', 'Edit ![alt](path "title"); scaled images use HTML img syntax to retain their scale. Editing the path updates its reference; replacing imports a file using Image Settings and retains the original.')
    const status = document.createElement('p')
    status.className = 'image-setting-status'
    status.setAttribute('role', 'status')
    let pending = true
    const update = (): void => {
      const src = target.path(input.value)
      path.value = src ?? ''
      status.textContent = !pending && src === null ? t('请输入一条有效的 Markdown 图片或 HTML img 语法。', 'Enter exactly one Markdown image or HTML img element.') : ''
      apply.disabled = pending || src === null
      copy.disabled = pending || src === null
    }
    const apply = imageButton(t('应用', 'Apply'), () => {
      pending = true; update()
      void window.electronAPI.convertImageSource(input.value, documentPath, 'display').then((markdown) => {
        if (!input.isConnected) return
        if (!current() || !target.apply(markdown)) throw new Error(t('文档已发生变化，请重新打开图片。', 'The document changed. Open the image again.'))
        ui.close()
      }).catch((error) => { if (input.isConnected) { pending = false; update(); status.textContent = String(error) } })
    }, true)
    const copy = imageButton(t('复制 Markdown', 'Copy Markdown'), () => {
      void navigator.clipboard.writeText(input.value).then(() => { status.textContent = t('已复制', 'Copied') }).catch((error) => { status.textContent = String(error) })
    })
    const replace = imageButton(t('从文件替换…', 'Replace from File…'), () => {
      if (pending) return
      if (!documentPath) { status.textContent = t('请先保存文档，再从文件替换图片。', 'Save the document before replacing from a file.'); return }
      pending = true; update()
      void (async () => {
        const inputs = await window.electronAPI.selectImageFiles()
        if (!inputs.length || !input.isConnected || !current()) return
        if (inputs.length !== 1) throw new Error(t('替换图片时请选择一个文件。', 'Choose one file to replace this image.'))
        const result = await window.electronAPI.importImages(inputs, documentPath)
        if (!input.isConnected || !current()) return
        if (!result.images.length) throw new Error(result.errors.join('\n'))
        const image = result.images[0]
        if (!target.apply(target.replacement(image.src, image.alt))) throw new Error(t('文档已发生变化，请重新打开图片。', 'The document changed. Open the image again.'))
        ui.close()
      })().finally(() => {
        pending = false
        if (input.isConnected) update()
      }).catch((error) => { if (input.isConnected) status.textContent = String(error) })
    })
    ui.body.append(label, input, pathLabel, path, hint, status)
    ui.footer.append(replace, copy, imageButton(t('取消', 'Cancel'), ui.close), apply)
    input.addEventListener('input', update)
    input.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !apply.disabled) { event.preventDefault(); apply.click() }
    })
    void window.electronAPI.convertImageSource(target.markdown, documentPath, 'markdown').then((markdown) => {
      if (!input.isConnected) return
      if (!current()) { ui.close(); return }
      input.value = markdown.trim()
      input.disabled = false
      pending = false
      update()
      input.focus()
    }).catch((error) => { ui.close(); showImageMessage(String(error)) })
    update()
  }, true)
}
