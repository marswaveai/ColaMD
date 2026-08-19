import { BrowserWindow, NativeImage } from 'electron'
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
  const { width, height: pageHeight, padding } = PRESETS[preset]
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
    #export-scroll-spacer { height: ${pageHeight}px; }
  </style>
</head>
<body class="${snapshot.bodyClass}"><div id="editor"><div class="ProseMirror">${snapshot.html}</div></div><div id="export-scroll-spacer"></div></body>
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

async function scrollToPage(win: BrowserWindow, offset: number): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    window.scrollTo(0, ${offset})
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
}

function capturePNG(image: NativeImage, cssWidth: number, cssHeight: number): Buffer {
  const { width, height } = image.getSize()
  const targetHeight = Math.min(height, Math.max(1, Math.round(cssHeight * width / cssWidth)))
  return targetHeight === height
    ? image.toPNG()
    : image.crop({ x: 0, y: 0, width, height: targetHeight }).toPNG()
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
    const dimensions = await waitForLayout(win)
    const pages: Buffer[] = []
    for (let offset = 0; offset < dimensions.height; offset += pageHeight) {
      const height = Math.min(pageHeight, dimensions.height - offset)
      await scrollToPage(win, offset)
      const image = await win.webContents.capturePage(undefined, { stayHidden: true })
      if (image.isEmpty()) throw new Error('无法捕获导出页面')
      pages.push(capturePNG(image, dimensions.width, height))
    }
    return pages
  } finally {
    if (!win.isDestroyed()) {
      win.webContents.endFrameSubscription()
      win.destroy()
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
