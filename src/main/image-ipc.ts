import { BrowserWindow, dialog, ipcMain, net, shell } from 'electron'
import { basename, dirname } from 'node:path'
import type { ImageInput, ImageSettings, ImageImportResult, ImageSettingsState } from '../image-types'
import { defaultImageSettings, IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, imageDirectory, loadImageSettings, persistImageSettings, previewImage, storeImage, existingImageInput } from './image-storage'

export function registerImageIPC(options: {
  settingsPath: string
  documentPath: (win: BrowserWindow) => string | null
}): { settings: () => ImageSettings } {
  let settings = { ...defaultImageSettings }
  const ready = loadImageSettings(options.settingsPath).then((saved) => { settings = saved })
  let settingsQueue: Promise<unknown> = ready
  const windowFor = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) throw new Error('The document window is closed.')
    return win
  }
  const assertDocument = (win: BrowserWindow, expectedPath: unknown): string => {
    const path = options.documentPath(win)
    if (!path) throw new Error('Save the Markdown document before importing images.')
    if (path !== expectedPath) throw new Error('The active document changed. Insert the images again.')
    return path
  }
  ipcMain.handle('image-settings-get', async (event): Promise<ImageSettingsState> => {
    await ready
    return { settings, defaults: defaultImageSettings, documentPath: options.documentPath(windowFor(event)) }
  })
  ipcMain.handle('image-settings-save', async (event, value: unknown) => {
    windowFor(event)
    const operation = async (): Promise<ImageSettings> => {
      settings = await persistImageSettings(options.settingsPath, value)
      return settings
    }
    const next = settingsQueue.then(operation, operation)
    settingsQueue = next.catch(() => {})
    return next
  })
  ipcMain.handle('image-settings-preview', async (event, value: ImageSettings) => previewImage(value, options.documentPath(windowFor(event))))
  ipcMain.handle('image-choose-directory', async (event) => {
    const win = windowFor(event)
    const doc = options.documentPath(win)
    const result = await dialog.showOpenDialog(win, { defaultPath: doc ? dirname(doc) : undefined, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('image-select-files', async (event): Promise<ImageInput[]> => {
    const win = windowFor(event)
    const doc = options.documentPath(win)
    const result = await dialog.showOpenDialog(win, {
      defaultPath: doc ? dirname(doc) : undefined, properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
    })
    return result.canceled ? [] : result.filePaths.map((path) => ({ name: basename(path), path, origin: 'file' }))
  })
  const download = async (input: ImageInput): Promise<ImageInput> => {
    const url = new URL(input.url!)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS image URL without credentials.')
    const response = await net.fetch(url.href, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status}).`)
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Image exceeds 50 MB.')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('The image response is empty.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 50 MB.')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    let name = basename(url.pathname) || 'image'
    try { name = decodeURIComponent(name) } catch { /* literal percent */ }
    return { name, data: Buffer.concat(chunks), origin: 'remote' }
  }
  ipcMain.handle('image-import', async (event, inputs: unknown, expectedPath: unknown, forceCopy: unknown): Promise<ImageImportResult> => {
    await ready
    const win = windowFor(event)
    const path = assertDocument(win, expectedPath)
    if (!Array.isArray(inputs) || inputs.length > 100) throw new Error('Select up to 100 images at a time.')
    const snapshot = { ...settings }
    const result: ImageImportResult = { images: [], errors: [] }
    for (const [inputIndex, raw] of inputs.entries()) {
      try {
        assertDocument(win, path)
        if (!raw || typeof raw !== 'object') throw new Error('Invalid image input.')
        let input = raw as ImageInput
        if (typeof input.url === 'string') {
          if (!/^https?:/i.test(input.url)) input = existingImageInput(input.url, path)
          else if (!snapshot.downloadRemote && forceCopy !== true) {
            const url = new URL(input.url)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid image URL.')
            result.images.push({ src: url.href, alt: input.name || '', inputIndex })
            continue
          } else input = await download(input)
        }
        assertDocument(win, path)
        result.images.push({ ...await storeImage(input, snapshot, path, forceCopy === true), inputIndex })
      } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)) }
    }
    assertDocument(win, path)
    return result
  })
  ipcMain.handle('image-reveal-directory', async (event) => {
    await ready
    const win = windowFor(event)
    const doc = options.documentPath(win)
    if (!doc) return 'Save the Markdown document first.'
    const path = imageDirectory(settings, doc)
    // openPath reports missing folders instead of silently creating one.
    return shell.openPath(path)
  })
  return { settings: () => settings }
}
