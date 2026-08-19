import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

type FileOpenedData = { path: string | null; content: string }

const pendingFileOpened: FileOpenedData[] = []
let fileOpenedHandler: ((data: FileOpenedData) => void) | null = null

// Register this listener as soon as preload starts. The main process can send
// the initial content before the renderer finishes registering its callbacks.
ipcRenderer.on('file-opened', (_event, data: FileOpenedData) => {
  if (fileOpenedHandler) {
    fileOpenedHandler(data)
  } else {
    pendingFileOpened.push(data)
  }
})

export interface ElectronAPI {
  openFile: () => Promise<{ path: string; content: string } | null>
  openFilePath: (path: string) => Promise<{ path: string; content: string } | null>
  listSiblings: () => Promise<SiblingFile[] | null>
  openSibling: (path: string) => Promise<boolean>
  saveFile: (content: string, expectedPath?: string) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string) => Promise<string | null>
  exportPDF: () => Promise<boolean>
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  loadCustomTheme: () => Promise<{ name: string; css: string } | null>
  loadThemeCSS: (fileName: string) => Promise<string | null>
  getPathForFile: (file: File) => string
  openExternal: (url: string) => void
  onFileChanged: (callback: (content: string) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: FileOpenedData) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  onMenuExportHTML: (callback: () => void) => void
  onSetTheme: (callback: (theme: string) => void) => void
  onSetCustomCSS: (callback: (css: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
  onAgentActivity: (callback: (state: string) => void) => void
  onSearch: (callback: () => void) => void
  onMathModal: (callback: () => void) => void
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => void
  onToggleFilePanel: (callback: () => void) => void
  onUpdateAvailable: (callback: (version: string) => void) => void
  onUpdateDownloaded: (callback: (version: string) => void) => void
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  reportDirty: (isDirty: boolean) => void
  reportRendererReady: () => void
  onRequestDocumentState: (callback: (requestId: string) => void) => void
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string }) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  openFilePath: (path: string) => ipcRenderer.invoke('open-file-path', path),
  listSiblings: () => ipcRenderer.invoke('list-siblings'),
  openSibling: (path: string) => ipcRenderer.invoke('open-sibling', path),
  saveFile: (content: string, expectedPath?: string) => ipcRenderer.invoke('save-file', content, expectedPath),
  saveFileAs: (content: string, expectedPath?: string) => ipcRenderer.invoke('save-file-as', content, expectedPath),
  exportPDF: () => ipcRenderer.invoke('export-pdf'),
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => ipcRenderer.invoke('export-html', snapshot),
  loadCustomTheme: () => ipcRenderer.invoke('load-custom-theme'),
  loadThemeCSS: (fileName: string) => ipcRenderer.invoke('load-theme-css', fileName),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onFileChanged: (callback: (content: string) => void) => {
    ipcRenderer.on('file-changed', (_event, content) => callback(content))
  },
  onNewFile: (callback: () => void) => {
    ipcRenderer.on('new-file', () => callback())
  },
  onFileOpened: (callback: (data: FileOpenedData) => void) => {
    fileOpenedHandler = callback
    for (const data of pendingFileOpened.splice(0)) callback(data)
  },
  onMenuOpen: (callback: () => void) => {
    ipcRenderer.on('menu-open', () => callback())
  },
  onMenuSave: (callback: () => void) => {
    ipcRenderer.on('menu-save', () => callback())
  },
  onMenuSaveAs: (callback: () => void) => {
    ipcRenderer.on('menu-save-as', () => callback())
  },
  onMenuExportPDF: (callback: () => void) => {
    ipcRenderer.on('menu-export-pdf', () => callback())
  },
  onMenuExportHTML: (callback: () => void) => {
    ipcRenderer.on('menu-export-html', () => callback())
  },
  onSetTheme: (callback: (theme: string) => void) => {
    ipcRenderer.on('set-theme', (_event, theme) => callback(theme))
  },
  onSetCustomCSS: (callback: (css: string) => void) => {
    ipcRenderer.on('set-custom-css', (_event, css) => callback(css))
  },
  onMenuImportTheme: (callback: () => void) => {
    ipcRenderer.on('menu-import-theme', () => callback())
  },
  onAgentActivity: (callback: (state: string) => void) => {
    ipcRenderer.on('agent-activity', (_event, state) => callback(state))
  },
  onSearch: (callback: () => void) => {
    ipcRenderer.on('editor:search', () => callback())
  },
  onMathModal: (callback: () => void) => {
    ipcRenderer.on('editor:math', () => callback())
  },
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => {
    ipcRenderer.on('siblings-changed', (_event, files) => callback(files))
  },
  onToggleFilePanel: (callback: () => void) => {
    ipcRenderer.on('toggle-file-panel', () => callback())
  },
  onUpdateAvailable: (callback: (version: string) => void) => {
    ipcRenderer.on('update-available', (_event, version) => callback(version))
  },
  onUpdateDownloaded: (callback: (version: string) => void) => {
    ipcRenderer.on('update-downloaded', (_event, version) => callback(version))
  },
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  reportDirty: (isDirty: boolean) => ipcRenderer.send('set-dirty', isDirty),
  reportRendererReady: () => ipcRenderer.send('renderer-ready'),
  onRequestDocumentState: (callback: (requestId: string) => void) => {
    ipcRenderer.on('request-document-state', (_event, requestId) => callback(requestId))
  },
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string }) => {
    ipcRenderer.send('document-state-response', requestId, snapshot)
  }
} satisfies ElectronAPI)
