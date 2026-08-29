import { contextBridge, ipcRenderer, webUtils } from 'electron';
const pendingFileOpened = [];
let fileOpenedHandler = null;
// Register this listener as soon as preload starts. The main process can send
// the initial content before the renderer finishes registering its callbacks.
ipcRenderer.on('file-opened', (_event, data) => {
    if (fileOpenedHandler) {
        fileOpenedHandler(data);
    }
    else {
        pendingFileOpened.push(data);
    }
});
contextBridge.exposeInMainWorld('electronAPI', {
    openFile: () => ipcRenderer.invoke('open-file'),
    openFilePath: (path) => ipcRenderer.invoke('open-file-path', path),
    listSiblings: () => ipcRenderer.invoke('list-siblings'),
    openSibling: (path) => ipcRenderer.invoke('open-sibling', path),
    saveFile: (content, expectedPath, rebuildMenu) => ipcRenderer.invoke('save-file', content, expectedPath, rebuildMenu),
    saveFileAs: (content, expectedPath) => ipcRenderer.invoke('save-file-as', content, expectedPath),
    exportPDF: () => ipcRenderer.invoke('export-pdf'),
    exportHTML: (snapshot) => ipcRenderer.invoke('export-html', snapshot),
    exportDOCX: (content) => ipcRenderer.invoke('export-docx', content),
    exportImage: (snapshot, preset) => ipcRenderer.invoke('export-image', snapshot, preset),
    loadCustomTheme: () => ipcRenderer.invoke('load-custom-theme'),
    loadThemeCSS: (fileName) => ipcRenderer.invoke('load-theme-css', fileName),
    reportTheme: (theme) => ipcRenderer.invoke('report-theme', theme),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    openExternal: (url) => ipcRenderer.send('open-external', url),
    onFileChanged: (callback) => {
        ipcRenderer.on('file-changed', (_event, content) => callback(content));
    },
    onNewFile: (callback) => {
        ipcRenderer.on('new-file', () => callback());
    },
    onFileOpened: (callback) => {
        fileOpenedHandler = callback;
        for (const data of pendingFileOpened.splice(0))
            callback(data);
    },
    onMenuOpen: (callback) => {
        ipcRenderer.on('menu-open', () => callback());
    },
    onMenuSave: (callback) => {
        ipcRenderer.on('menu-save', () => callback());
    },
    onMenuSaveAs: (callback) => {
        ipcRenderer.on('menu-save-as', () => callback());
    },
    onMenuExportPDF: (callback) => {
        ipcRenderer.on('menu-export-pdf', () => callback());
    },
    onMenuExportHTML: (callback) => {
        ipcRenderer.on('menu-export-html', () => callback());
    },
    onMenuExportDOCX: (callback) => {
        ipcRenderer.on('menu-export-docx', () => callback());
    },
    onMenuExportImage: (callback) => {
        ipcRenderer.on('menu-export-image', (_event, preset) => {
            if (preset === 'desktop' || preset === 'mobile')
                callback(preset);
        });
    },
    onSetTheme: (callback) => {
        ipcRenderer.on('set-theme', (_event, theme) => callback(theme));
    },
    onSetCustomCSS: (callback) => {
        ipcRenderer.on('set-custom-css', (_event, css) => callback(css));
    },
    onMenuImportTheme: (callback) => {
        ipcRenderer.on('menu-import-theme', () => callback());
    },
    onAgentActivity: (callback) => {
        ipcRenderer.on('agent-activity', (_event, state) => callback(state));
    },
    onSearch: (callback) => {
        ipcRenderer.on('editor:search', () => callback());
    },
    onMathModal: (callback) => {
        ipcRenderer.on('editor:math', () => callback());
    },
    onSiblingsChanged: (callback) => {
        ipcRenderer.on('siblings-changed', (_event, files) => callback(files));
    },
    onToggleFilePanel: (callback) => {
        ipcRenderer.on('toggle-file-panel', () => callback());
    },
    onToggleSourceMode: (callback) => {
        ipcRenderer.on('toggle-source-mode', () => callback());
    },
    setEditorFont: (prefs) => {
        return ipcRenderer.invoke('set-editor-font', prefs);
    },
    listSystemFonts: () => {
        return ipcRenderer.invoke('list-system-fonts');
    },
    onEditorFontChanged: (callback) => {
        ipcRenderer.on('editor-font-changed', (_event, prefs) => callback(prefs));
    },
    onOpenFontSettings: (callback) => {
        ipcRenderer.on('open-font-settings', () => callback());
    },
    reportExternalConflict: () => {
        return ipcRenderer.invoke('report-external-conflict');
    },
    onExternalConflictResult: (callback) => {
        ipcRenderer.on('external-conflict-result', (_event, result) => callback(result));
    },
    onUpdateAvailable: (callback) => {
        ipcRenderer.on('update-available', (_event, version) => callback(version));
    },
    onUpdateDownloaded: (callback) => {
        ipcRenderer.on('update-downloaded', (_event, version) => callback(version));
    },
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    reportDirty: (isDirty) => ipcRenderer.send('set-dirty', isDirty),
    reportRendererReady: () => ipcRenderer.send('renderer-ready'),
    onRequestDocumentState: (callback) => {
        ipcRenderer.on('request-document-state', (_event, requestId) => callback(requestId));
    },
    respondDocumentState: (requestId, snapshot) => {
        ipcRenderer.send('document-state-response', requestId, snapshot);
    }
});
