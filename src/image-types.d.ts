export type ImageAction = 'copy' | 'reference' | 'embed'
export type ImageFolder = 'document' | 'assets' | 'hidden' | 'document-assets' | 'hidden-document' | 'root' | 'custom'
export type ImageNaming = 'original' | 'timestamp' | 'document-timestamp' | 'random' | 'hash' | 'sequence' | 'custom'
export type ImageAlignment = 'left' | 'center' | 'right'
export interface ImageMenuState { scale: number; alignment: ImageAlignment }
export type ImageMenuAction = { type: 'scale'; value: number } | { type: 'align'; value: ImageAlignment }

export interface ImageSettings {
  action: ImageAction
  folder: ImageFolder
  customFolder: string
  rootDirectory: string
  rootFolder: string
  fileNaming: ImageNaming
  clipboardNaming: ImageNaming
  nameTemplate: string
  relativePath: boolean
  dotPrefix: boolean
  escapePath: boolean
  deduplicate: boolean
  downloadRemote: boolean
}

export interface ImageInput {
  name: string
  path?: string
  data?: Uint8Array
  url?: string
  origin: 'file' | 'clipboard' | 'remote'
}

export interface ImportedImage {
  src: string
  alt: string
  inputIndex?: number
}

export interface ImageImportResult {
  images: ImportedImage[]
  errors: string[]
}

export interface ImageSettingsState {
  settings: ImageSettings
  defaults: ImageSettings
  documentPath: string | null
}

export interface ImagePreview {
  directory: string
  filename: string
  markdown: string
  error?: string
}
