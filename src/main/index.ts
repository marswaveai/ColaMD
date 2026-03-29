import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { watch, FSWatcher } from 'fs'

// Per-window state
interface WindowState {
  filePath: string | null
  watcher: FSWatcher | null
  isInternalSave: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const windowStates = new Map<number, WindowState>()
let pendingFilePaths: string[] = []

function getState(win: BrowserWindow): WindowState {
  let state = windowStates.get(win.id)
  if (!state) {
    state = { filePath: null, watcher: null, isInternalSave: false, debounceTimer: null }
    windowStates.set(win.id, state)
  }
  return state
}

function getWinFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function createWindow(filePath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const state = getState(win)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    if (filePath) {
      loadFileInWindow(win, filePath)
    }
  })

  win.on('closed', () => {
    stopWatching(state)
    windowStates.delete(win.id)
  })

  updateTitle(win)
  return win
}

function updateTitle(win: BrowserWindow): void {
  const state = getState(win)
  const fileName = state.filePath ? basename(state.filePath) : 'Untitled'
  win.setTitle(`${fileName} — ColaMD`)
}

function stopWatching(state: WindowState): void {
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }
}

function watchFile(win: BrowserWindow, state: WindowState): void {
  if (!state.filePath) return
  stopWatching(state)
  const filePath = state.filePath
  state.watcher = watch(filePath, (eventType) => {
    if (eventType !== 'change' || state.isInternalSave) return
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      readFile(filePath, 'utf-8')
        .then((data) => {
          if (!win.isDestroyed()) win.webContents.send('file-changed', data)
        })
        .catch(() => {})
    }, 100)
  })
}

function loadFileInWindow(win: BrowserWindow, filePath: string): void {
  readFile(filePath, 'utf-8')
    .then((data) => {
      const state = getState(win)
      state.filePath = filePath
      watchFile(win, state)
      updateTitle(win)
      win.webContents.send('file-opened', { path: filePath, content: data })
    })
    .catch(() => {})
}

// Find window that already has this file open
function findWindowForFile(filePath: string): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (state.filePath === filePath) {
      return BrowserWindow.fromId(id) || null
    }
  }
  return null
}

// Open file: reuse existing window or create new one
function openFile(filePath: string): void {
  // If already open, focus that window
  const existing = findWindowForFile(filePath)
  if (existing) {
    existing.focus()
    return
  }

  // Find an untitled empty window to reuse
  const emptyWin = findEmptyWindow()
  if (emptyWin) {
    loadFileInWindow(emptyWin, filePath)
    emptyWin.focus()
    return
  }

  // Create new window
  const win = createWindow(filePath)
  win.focus()
}

function findEmptyWindow(): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (!state.filePath) {
      return BrowserWindow.fromId(id) || null
    }
  }
  return null
}

async function saveToPath(win: BrowserWindow, filePath: string, content: string): Promise<boolean> {
  const state = getState(win)
  try {
    state.isInternalSave = true
    await writeFile(filePath, content, 'utf-8')
    state.filePath = filePath
    watchFile(win, state)
    updateTitle(win)
    return true
  } catch {
    return false
  } finally {
    setTimeout(() => { state.isInternalSave = false }, 100)
  }
}

// IPC Handlers

ipcMain.handle('open-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]

  // If this window has no file, load here; otherwise open in new window
  const state = getState(win)
  if (!state.filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      watchFile(win, state)
      updateTitle(win)
      return { path: filePath, content }
    } catch {
      return null
    }
  } else {
    openFile(filePath)
    return null
  }
})

ipcMain.handle('open-file-path', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)

  // If this window has no file, load here
  if (!state.filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      watchFile(win, state)
      updateTitle(win)
      return { path: filePath, content }
    } catch {
      return null
    }
  } else {
    openFile(filePath)
    return null
  }
})

ipcMain.handle('save-file', async (event, content: string) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const state = getState(win)
  if (!state.filePath) {
    const result = await dialog.showSaveDialog(win, {
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return false
    state.filePath = result.filePath
  }
  return saveToPath(win, state.filePath, content)
})

ipcMain.handle('save-file-as', async (event, content: string) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return false
  return saveToPath(win, result.filePath, content)
})

ipcMain.handle('export-pdf', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    const pdfData = await win.webContents.printToPDF({
      marginType: 0,
      printBackground: true,
      pageSize: 'A4'
    })
    await writeFile(result.filePath, pdfData)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('load-custom-theme', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [{ name: 'CSS', extensions: ['css'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  try {
    return await readFile(result.filePaths[0], 'utf-8')
  } catch {
    return null
  }
})

// Menu — targets the focused window

function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = getFocusedWindow()
  if (win) win.webContents.send(channel, ...args)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'ColaMD',
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu-open')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu-save')
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToFocused('menu-save-as')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Theme',
      submenu: [
        {
          label: 'Light',
          click: () => sendToFocused('set-theme', 'light')
        },
        {
          label: 'Dark',
          click: () => sendToFocused('set-theme', 'dark')
        },
        {
          label: 'Elegant',
          click: () => sendToFocused('set-theme', 'elegant')
        },
        {
          label: 'Newsprint',
          click: () => sendToFocused('set-theme', 'newsprint')
        },
        { type: 'separator' },
        {
          label: 'Import Theme...',
          click: () => sendToFocused('menu-import-theme')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About ColaMD',
          click: () => shell.openExternal('https://github.com/marswaveai/colamd')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// App lifecycle

app.whenReady().then(() => {
  buildMenu()

  // Check command line args for file paths
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  const fileArgs = args.filter((arg) => !arg.startsWith('-'))
  if (fileArgs.length > 0) {
    pendingFilePaths = fileArgs
  }

  if (pendingFilePaths.length > 0) {
    for (const fp of pendingFilePaths) {
      createWindow(fp)
    }
    pendingFilePaths = []
  } else {
    createWindow()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady()) {
    openFile(filePath)
  } else {
    pendingFilePaths.push(filePath)
  }
})
