import { createHash } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'

// Asset folder convention: images pasted/dropped/inserted into a document are
// copied next to it so the whole folder stays portable (design decision in
// docs/feature-requests.md "Import local images").
export const IMAGE_ASSET_DIRNAME = 'assets'

const MIME_IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
}

const EXT_IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.tif', '.tiff'])

export function isImageMime(mime: string): boolean {
  return mime in MIME_IMAGE_TYPES
}

export function isImageExtension(fileName: string): boolean {
  return EXT_IMAGE_TYPES.has(extname(fileName).toLowerCase())
}

export function imageExtensionFor(mimeOrName: string): string {
  if (MIME_IMAGE_TYPES[mimeOrName]) return MIME_IMAGE_TYPES[mimeOrName]
  const ext = extname(mimeOrName).toLowerCase()
  return EXT_IMAGE_TYPES.has(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.png'
}

// Files are named by the SHA-256 of their bytes (content-addressed, the same
// dedup scheme as MarkText): pasting the same screenshot twice reuses one
// file instead of accumulating timestamped copies.
export function sha256ImageName(bytes: Buffer | Uint8Array, ext: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return `${hash}${ext}`
}

export function assetDirForDocument(docPath: string | null): string | null {
  if (!docPath) return null
  return join(dirname(docPath), IMAGE_ASSET_DIRNAME)
}

export interface SavedImageAsset {
  absPath: string
  relPath: string
  fileUrl: string
}

export interface SaveImageAssetOptions {
  docPath: string
  bytes?: Uint8Array
  srcPath?: string
  suggestedName?: string
}

// Write an image into the document's asset folder and return both the
// absolute path (for rendering) and the doc-relative path (for source mode
// hints). A `srcPath` already living in the asset folder is reused as-is.
export async function saveImageAsset(options: SaveImageAssetOptions): Promise<SavedImageAsset> {
  const { docPath, bytes, srcPath, suggestedName } = options
  const dir = assetDirForDocument(docPath)
  if (!dir) throw new Error('no document path')

  if (srcPath) {
    const ext = imageExtensionFor(srcPath)
    const buffer = await readFile(srcPath)
    const name = sha256ImageName(buffer, ext)
    const target = join(dir, name)
    if (resolve(srcPath) === resolve(target)) {
      return toSavedAsset(srcPath, docPath)
    }
    await mkdir(dir, { recursive: true })
    await copyFile(srcPath, target)
    return toSavedAsset(target, docPath)
  }

  if (bytes) {
    const ext = imageExtensionFor(suggestedName ?? 'image.png')
    const name = sha256ImageName(bytes, ext)
    await mkdir(dir, { recursive: true })
    const target = join(dir, name)
    await writeFile(target, bytes)
    return toSavedAsset(target, docPath)
  }

  throw new Error('saveImageAsset requires bytes or srcPath')
}

function toSavedAsset(absPath: string, docPath: string): SavedImageAsset {
  const relPath = relative(dirname(docPath), absPath).replaceAll('\\', '/')
  return { absPath, relPath, fileUrl: pathToFileURL(absPath).href }
}

// Markdown destination escaping: wrap paths containing spaces/parens in
// angle brackets so `![](path)` stays a single link destination.
export function markdownImagePath(value: string): string {
  return /[\s()]/.test(value) ? `<${value}>` : value
}

const DATA_IMAGE_RE = /data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp);base64,([A-Za-z0-9+/=]+)/g

export interface EmbeddedImageExtraction {
  content: string
  count: number
}

// One-click cleanup for legacy documents that carry base64 data URIs inline
// (the pre-pipeline leak). Every data URI is written to the asset folder and
// rewritten as a doc-relative reference, in both `![](data:...)` and
// `<img src="data:...">` positions.
export async function extractEmbeddedImages(content: string, docPath: string): Promise<EmbeddedImageExtraction> {
  const dir = assetDirForDocument(docPath)
  if (!dir) return { content, count: 0 }

  const replacements = new Map<string, string>()
  let count = 0

  const chunks: string[] = []
  let lastIndex = 0
  for (const match of content.matchAll(DATA_IMAGE_RE)) {
    const dataUri = match[0]
    let relPath = replacements.get(dataUri)
    if (!relPath) {
      try {
        const bytes = Buffer.from(match[1], 'base64')
        const saved = await saveImageAsset({ docPath, bytes, suggestedName: 'image.png' })
        relPath = markdownImagePath(saved.relPath)
        replacements.set(dataUri, relPath)
        count += 1
      } catch {
        // Unreadable data URI: keep it inline rather than dropping content.
        continue
      }
    }
    chunks.push(content.slice(lastIndex, match.index), relPath)
    lastIndex = match.index + dataUri.length
  }
  if (count === 0) return { content, count: 0 }
  chunks.push(content.slice(lastIndex))
  return { content: chunks.join(''), count }
}

// An image reference already inside the document's asset folder (or anywhere
// under the doc dir) is referenced as-is instead of copied.
export function isInsideDocumentDir(candidatePath: string, docPath: string): boolean {
  const rel = relative(dirname(docPath), resolve(candidatePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
