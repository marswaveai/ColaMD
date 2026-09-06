// Shared plumbing for the image experience. The editor modules stay free of
// main.ts imports: the host app injects its document hooks once at startup
// (configureImageExperience) and everything else goes through window.electronAPI.

export interface SavedImageAsset {
  absPath: string
  relPath: string
  fileUrl: string
}

export interface ImageHostHooks {
  /** True while the plain-textarea source mode is active. */
  isSourceMode(): boolean
  /** Persist the document first (save dialog for untitled docs). Returns its path, or null when cancelled. */
  ensureDocumentSaved(): Promise<string | null>
  /** Splice text at the caret in source mode. */
  insertSourceText(text: string): void
  /** Lightweight transient feedback (toast). */
  notify(message: string): void
}

let hostHooks: ImageHostHooks | null = null

export function configureImageExperience(hooks: ImageHostHooks): void {
  hostHooks = hooks
}

export function imageHooks(): ImageHostHooks | null {
  return hostHooks
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.tif', '.tiff'])

export function isImageFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || isImageFileName(file.name)
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export async function saveImageToAssets(source: { file?: File; srcPath?: string }): Promise<SavedImageAsset | null> {
  if (source.srcPath) {
    return window.electronAPI.saveImage({ srcPath: source.srcPath })
  }
  if (!source.file) return null
  const bytes = new Uint8Array(await source.file.arrayBuffer())
  return window.electronAPI.saveImage({ bytes, suggestedName: source.file.name })
}

// file:// URLs are what the document holds while editing (resolveImagePaths
// on load, paste insertion on save); convert back for "reveal in Finder".
export function filePathFromFileUrl(url: string): string | null {
  if (!/^file:/i.test(url)) {
    return /^[/\\]/.test(url) || /^[A-Za-z]:/.test(url) ? url : null
  }
  try {
    const parsed = new URL(url)
    let filePath = decodeURIComponent(parsed.pathname)
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
    return filePath
  } catch {
    return null
  }
}

const DATA_IMAGE_COUNT_RE = /data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp);base64,/g

export function countEmbeddedDataImages(content: string): number {
  return (content.match(DATA_IMAGE_COUNT_RE) ?? []).length
}
