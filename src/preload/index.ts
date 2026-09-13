import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

type FileOpenedData = { path: string | null; content: string; tabId: number }
type FileChangedData = { content: string; tabId: number }
type TabClosedData = { closedTabId: number; activateTabId: number | null }
export interface TabDocState {
  tabId: number
  path: string | null
  dirty: boolean
  content?: string
}
type DocumentStateSnapshot = { tabs: TabDocState[] }
type ImageExportPreset = 'desktop' | 'mobile'
type ImageExportSnapshot = { html: string; styles: string; bodyClass: string; background: string }
export type FileManagerName = 'finder' | 'explorer' | 'file-manager'

const pendingFileOpened: FileOpenedData[] = []
let fileOpenedHandler: ((data: FileOpenedData) => void) | null = null
const pendingNewTab: number[] = []
let newTabHandler: ((tabId: number) => void) | null = null

// Register these listeners as soon as preload starts. The main process can
// send the initial tab and content before the renderer finishes registering
// its callbacks.
ipcRenderer.on('file-opened', (_event, data: FileOpenedData) => {
  if (fileOpenedHandler) {
    fileOpenedHandler(data)
  } else {
    pendingFileOpened.push(data)
  }
})
ipcRenderer.on('new-tab', (_event, tabId: number) => {
  if (newTabHandler) {
    newTabHandler(tabId)
  } else {
    pendingNewTab.push(tabId)
  }
})

export interface ElectronAPI {
  openFile: () => Promise<{ path: string; content: string } | null>
  openFilePath: (path: string) => Promise<{ path: string; content: string } | null>
  getFileManagerName: () => Promise<FileManagerName>
  revealFile: () => Promise<boolean>
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => Promise<void>
  listSiblings: () => Promise<SiblingFile[] | null>
  openSibling: (path: string) => Promise<boolean>
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean, tabId?: number) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string, tabId?: number) => Promise<string | null>
  newTab: () => Promise<number>
  closeTab: (tabId: number) => Promise<void>
  notifyActiveTab: (tabId: number) => void
  showTabContextMenu: (tabId: number) => Promise<void>
  showTabOverflowMenu: () => Promise<void>
  onRunTabBench: (callback: () => void) => void
  reportTabBench: (result: { docKB: number; tabs: number; perTabHeapMB: number; switchMedianMs: number; switchP95Ms: number; switchMaxMs: number }) => Promise<void>
  exportPDF: () => Promise<boolean>
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  exportDOCX: (content: string) => Promise<boolean>
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => Promise<boolean>
  getLanguage: () => Promise<'zh' | 'en'>
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => void
  loadCustomTheme: () => Promise<{ name: string; css: string } | null>
  loadThemeCSS: (fileName: string) => Promise<string | null>
  reportTheme: (theme: string) => Promise<void>
  getPathForFile: (file: File) => string
  openExternal: (url: string) => void
  onFileChanged: (callback: (data: FileChangedData) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: FileOpenedData) => void) => void
  onNewTab: (callback: (tabId: number) => void) => void
  onTabClosed: (callback: (data: TabClosedData) => void) => void
  onActivateTab: (callback: (tabId: number) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  onMenuExportHTML: (callback: () => void) => void
  onMenuExportDOCX: (callback: () => void) => void
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => void
  onSetTheme: (callback: (theme: string) => void) => void
  onSetCustomCSS: (callback: (css: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
  onSearch: (callback: () => void) => void
  onMathModal: (callback: () => void) => void
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => void
  onToggleFilePanel: (callback: () => void) => void
  onToggleSourceMode: (callback: () => void) => void
  setEditorFont: (prefs: { family: string; size: number }) => Promise<void>
  listSystemFonts: () => Promise<string[]>
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => void
  onOpenFontSettings: (callback: () => void) => void
  reportExternalConflict: () => Promise<void>
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string }) => void) => void
  onUpdateAvailable: (callback: (version: string) => void) => void
  onUpdateDownloaded: (callback: (version: string) => void) => void
  onUpdateProgress: (callback: (percent: number) => void) => void
  onUpdateError: (callback: () => void) => void
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  reportDirty: (isDirty: boolean, tabId?: number) => void
  reportRendererReady: () => void
  onRequestDocumentState: (callback: (requestId: string) => void) => void
  respondDocumentState: (requestId: string, snapshot: DocumentStateSnapshot) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  openFilePath: (path: string) => ipcRenderer.invoke('open-file-path', path),
  getFileManagerName: () => ipcRenderer.invoke('get-file-manager-name') as Promise<FileManagerName>,
  revealFile: () => ipcRenderer.invoke('reveal-file') as Promise<boolean>,
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => ipcRenderer.invoke('entry-context-menu', path, kind) as Promise<void>,
  listSiblings: () => ipcRenderer.invoke('list-siblings'),
  openSibling: (path: string) => ipcRenderer.invoke('open-sibling', path),
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean, tabId?: number) => ipcRenderer.invoke('save-file', content, expectedPath, rebuildMenu, autosave, tabId),
  saveFileAs: (content: string, expectedPath?: string, tabId?: number) => ipcRenderer.invoke('save-file-as', content, expectedPath, tabId),
  newTab: () => ipcRenderer.invoke('new-tab') as Promise<number>,
  closeTab: (tabId: number) => ipcRenderer.invoke('close-tab', tabId) as Promise<void>,
  notifyActiveTab: (tabId: number) => ipcRenderer.send('active-tab-changed', tabId),
  showTabContextMenu: (tabId: number) => ipcRenderer.invoke('tab-context-menu', tabId) as Promise<void>,
  showTabOverflowMenu: () => ipcRenderer.invoke('tab-overflow-menu') as Promise<void>,
  onRunTabBench: (callback: () => void) => {
    ipcRenderer.on('run-tab-bench', () => callback())
  },
  reportTabBench: (result: { docKB: number; tabs: number; perTabHeapMB: number; switchMedianMs: number; switchP95Ms: number; switchMaxMs: number }) =>
    ipcRenderer.invoke('tab-bench-result', result) as Promise<void>,
  exportPDF: () => ipcRenderer.invoke('export-pdf'),
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => ipcRenderer.invoke('export-html', snapshot),
  exportDOCX: (content: string) => ipcRenderer.invoke('export-docx', content),
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => ipcRenderer.invoke('export-image', snapshot, preset),
  getLanguage: () => ipcRenderer.invoke('get-language') as Promise<'zh' | 'en'>,
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => {
    ipcRenderer.on('language-changed', (_event, language) => {
      if (language === 'zh' || language === 'en') callback(language)
    })
  },
  loadCustomTheme: () => ipcRenderer.invoke('load-custom-theme'),
  loadThemeCSS: (fileName: string) => ipcRenderer.invoke('load-theme-css', fileName),
  reportTheme: (theme: string) => ipcRenderer.invoke('report-theme', theme),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onFileChanged: (callback: (data: FileChangedData) => void) => {
    ipcRenderer.on('file-changed', (_event, data: FileChangedData) => callback(data))
  },
  onNewFile: (callback: () => void) => {
    ipcRenderer.on('new-file', () => callback())
  },
  onFileOpened: (callback: (data: FileOpenedData) => void) => {
    fileOpenedHandler = callback
    for (const data of pendingFileOpened.splice(0)) callback(data)
  },
  onNewTab: (callback: (tabId: number) => void) => {
    newTabHandler = callback
    for (const tabId of pendingNewTab.splice(0)) callback(tabId)
  },
  onTabClosed: (callback: (data: TabClosedData) => void) => {
    ipcRenderer.on('tab-closed', (_event, data: TabClosedData) => callback(data))
  },
  onActivateTab: (callback: (tabId: number) => void) => {
    ipcRenderer.on('activate-tab', (_event, tabId: number) => callback(tabId))
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
  onMenuExportDOCX: (callback: () => void) => {
    ipcRenderer.on('menu-export-docx', () => callback())
  },
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => {
    ipcRenderer.on('menu-export-image', (_event, preset) => {
      if (preset === 'desktop' || preset === 'mobile') callback(preset)
    })
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
  onToggleSourceMode: (callback: () => void) => {
    ipcRenderer.on('toggle-source-mode', () => callback())
  },
  setEditorFont: (prefs: { family: string; size: number }) => {
    return ipcRenderer.invoke('set-editor-font', prefs)
  },
  listSystemFonts: () => {
    return ipcRenderer.invoke('list-system-fonts')
  },
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => {
    ipcRenderer.on('editor-font-changed', (_event, prefs) => callback(prefs))
  },
  onOpenFontSettings: (callback: () => void) => {
    ipcRenderer.on('open-font-settings', () => callback())
  },
  reportExternalConflict: () => {
    return ipcRenderer.invoke('report-external-conflict')
  },
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string }) => void) => {
    ipcRenderer.on('external-conflict-result', (_event, result) => callback(result))
  },
  onUpdateAvailable: (callback: (version: string) => void) => {
    ipcRenderer.on('update-available', (_event, version) => callback(version))
  },
  onUpdateDownloaded: (callback: (version: string) => void) => {
    ipcRenderer.on('update-downloaded', (_event, version) => callback(version))
  },
  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('update-progress', (_event, percent) => callback(percent))
  },
  onUpdateError: (callback: () => void) => {
    ipcRenderer.on('update-error', () => callback())
  },
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  reportDirty: (isDirty: boolean, tabId?: number) => ipcRenderer.send('set-dirty', isDirty, tabId),
  reportRendererReady: () => ipcRenderer.send('renderer-ready'),
  onRequestDocumentState: (callback: (requestId: string) => void) => {
    ipcRenderer.on('request-document-state', (_event, requestId) => callback(requestId))
  },
  respondDocumentState: (requestId: string, snapshot: DocumentStateSnapshot) => {
    ipcRenderer.send('document-state-response', requestId, snapshot)
  }
} satisfies ElectronAPI)
