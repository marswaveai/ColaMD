import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

type FileOpenedData = { path: string | null; content: string }
type ImageExportPreset = 'desktop' | 'mobile'
type ImageExportSnapshot = { html: string; styles: string; bodyClass: string; background: string }
export type FileManagerName = 'finder' | 'explorer' | 'file-manager'

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
  getFileManagerName: () => Promise<FileManagerName>
  revealFile: () => Promise<boolean>
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => Promise<void>
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => Promise<void>
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => void
  listSiblings: () => Promise<SiblingFile[] | null>
  listDirectory: (path: string) => Promise<SiblingFile[] | null>
  openSibling: (path: string) => Promise<boolean>
  activateFile: (path: string | null) => Promise<{ content: string; mtime: number } | null>
  setTabFiles: (paths: string[]) => void
  onFocusFile: (callback: (path: string) => void) => void
  onOpenInNewTab: (callback: (path: string) => void) => void
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string) => Promise<string | null>
  exportPDF: () => Promise<boolean>
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  exportDOCX: (content: string) => Promise<boolean>
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => Promise<boolean>
  getLanguage: () => Promise<'zh' | 'en'>
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => void
  loadCustomTheme: () => Promise<{ name: string; css: string } | null>
  loadThemeCSS: (fileName: string) => Promise<string | null>
  reportTheme: (theme: string) => Promise<void>
  reportTitlebarColors: (colors: { background: string; symbol: string }) => Promise<void>
  popupAppMenu: () => Promise<void>
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => void
  getPathForFile: (file: File) => string
  openExternal: (url: string) => void
  onFileChanged: (callback: (content: string) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: FileOpenedData) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuNewTab: (callback: () => void) => void
  onMenuCloseTab: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  onMenuExportHTML: (callback: () => void) => void
  onMenuExportDOCX: (callback: () => void) => void
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => void
  onMenuPlaySlideshow: (callback: () => void) => void
  setSlideshowFullscreen: (on: boolean) => Promise<boolean>
  onSetTheme: (callback: (theme: string) => void) => void
  onSetPanelSide: (callback: (side: string) => void) => void
  reportPanelSide: (side: string) => Promise<void>
  onSetCustomCSS: (callback: (css: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
  onSearch: (callback: () => void) => void
  onMathModal: (callback: () => void) => void
  onFormatCommand: (callback: (id: string) => void) => void
  readClipboardText: () => Promise<string>
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
  reportDirty: (isDirty: boolean) => void
  reportRendererReady: () => void
  onRequestDocumentState: (callback: (requestId: string) => void) => void
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  openFilePath: (path: string) => ipcRenderer.invoke('open-file-path', path),
  getFileManagerName: () => ipcRenderer.invoke('get-file-manager-name') as Promise<FileManagerName>,
  revealFile: () => ipcRenderer.invoke('reveal-file') as Promise<boolean>,
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => ipcRenderer.invoke('entry-context-menu', path, kind) as Promise<void>,
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => ipcRenderer.invoke('tab-context-menu', payload) as Promise<void>,
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => {
    ipcRenderer.on('tab-menu-action', (_event, payload: { action: string; tabId: string }) => callback(payload))
  },
  listSiblings: () => ipcRenderer.invoke('list-siblings'),
  listDirectory: (path: string) => ipcRenderer.invoke('list-directory', path),
  openSibling: (path: string) => ipcRenderer.invoke('open-sibling', path),
  activateFile: (path: string | null) => ipcRenderer.invoke('activate-file', path) as Promise<{ content: string; mtime: number } | null>,
  setTabFiles: (paths: string[]) => { ipcRenderer.send('set-tab-files', paths) },
  onFocusFile: (callback: (path: string) => void) => {
    ipcRenderer.on('focus-file', (_event, path: string) => callback(path))
  },
  onOpenInNewTab: (callback: (path: string) => void) => {
    ipcRenderer.on('open-in-new-tab', (_event, path: string) => callback(path))
  },
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => ipcRenderer.invoke('save-file', content, expectedPath, rebuildMenu, autosave),
  saveFileAs: (content: string, expectedPath?: string) => ipcRenderer.invoke('save-file-as', content, expectedPath),
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
  reportPanelSide: (side: string) => ipcRenderer.invoke('report-panel-side', side),
  reportTitlebarColors: (colors: { background: string; symbol: string }) => ipcRenderer.invoke('report-titlebar-colors', colors),
  popupAppMenu: () => ipcRenderer.invoke('popup-app-menu'),
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
    ipcRenderer.on('fullscreen-changed', (_event, isFullscreen) => callback(isFullscreen === true))
  },
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
  onMenuNewTab: (callback: () => void) => {
    ipcRenderer.on('menu-new-tab', () => callback())
  },
  onMenuCloseTab: (callback: () => void) => {
    ipcRenderer.on('menu-close-tab', () => callback())
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
  onMenuPlaySlideshow: (callback: () => void) => {
    ipcRenderer.on('menu-play-slideshow', () => callback())
  },
  // The deck asks for the whole screen; the main process remembers what the
  // window was before, so leaving the deck does not also leave a full screen the
  // user had chosen for other reasons.
  setSlideshowFullscreen: (on: boolean) => ipcRenderer.invoke('slideshow-fullscreen', on) as Promise<boolean>,
  onSetTheme: (callback: (theme: string) => void) => {
    ipcRenderer.on('set-theme', (_event, theme) => callback(theme))
  },
  onSetPanelSide: (callback: (side: string) => void) => {
    ipcRenderer.on('set-panel-side', (_event, side) => callback(side))
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
  onFormatCommand: (callback: (id: string) => void) => {
    ipcRenderer.on('editor:format', (_event, id: string) => callback(id))
  },
  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text') as Promise<string>,
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
  reportDirty: (isDirty: boolean) => ipcRenderer.send('set-dirty', isDirty),
  reportRendererReady: () => ipcRenderer.send('renderer-ready'),
  onRequestDocumentState: (callback: (requestId: string) => void) => {
    ipcRenderer.on('request-document-state', (_event, requestId) => callback(requestId))
  },
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => {
    ipcRenderer.send('document-state-response', requestId, snapshot)
  }
} satisfies ElectronAPI)
