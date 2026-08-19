import { BrowserWindow, NativeImage } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PNG } from 'pngjs'

export type ImageExportPreset = 'desktop' | 'mobile'

export interface ImageExportSnapshot {
  html: string
  styles: string
  bodyClass: string
  background: string
}

const PRESETS: Record<ImageExportPreset, { width: number; padding: number }> = {
  desktop: { width: 1200, padding: 64 },
  mobile: { width: 414, padding: 28 },
}

function exportHTML(snapshot: ImageExportSnapshot, preset: ImageExportPreset): string {
  const { width, padding } = PRESETS[preset]
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: file:; style-src 'unsafe-inline'; img-src 'self' data: blob: https: http: file:; font-src 'self' data:">
  <style>${snapshot.styles}
    html, body { width: ${width}px !important; min-width: ${width}px !important; height: fit-content !important; min-height: 0 !important; overflow: hidden !important; background: ${snapshot.background} !important; }
    body { margin: 0 !important; }
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
    return {
      width: editor?.scrollWidth ?? document.documentElement.scrollWidth,
      height: editor?.scrollHeight ?? document.documentElement.scrollHeight,
    }
  })()`)
}

function nativeImageToPNG(image: NativeImage): PNG {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const png = new PNG({ width, height })
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    png.data[offset] = bitmap[offset + 2]
    png.data[offset + 1] = bitmap[offset + 1]
    png.data[offset + 2] = bitmap[offset]
    png.data[offset + 3] = bitmap[offset + 3]
  }
  return png
}

function cropTile(tile: PNG, cssWidth: number, cssHeight: number): PNG {
  const targetHeight = Math.min(tile.height, Math.max(1, Math.round(cssHeight * tile.width / cssWidth)))
  if (tile.height === targetHeight) return tile
  const cropped = new PNG({ width: tile.width, height: targetHeight })
  PNG.bitblt(tile, cropped, 0, 0, tile.width, targetHeight, 0, 0)
  return cropped
}

export async function renderDocumentPNG(snapshot: ImageExportSnapshot, preset: ImageExportPreset): Promise<Buffer> {
  const { width } = PRESETS[preset]
  const tileHeight = 1600
  const win = new BrowserWindow({
    show: false,
    width,
    height: tileHeight,
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
    const tiles: PNG[] = []
    for (let offset = 0; offset < dimensions.height; offset += tileHeight) {
      const height = Math.min(tileHeight, dimensions.height - offset)
      const image = await win.webContents.capturePage({ x: 0, y: offset, width: dimensions.width, height }, { stayHidden: true })
      tiles.push(cropTile(nativeImageToPNG(image), dimensions.width, height))
    }

    const output = new PNG({ width: tiles[0]?.width ?? dimensions.width, height: tiles.reduce((sum, tile) => sum + tile.height, 0) })
    let top = 0
    for (const tile of tiles) {
      PNG.bitblt(tile, output, 0, 0, tile.width, tile.height, 0, top)
      top += tile.height
    }
    return PNG.sync.write(output)
  } finally {
    if (!win.isDestroyed()) {
      win.webContents.endFrameSubscription()
      win.destroy()
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
