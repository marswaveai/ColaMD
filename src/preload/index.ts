import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface ElectronAPI {
  openFile: () => Promise<{ path: string; content: string } | null>
  openFilePath: (path: string) => Promise<{ path: string; content: string } | null>
  saveFile: (content: string) => Promise<boolean>
  saveFileAs: (content: string) => Promise<boolean>
  exportPDF: () => Promise<boolean>
  loadCustomTheme: () => Promise<string | null>
  getPathForFile: (file: File) => string
  onFileChanged: (callback: (content: string) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: { path: string; content: string }) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  onSetTheme: (callback: (theme: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  openFilePath: (path: string) => ipcRenderer.invoke('open-file-path', path),
  saveFile: (content: string) => ipcRenderer.invoke('save-file', content),
  saveFileAs: (content: string) => ipcRenderer.invoke('save-file-as', content),
  exportPDF: () => ipcRenderer.invoke('export-pdf'),
  loadCustomTheme: () => ipcRenderer.invoke('load-custom-theme'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onFileChanged: (callback: (content: string) => void) => {
    ipcRenderer.on('file-changed', (_event, content) => callback(content))
  },
  onNewFile: (callback: () => void) => {
    ipcRenderer.on('new-file', () => callback())
  },
  onFileOpened: (callback: (data: { path: string; content: string }) => void) => {
    ipcRenderer.on('file-opened', (_event, data) => callback(data))
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
  onSetTheme: (callback: (theme: string) => void) => {
    ipcRenderer.on('set-theme', (_event, theme) => callback(theme))
  },
  onMenuImportTheme: (callback: () => void) => {
    ipcRenderer.on('menu-import-theme', () => callback())
  }
} satisfies ElectronAPI)
