import type { ImageSettings } from '../../image-types'

const zh = (): boolean => navigator.language.toLowerCase().startsWith('zh')
const t = (cn: string, en: string): string => zh() ? cn : en

export function imageDialog(title: string): { body: HTMLDivElement; footer: HTMLDivElement; close: () => void } {
  const previous = document.activeElement as HTMLElement | null
  const dialog = document.createElement('dialog')
  dialog.className = 'math-modal image-modal'
  const heading = document.createElement('h3')
  heading.id = 'image-dialog-title'
  heading.textContent = title
  dialog.setAttribute('aria-labelledby', heading.id)
  const body = document.createElement('div')
  body.className = 'image-modal-body'
  const footer = document.createElement('div')
  footer.className = 'math-modal-footer'
  const close = (): void => { dialog.close(); dialog.remove(); previous?.focus() }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close() })
  dialog.append(heading, body, footer)
  document.body.append(dialog)
  dialog.showModal()
  return { body, footer, close }
}

export function imageButton(text: string, action: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `math-modal-btn ${primary ? 'save' : 'cancel'}`
  button.textContent = text
  button.addEventListener('click', action)
  return button
}

export function showImageMessage(message: string): void {
  const ui = imageDialog(t('图片', 'Image'))
  const text = document.createElement('p')
  text.className = 'image-message'
  text.textContent = message
  ui.body.append(text)
  ui.footer.append(imageButton(t('好', 'OK'), ui.close, true))
}

export async function showImageSettings(): Promise<void> {
  if (document.querySelector('dialog.image-modal')) return
  const state = await window.electronAPI.getImageSettings()
  if (document.querySelector('dialog.image-modal')) return
  let draft = { ...state.settings }
  const ui = imageDialog(t('图片设置', 'Image Settings'))
  const controls = new Map<keyof ImageSettings, HTMLInputElement | HTMLSelectElement>()
  const rows = new Map<keyof ImageSettings, HTMLElement>()
  const help = document.createElement('p')
  help.className = 'image-setting-hint'
  help.textContent = t('应用于以后插入的图片。已有图片可通过“图片 → 复制文档图片到附件目录”整理。', 'Applies to future imports. Use Image → Copy Document Images to Folder to organize existing images.')
  ui.body.append(help)
  const form = document.createElement('div')
  form.className = 'image-settings-grid'
  ui.body.append(form)
  const add = (key: keyof ImageSettings, label: string, choices?: Array<[string, string]>): void => {
    const row = document.createElement('div')
    row.className = 'image-setting-row'
    const title = document.createElement('label')
    title.htmlFor = `image-setting-${key}`
    title.textContent = label
    let control: HTMLInputElement | HTMLSelectElement
    if (choices) {
      control = document.createElement('select')
      for (const [value, text] of choices) control.add(new Option(text, value))
      control.value = String(draft[key])
    } else {
      control = document.createElement('input')
      control.type = typeof draft[key] === 'boolean' ? 'checkbox' : 'text'
      if (control.type === 'checkbox') control.checked = Boolean(draft[key])
      else control.value = String(draft[key])
    }
    control.id = title.htmlFor
    control.className = 'image-setting-control'
    control.addEventListener('change', update)
    control.addEventListener('input', update)
    row.append(title, control)
    controls.set(key, control)
    rows.set(key, row)
    form.append(row)
  }
  add('action', t('插入本地图片时', 'When inserting local files'), [
    ['copy', t('复制到图片目录（推荐）', 'Copy to image folder (recommended)')],
    ['reference', t('保留原文件位置', 'Keep original file location')],
    ['embed', t('内嵌到 Markdown', 'Embed in Markdown')]
  ])
  const documentName = t('{文档名}', '{document-name}')
  const imageName = t('{图片名}.{扩展名}', '{image-name}.{ext}')
  const documentFolder = t('文档所在目录/', 'Document folder/')
  const rootFolder = t('{根目录}', '{root-folder}')
  const subfolder = t('{子目录}', '{subfolder}')
  const customFolder = t('{自定义目录}', '{custom-folder}')
  const examples: Array<{ value: ImageSettings['folder']; path: string; folders: string[] }> = [
    { value: 'document-assets', path: `./${documentName}.assets/${imageName}`, folders: [`${documentName}.assets`] },
    { value: 'document', path: `./${imageName}`, folders: [] },
    { value: 'assets', path: `./assets/${imageName}`, folders: ['assets'] },
    { value: 'hidden', path: `./.assets/${imageName}`, folders: ['.assets'] },
    { value: 'hidden-document', path: `./.assets/${documentName}/${imageName}`, folders: ['.assets', documentName] },
    { value: 'root', path: `${rootFolder}/${subfolder}/${imageName}`, folders: [subfolder] },
    { value: 'custom', path: `${customFolder}/${imageName}`, folders: [] }
  ]
  add('folder', t('图片保存位置', 'Image folder'), examples.map(({ value, path }) => [value, path]))
  rows.get('folder')!.classList.add('image-folder-row')
  const structure = document.createElement('pre')
  structure.className = 'image-folder-structure'
  structure.id = 'image-folder-structure'
  structure.setAttribute('aria-label', t('目录结构示意', 'Folder structure example'))
  const structureHint = document.createElement('p')
  structureHint.className = 'image-setting-hint image-folder-hint'
  structureHint.id = 'image-folder-hint'
  structureHint.textContent = t(
    './ 表示文档所在目录。{文档名} 不含扩展名；{图片名}.{扩展名} 表示最终图片文件，由下方命名规则决定。花括号仅作示意。',
    './ means the document folder. {document-name} excludes its extension; {image-name}.{ext} is the final image filename, set by the naming rules below. Braces indicate placeholders in these examples.'
  )
  controls.get('folder')!.setAttribute('aria-describedby', 'image-folder-structure image-folder-hint')
  form.append(structure, structureHint)
  add('rootDirectory', t('根目录', 'Root directory'))
  add('rootFolder', t('根目录内的子目录（可留空）', 'Subfolder inside root (optional)'))
  add('customFolder', t('自定义目录', 'Custom folder'))
  for (const key of ['rootDirectory', 'customFolder'] as const) {
    const button = imageButton(t('选择…', 'Choose…'), () => {
      void window.electronAPI.chooseImageDirectory().then((path) => {
        if (path && controls.get(key)?.isConnected) { controls.get(key)!.value = path; update() }
      }).catch((error) => { status.textContent = String(error) })
    })
    rows.get(key)!.append(button)
  }
  const naming: Array<[string, string]> = [
    ['original', t('原文件名', 'Original filename')],
    ['timestamp', t('时间戳（含毫秒）', 'Timestamp (milliseconds)')],
    ['document-timestamp', t('文档名 + 时间戳', 'Document name + timestamp')],
    ['random', t('时间戳 + 随机后缀', 'Timestamp + random suffix')],
    ['hash', t('内容哈希', 'Content hash')],
    ['sequence', t('文档名 + 递增编号', 'Document name + sequence')],
    ['custom', t('自定义命名模板', 'Custom filename template')]
  ]
  add('fileNaming', t('已有图片命名', 'File image names'), naming)
  add('clipboardNaming', t('截图 / 下载图片命名', 'Screenshot / downloaded image names'), naming)
  add('nameTemplate', t('命名模板', 'Filename template'))
  add('relativePath', t('尽可能使用相对路径', 'Use relative paths when possible'))
  add('dotPrefix', t('相对路径添加 ./ 前缀', 'Add ./ to relative paths'))
  add('escapePath', t('对路径中的空格、中文等进行 URL 编码', 'URL-encode spaces and Unicode in paths'))
  add('deduplicate', t('相同内容复用已有图片', 'Reuse images with identical contents'))
  add('downloadRemote', t('插入网络图片时下载到本地', 'Download remote images when inserting'))
  const note = document.createElement('p')
  note.className = 'image-setting-hint'
  note.textContent = t(
    '截图没有原文件时仍保存到图片目录。时间戳使用插入时的本地时间；重名自动追加编号。',
    'Screenshots without an original file still use the image folder. Timestamps use local insertion time; collisions get a numeric suffix.'
  )
  const variables = document.createElement('p')
  variables.className = 'image-setting-hint'
  const preview = document.createElement('pre')
  preview.className = 'image-settings-preview'
  preview.setAttribute('aria-label', t('截图保存预览', 'Screenshot save preview'))
  const status = document.createElement('p')
  status.className = 'image-setting-status'
  status.setAttribute('role', 'status')
  ui.body.append(note, variables, preview, status)
  const apply = imageButton(t('保存', 'Save'), () => {
    apply.disabled = true
    void window.electronAPI.saveImageSettings(draft).then(ui.close).catch((error) => {
      status.textContent = String(error); apply.disabled = false
    })
  }, true)
  ui.footer.append(imageButton(t('恢复默认', 'Reset'), () => {
    draft = { ...state.defaults }
    for (const [key, control] of controls) {
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(draft[key])
      else control.value = String(draft[key])
    }
    update()
  }), imageButton(t('取消', 'Cancel'), ui.close), apply)
  let previewRevision = 0
  function update(): void {
    for (const [key, control] of controls) {
      Object.assign(draft, { [key]: control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value })
    }
    rows.get('rootDirectory')!.hidden = draft.folder !== 'root'
    rows.get('rootFolder')!.hidden = draft.folder !== 'root'
    rows.get('customFolder')!.hidden = draft.folder !== 'custom'
    const example = examples.find(({ value }) => value === draft.folder)!
    const separate = draft.folder === 'root' || draft.folder === 'custom'
    const folders = draft.folder === 'root' && (!draft.rootFolder.trim() || draft.rootFolder.trim() === '.') ? [] : example.folders
    const lines = [documentFolder, `${separate ? '└' : '├'}── ${documentName}.md`]
    if (separate) lines.push('', `${draft.folder === 'root' ? rootFolder : customFolder}/`)
    folders.forEach((folder, index) => lines.push(`${'    '.repeat(index)}└── ${folder}/`))
    lines.push(`${'    '.repeat(folders.length)}└── ${imageName}`)
    structure.textContent = lines.join('\n')
    rows.get('nameTemplate')!.hidden = draft.fileNaming !== 'custom' && draft.clipboardNaming !== 'custom'
    const hints: string[] = []
    if (draft.folder === 'custom' || draft.folder === 'root') hints.push(t('目录变量：', 'Folder variables: ') + '${filename}, ${year}, ${month}')
    if (draft.fileNaming === 'custom' || draft.clipboardNaming === 'custom') hints.push(t('命名变量：', 'Filename variables: ') + '${name}, ${documentName}, ${timestamp}, ${date}, ${time}, ${hash}, ${random}, ${ext}')
    variables.textContent = hints.join('\n')
    variables.hidden = !hints.length
    controls.get('dotPrefix')!.disabled = !draft.relativePath
    const revision = ++previewRevision
    void window.electronAPI.previewImageSettings(draft).then((result) => {
      if (revision !== previewRevision || !preview.isConnected) return
      status.textContent = result.error || ''
      apply.disabled = !!result.error
      preview.textContent = draft.action === 'embed' ? t('图片数据将内嵌在 .md 文件中。', 'Image bytes will be embedded in the .md file.')
        : `${state.documentPath ? '' : t('保存文档后将按实际文档名生成目录。\n', 'Save the document to use its actual filename.\n')}${t('实际图片目录：', 'Image directory: ')}${result.directory}\n${t('实际图片文件名：', 'Image filename: ')}${result.filename}\n${t('Markdown 引用：', 'Markdown reference: ')}\n${result.markdown}`
    }).catch((error) => { status.textContent = String(error); apply.disabled = true })
  }
  update()
  controls.get('action')!.focus()
}
