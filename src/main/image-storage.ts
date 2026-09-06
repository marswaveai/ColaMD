import { createHash, randomBytes } from 'node:crypto'
import { dirname, basename, extname, resolve, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, open, readFile, readdir, stat, unlink, rename } from 'node:fs/promises'
import type { ImageSettings, ImageInput, ImageNaming, ImportedImage, ImagePreview } from '../image-types'

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']
export const defaultImageSettings: ImageSettings = {
  action: 'copy', folder: 'document-assets', customFolder: './${filename}.assets',
  rootDirectory: '', rootFolder: '.assets', fileNaming: 'original', clipboardNaming: 'timestamp',
  nameTemplate: '${documentName}-${timestamp}-${random}.${ext}',
  relativePath: true, dotPrefix: false, escapePath: false, deduplicate: false, downloadRemote: false
}

const namingModes = ['original', 'timestamp', 'document-timestamp', 'random', 'hash', 'sequence', 'custom']
export function validateImageSettings(value: unknown): ImageSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid image settings.')
  const result = { ...defaultImageSettings }
  const input = value as Record<string, unknown>
  for (const key of Object.keys(result) as Array<keyof ImageSettings>) {
    if (typeof input[key] !== typeof result[key]) throw new Error(`Invalid setting: ${key}`)
    Object.assign(result, { [key]: input[key] })
  }
  if (!['copy', 'reference', 'embed'].includes(result.action) ||
      !['document', 'assets', 'hidden', 'document-assets', 'hidden-document', 'root', 'custom'].includes(result.folder) ||
      !namingModes.includes(result.fileNaming) || !namingModes.includes(result.clipboardNaming)) {
    throw new Error('Unknown image option.')
  }
  for (const key of ['customFolder', 'rootDirectory', 'rootFolder', 'nameTemplate'] as const) {
    if (result[key].includes('\0') || result[key].length > 2048) throw new Error(`Invalid setting: ${key}`)
  }
  if (result.folder === 'root' && (!result.rootDirectory || !isAbsolute(result.rootDirectory))) {
    throw new Error('Choose an absolute root directory.')
  }
  if (result.folder === 'root' && (isAbsolute(result.rootFolder) || result.rootFolder.split(/[\\/]/).includes('..'))) {
    throw new Error('The image subfolder must stay inside the selected root.')
  }
  if (result.folder === 'custom' && !result.customFolder.trim()) throw new Error('Enter an image folder.')
  expandFolder(result.customFolder, 'Document', new Date())
  expandFolder(result.rootFolder, 'Document', new Date())
  if (result.fileNaming === 'custom' || result.clipboardNaming === 'custom') {
    imageName('custom', result, '/Document.md', 'image.png', Buffer.from('preview'), new Date())
  }
  return result
}

export async function loadImageSettings(path: string): Promise<ImageSettings> {
  try { return validateImageSettings({ ...defaultImageSettings, ...JSON.parse(await readFile(path, 'utf8')) }) }
  catch { return { ...defaultImageSettings } }
}

export async function persistImageSettings(path: string, value: unknown): Promise<ImageSettings> {
  const settings = validateImageSettings(value)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeExclusive(temp, Buffer.from(JSON.stringify(settings, null, 2) + '\n'))
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
  return settings
}

function safeName(value: string): string {
  let name = value.normalize('NFC').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '-').replace(/[. ]+$/g, '').trim()
  if (!name || name === '.' || name === '..') name = 'image'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name
  while (Buffer.byteLength(name, 'utf8') > 180) name = Array.from(name).slice(0, -1).join('')
  return name
}

function expandFolder(template: string, documentName: string, now: Date): string {
  const values: Record<string, string> = {
    filename: safeName(documentName), year: String(now.getFullYear()), month: String(now.getMonth() + 1).padStart(2, '0')
  }
  return template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown folder variable: ${key}`)
    return values[key]
  })
}

export function imageDirectory(settings: ImageSettings, documentPath: string, now = new Date()): string {
  const dir = dirname(documentPath)
  const name = safeName(basename(documentPath, extname(documentPath)))
  const folders = { document: '.', assets: 'assets', hidden: '.assets', 'document-assets': `${name}.assets`, 'hidden-document': join('.assets', name) }
  if (settings.folder === 'root') return resolve(settings.rootDirectory, expandFolder(settings.rootFolder, name, now))
  if (settings.folder === 'custom') return resolve(dir, expandFolder(settings.customFolder, name, now))
  return resolve(dir, folders[settings.folder])
}

function imageName(mode: ImageNaming, settings: ImageSettings, documentPath: string, original: string, data: Buffer, now: Date): string {
  const pad = (n: number, size = 2): string => String(n).padStart(size, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  const ext = extname(original).slice(1).toLowerCase()
  const values: Record<string, string> = {
    documentName: safeName(basename(documentPath, extname(documentPath))),
    name: safeName(basename(original, extname(original))), date, time, timestamp: `${date}-${time}`,
    hash: createHash('sha256').update(data).digest('hex').slice(0, 16), random: randomBytes(4).toString('hex'), ext
  }
  const templates: Record<ImageNaming, string> = {
    original: '${name}.${ext}', timestamp: 'image-${timestamp}.${ext}',
    'document-timestamp': '${documentName}-${timestamp}.${ext}', random: 'image-${timestamp}-${random}.${ext}',
    hash: '${hash}.${ext}', sequence: '${documentName}-001.${ext}', custom: settings.nameTemplate
  }
  const rendered = templates[mode].replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown filename variable: ${key}`)
    return values[key]
  })
  if (!rendered.trim() || /[\\/]/.test(rendered)) throw new Error('The filename template must be a filename, not a path.')
  // A template cannot change the actual image encoding.
  const stem = rendered.toLowerCase().endsWith('.' + ext) ? rendered.slice(0, -ext.length - 1) : rendered
  return `${safeName(stem)}.${ext}`
}

export function imageSource(target: string, documentPath: string, settings: ImageSettings): string {
  let path = settings.relativePath ? relative(dirname(documentPath), target).replaceAll('\\', '/') : target.replaceAll('\\', '/')
  if (settings.relativePath && !isAbsolute(path) && settings.dotPrefix && !path.startsWith('.')) path = './' + path
  if (settings.escapePath) path = path.split('/').map((part) => encodeURIComponent(part)).join('/')
  return path
}

export function markdownImageSource(value: string): string {
  return /[\s()<>]/.test(value) ? `<${value.replaceAll('<', '%3C').replaceAll('>', '%3E')}>` : value
}

export function previewImage(settings: ImageSettings, documentPath: string | null): ImagePreview {
  try {
    validateImageSettings(settings)
    const doc = documentPath || resolve('Document.md')
    const directory = imageDirectory(settings, doc)
    const filename = imageName(settings.clipboardNaming, settings, doc, 'image.png', Buffer.from('preview'), new Date())
    const src = imageSource(join(directory, filename), doc, settings)
    return { directory, filename, markdown: `![](${markdownImageSource(src)})` }
  } catch (error) {
    return { directory: '', filename: '', markdown: '', error: error instanceof Error ? error.message : String(error) }
  }
}

function imageFormat(data: Buffer): { extension: string; mime: string } {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { extension: 'png', mime: 'image/png' }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' }
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return { extension: 'gif', mime: 'image/gif' }
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return { extension: 'webp', mime: 'image/webp' }
  if (data.subarray(0, 2).toString() === 'BM') return { extension: 'bmp', mime: 'image/bmp' }
  if (data.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(data.subarray(8, 32).toString())) return { extension: 'avif', mime: 'image/avif' }
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(data.subarray(0, 4096).toString('utf8'))) return { extension: 'svg', mime: 'image/svg+xml' }
  throw new Error('Unsupported image data. Use PNG, JPEG, GIF, WebP, BMP, SVG or AVIF.')
}

async function writeExclusive(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, 'wx')
  try { await handle.writeFile(data) }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error }
  await handle.close()
}

async function storeImageContents(input: ImageInput, settings: ImageSettings, documentPath: string, forceCopy = false): Promise<ImportedImage> {
  if (!input || typeof input.name !== 'string' || !['file', 'clipboard', 'remote'].includes(input.origin)) throw new Error('Invalid image input.')
  let data: Buffer
  if (typeof input.path === 'string') {
    if (!isAbsolute(input.path)) throw new Error('Image file path must be absolute.')
    const info = await stat(input.path)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Image must be a file smaller than 50 MB.')
    data = await readFile(input.path)
  } else if (input.data instanceof Uint8Array) data = Buffer.from(input.data)
  else throw new Error('Missing image bytes.')
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('Image must be smaller than 50 MB.')
  const format = imageFormat(data)
  const originalExt = extname(input.name)
  const formatExtension = format.extension === 'jpg' && /^\.jpeg$/i.test(originalExt) ? 'jpeg' : format.extension
  const original = `${basename(input.name, originalExt) || 'image'}.${formatExtension}`
  const alt = basename(input.name, originalExt)
  if (!forceCopy && settings.action === 'embed') return { src: `data:${format.mime};base64,${data.toString('base64')}`, alt }
  if (!forceCopy && settings.action === 'reference' && input.path) return { src: pathToFileURL(input.path).href, alt }
  const directory = imageDirectory(settings, documentPath)
  await mkdir(directory, { recursive: true })
  if (settings.deduplicate) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !IMAGE_EXTENSIONS.includes(extname(entry.name).slice(1).toLowerCase())) continue
      const path = join(directory, entry.name)
      const info = await stat(path).catch(() => null)
      if (info?.size === data.length && (await readFile(path)).equals(data)) return { src: pathToFileURL(path).href, alt }
    }
  }
  const mode = input.origin === 'file' ? settings.fileNaming : settings.clipboardNaming
  const name = imageName(mode, settings, documentPath, original, data, new Date())
  const extension = extname(name)
  const stem = basename(name, extension)
  for (let index = 0; index < 10000; index++) {
    const candidate = mode === 'sequence'
      ? `${safeName(basename(documentPath, extname(documentPath)))}-${String(index + 1).padStart(3, '0')}${extension}`
      : `${stem}${index ? '-' + index : ''}${extension}`
    const path = join(directory, candidate)
    if (input.path && resolve(input.path) === resolve(path)) return { src: pathToFileURL(path).href, alt }
    try { await writeExclusive(path, data); return { src: pathToFileURL(path).href, alt } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((settings.deduplicate || mode === 'hash') && (await readFile(path)).equals(data)) return { src: pathToFileURL(path).href, alt }
    }
  }
  throw new Error('Too many images with this name. Choose another naming rule.')
}

// Serialize writes per destination so deduplication also holds across windows
// and concurrent clipboard requests. Different image folders remain independent.
const directoryWrites = new Map<string, Promise<unknown>>()
export async function storeImage(input: ImageInput, settings: ImageSettings, documentPath: string, forceCopy = false): Promise<ImportedImage> {
  const directory = imageDirectory(settings, documentPath)
  const previous = directoryWrites.get(directory) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => storeImageContents(input, settings, documentPath, forceCopy))
  directoryWrites.set(directory, next)
  try { return await next }
  finally { if (directoryWrites.get(directory) === next) directoryWrites.delete(directory) }
}

export function existingImageInput(src: string, documentPath: string): ImageInput {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(src)
  if (match) return { name: 'image.png', data: Buffer.from(match[1], 'base64'), origin: 'clipboard' }
  if (/^https?:/i.test(src)) return { name: 'image', url: src, origin: 'remote' }
  if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^file:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) throw new Error('Unsupported image URL.')
  let decoded = src
  if (!/^file:/i.test(src)) { try { decoded = decodeURIComponent(src) } catch { /* literal percent in a filename */ } }
  const path = /^file:/i.test(src) ? fileURLToPath(src) : resolve(dirname(documentPath), decoded)
  return { name: basename(path), path, origin: 'file' }
}
