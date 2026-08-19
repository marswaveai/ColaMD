import { BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export type ImageExportPreset = 'desktop' | 'mobile'

export interface ImageExportSnapshot {
  html: string
  styles: string
  bodyClass: string
  background: string
}

const PRESETS: Record<ImageExportPreset, { width: number; height: number; padding: number }> = {
  desktop: { width: 1200, height: 800, padding: 64 },
  mobile: { width: 414, height: 896, padding: 28 },
}

function exportHTML(snapshot: ImageExportSnapshot, preset: ImageExportPreset): string {
  const { width, padding } = PRESETS[preset]
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: file:; style-src 'unsafe-inline'; img-src 'self' data: blob: https: http: file:; font-src 'self' data:">
  <style>${snapshot.styles}
    html, body { width: ${width}px !important; min-width: ${width}px !important; height: auto !important; min-height: 0 !important; overflow: visible !important; background: ${snapshot.background} !important; }
    body { margin: 0 !important; padding: 0 !important; }
    *::-webkit-scrollbar { display: none !important; }
    #titlebar, #file-panel, #source-editor, #update-banner { display: none !important; }
    #editor { display: block !important; width: ${width}px !important; height: auto !important; min-height: 0 !important; overflow: visible !important; margin: 0 !important; padding: ${padding}px !important; background: ${snapshot.background} !important; }
    #editor .ProseMirror { width: auto !important; max-width: none !important; min-height: 0 !important; }
  </style>
</head>
<body class="${snapshot.bodyClass}"><div id="editor"><div class="ProseMirror">${snapshot.html}</div></div></body>
</html>`
}

async function waitForLayout(win: BrowserWindow): Promise<{ width: number; height: number }> {
  return win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready
    await Promise.all(Array.from(document.images).map((image) => image.complete ? undefined : new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true })
      image.addEventListener('error', resolve, { once: true })
    })))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const editor = document.getElementById('editor')
    const content = editor?.querySelector('.ProseMirror')
    const editorBounds = editor?.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    const editorStyle = editor ? getComputedStyle(editor) : null
    const paddingBottom = editorStyle ? Number.parseFloat(editorStyle.paddingBottom) || 0 : 0
    return {
      width: Math.ceil(editorBounds?.width ?? document.documentElement.scrollWidth),
      height: Math.ceil(contentBounds && editorBounds
        ? contentBounds.bottom - editorBounds.top + paddingBottom
        : editor?.scrollHeight ?? document.documentElement.scrollHeight),
    }
  })()`)
}

export async function renderDocumentPNGs(snapshot: ImageExportSnapshot, preset: ImageExportPreset): Promise<Buffer[]> {
  const { width, height: pageHeight } = PRESETS[preset]
  const win = new BrowserWindow({
    show: false,
    width,
    height: pageHeight,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })

  let tempDir: string | undefined
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'colamd-image-export-'))
    const exportPath = join(tempDir, 'document.html')
    await writeFile(exportPath, exportHTML(snapshot, preset), 'utf8')
    await win.loadFile(exportPath)
    win.webContents.beginFrameSubscription(() => {})
    win.webContents.debugger.attach('1.3')
    const dimensions = await waitForLayout(win)
    const pages: Buffer[] = []
    for (let offset = 0; offset < dimensions.height; offset += pageHeight) {
      const height = Math.min(pageHeight, dimensions.height - offset)
      const screenshot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: offset, width: dimensions.width, height, scale: 2 },
      }) as { data: string }
      pages.push(Buffer.from(screenshot.data, 'base64'))
    }
    return pages
  } finally {
    if (!win.isDestroyed()) {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      win.webContents.endFrameSubscription()
      win.destroy()
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
