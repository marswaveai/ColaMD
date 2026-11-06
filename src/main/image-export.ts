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

// The reading width is the document's layout width; the height is what one
// numbered page holds when a document is too tall to be a single image.
const PRESETS: Record<ImageExportPreset, { width: number; height: number; padding: number }> = {
  desktop: { width: 1200, height: 800, padding: 64 },
  mobile: { width: 414, height: 896, padding: 28 },
}

// A captured surface can be at most 16384 **device** pixels on a side. Measured
// on macOS: asking for 16384 comes back with an image, asking for 16800 comes
// back empty. A document taller than that continues as numbered reading pages
// (the behaviour before 2.5.0) instead of failing, so every document still
// exports.
const MAX_CAPTURE_EDGE_PX = 16384

/** 导出窗口的设备像素比。判据要用它换算，见 captureWholeDocument。 */
async function devicePixelRatio(win: BrowserWindow): Promise<number> {
  try {
    const value = await win.webContents.executeJavaScript('window.devicePixelRatio')
    return typeof value === 'number' && value > 0 ? value : 1
  } catch {
    return 1
  }
}

// Every wait below used to be able to wait forever: a capture that never comes
// back leaves the user with no window, no file and no message, which is exactly
// what #88 reported on Windows. Each wait has a deadline, so the worst case is a
// visible error instead of silence.
const LAYOUT_TIMEOUT_MS = 15000
const CAPTURE_TIMEOUT_MS = 20000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 没有返回`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
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
    #editor .cm-content { width: auto !important; max-width: none !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; }
  </style>
</head>
<body class="${snapshot.bodyClass}"><div id="editor"><div class="cm-content">${snapshot.html}</div></div></body>
</html>`
}

interface PageDimensions {
  width: number
  height: number
  contentBottom: number
}

// Measure without waiting for anything, for the case where the polite version
// below runs out of time.
async function measureLayout(win: BrowserWindow): Promise<PageDimensions> {
  return win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById('editor')
    const content = editor?.querySelector('.cm-content')
    const editorBounds = editor?.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    const editorStyle = editor ? getComputedStyle(editor) : null
    const paddingBottom = editorStyle ? Number.parseFloat(editorStyle.paddingBottom) || 0 : 0
    const height = contentBounds && editorBounds
      ? contentBounds.bottom - editorBounds.top + paddingBottom
      : editor?.scrollHeight ?? document.documentElement.scrollHeight
    return {
      width: Math.ceil(editorBounds?.width ?? document.documentElement.scrollWidth),
      height: Math.ceil(height),
      contentBottom: Math.max(0, height - paddingBottom),
    }
  })()`)
}

async function waitForLayout(win: BrowserWindow): Promise<PageDimensions> {
  return win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready
    await Promise.all(Array.from(document.images).map((image) => image.complete ? undefined : new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true })
      image.addEventListener('error', resolve, { once: true })
    })))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const editor = document.getElementById('editor')
    const content = editor?.querySelector('.cm-content')
    const editorBounds = editor?.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    const editorStyle = editor ? getComputedStyle(editor) : null
    const paddingBottom = editorStyle ? Number.parseFloat(editorStyle.paddingBottom) || 0 : 0
    const height = contentBounds && editorBounds
      ? contentBounds.bottom - editorBounds.top + paddingBottom
      : editor?.scrollHeight ?? document.documentElement.scrollHeight
    return {
      width: Math.ceil(editorBounds?.width ?? document.documentElement.scrollWidth),
      height: Math.ceil(height),
      contentBottom: Math.max(0, height - paddingBottom),
    }
  })()`)
}

// The window is the camera: give it the height the export needs and let it paint
// before the picture is taken. Resizing re-renders, so the frame has to land
// before anything is captured.
async function resizeAndSettle(win: BrowserWindow, width: number, height: number): Promise<void> {
  win.setContentSize(width, height)
  await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

// One continuous image for the whole document. Because the window itself is made
// as tall as the document, a plain capture covers everything: no debugger
// protocol to lose its target (#121), no scrolling and no stitching (stitching a
// long document is where that pull request lost whole lines).
async function captureWholeDocument(
  win: BrowserWindow,
  dimensions: PageDimensions,
  viewportHeight: number,
  dpr: number
): Promise<Buffer | null> {
  // 判据必须换算成**设备像素**：同一个 CSS 高度在 2 倍屏上要的是两倍的表面。
  // 这里原本拿 CSS 像素直接比 16384，等于在 2 倍屏上允许到 32768——超过真实上限的
  // 文档会先报 UnknownVizError、再退回编号页，白等两次超时，而它本来就该直接走编号页。
  if (dimensions.height * dpr > MAX_CAPTURE_EDGE_PX || dimensions.width * dpr > MAX_CAPTURE_EDGE_PX) return null
  try {
    await resizeAndSettle(win, dimensions.width, dimensions.height)
    const image = await withTimeout(
      win.webContents.capturePage({ x: 0, y: 0, width: dimensions.width, height: dimensions.height }),
      CAPTURE_TIMEOUT_MS,
      'capturePage'
    )
    const size = image.getSize()
    await resizeAndSettle(win, dimensions.width, viewportHeight)
    if (size.width <= 0 || size.height <= 0
      || size.width < Math.ceil(dimensions.width * dpr) - 1
      || size.height < Math.ceil(dimensions.height * dpr) - 1) return null
    return image.toPNG()
  } catch (error) {
    // A document the surface refuses to paint is still exportable as pages, so
    // this is a reason to split, not a reason to give up.
    console.error('Falling back to reading pages', error)
    await resizeAndSettle(win, dimensions.width, viewportHeight)
    return null
  }
}

// A reading page's worth of a document that is too tall to be one image. The
// content is translated, not scrolled: scrollTop clamps at the end of the
// document, and that mismatch is what shifted slices and lost content before.
async function captureReadingPage(
  win: BrowserWindow,
  dimensions: PageDimensions,
  offset: number,
  height: number,
  dpr: number
): Promise<Buffer> {
  await resizeAndSettle(win, dimensions.width, height)
  await win.webContents.executeJavaScript(`(() => {
    document.body.style.transform = 'translateY(${-offset}px)'
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const image = await withTimeout(
    win.webContents.capturePage({ x: 0, y: 0, width: dimensions.width, height }),
    CAPTURE_TIMEOUT_MS,
    'capturePage'
  )
  const size = image.getSize()
  const expectedWidth = Math.ceil(dimensions.width * dpr)
  const expectedHeight = Math.ceil(height * dpr)
  // capturePage 的 NativeImage 尺寸是设备像素，必须先将 CSS 尺寸乘 DPR。
  // DPR 来自浮点数，与 Chromium 的缩放取整最多容许 1 设备像素差；整图同理。
  // 只查尺寸，不逐页读像素，也不把空图或明显截短的页写成成功。
  if (size.width <= 0 || size.height <= 0 || size.width < expectedWidth - 1 || size.height < expectedHeight - 1) {
    throw new Error(`分页截图尺寸不足：${size.width}x${size.height}，需要 ${expectedWidth}x${expectedHeight} 设备像素`)
  }
  return image.toPNG()
}

// One image per document when it fits, otherwise one per reading page. The
// caller writes one file for one image, and numbered files for several.
export async function renderDocumentImages(
  snapshot: ImageExportSnapshot,
  preset: ImageExportPreset
): Promise<Buffer[]> {
  const { width, height: pageHeight } = PRESETS[preset]
  const win = new BrowserWindow({
    show: false,
    width,
    height: pageHeight,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window still has to produce frames, otherwise every capture
      // waits for a picture that is never painted. (Electron paints initially
      // hidden windows by default; throttling is what switches that off.)
      backgroundThrottling: false,
    },
  })

  let tempDir: string | undefined
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'colamd-image-export-'))
    const exportPath = join(tempDir, 'document.html')
    await writeFile(exportPath, exportHTML(snapshot, preset), 'utf8')
    await win.loadFile(exportPath)
    win.webContents.beginFrameSubscription(() => {})
    const dimensions = await withTimeout(waitForLayout(win), LAYOUT_TIMEOUT_MS, 'waitForLayout')
      .catch((error) => {
        console.error('Layout never settled, measuring as-is', error)
        return measureLayout(win)
      })

    const dpr = await devicePixelRatio(win)
    const single = await captureWholeDocument(win, dimensions, pageHeight, dpr)
    if (single) return [single]

    const pages: Buffer[] = []
    // 自定义主题可以用更高优先级覆盖预设 padding，正文终点必须来自实测布局。
    // 不对正文边界取整，避免不足 1 CSS px 的内容被丢弃；真实底部留白仍留在末页里。
    for (let offset = 0; offset < dimensions.contentBottom; offset += pageHeight) {
      const height = Math.min(pageHeight, dimensions.height - offset)
      pages.push(await captureReadingPage(win, dimensions, offset, height, dpr))
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
