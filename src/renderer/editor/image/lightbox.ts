// Fullscreen image viewer (lightbox): wheel zoom around the cursor, drag to
// pan, arrow keys walk through every image in the document, Esc/背景点击关闭.

interface LightboxItem {
  src: string
  alt: string
}

const MIN_SCALE = 0.15
const MAX_SCALE = 12

let overlay: HTMLDivElement | null = null
let img: HTMLImageElement | null = null
let captionEl: HTMLDivElement | null = null
let counterEl: HTMLSpanElement | null = null
let zoomLabel: HTMLButtonElement | null = null
let items: LightboxItem[] = []
let index = 0
let scale = 1
let fitScale = 1
let translateX = 0
let translateY = 0
let panning = false
let panStartX = 0
let panStartY = 0
let panBaseX = 0
let panBaseY = 0

function applyTransform(): void {
  if (!img) return
  img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`
  if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`
}

function computeFitScale(): number {
  if (!img || !img.naturalWidth) return 1
  const pad = 64
  const availW = window.innerWidth - pad
  const availH = window.innerHeight - pad
  const scaleW = availW / img.naturalWidth
  const scaleH = availH / img.naturalHeight
  return Math.min(1, scaleW, scaleH)
}

function resetView(keepZoom = false): void {
  fitScale = computeFitScale()
  if (!keepZoom) {
    scale = fitScale
    translateX = 0
    translateY = 0
  }
  applyTransform()
}

function showIndex(nextIndex: number): void {
  if (!img || items.length === 0) return
  index = (nextIndex + items.length) % items.length
  const item = items[index]
  scale = 1
  translateX = 0
  translateY = 0
  img.classList.remove('ready')
  img.src = item.src
  if (captionEl) captionEl.textContent = item.alt ?? ''
  if (counterEl) counterEl.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : ''
  // Fit once the natural size is known; large images animate in without
  // jumping because the transform resets before paint.
  const fit = (): void => {
    img?.removeEventListener('load', fit)
    resetView()
    img?.classList.add('ready')
  }
  img.addEventListener('load', fit)
  if (img.complete && img.naturalWidth) fit()
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  if (!overlay) return
  const rect = overlay.getBoundingClientRect()
  const cursorX = clientX - rect.left - rect.width / 2
  const cursorY = clientY - rect.top - rect.height / 2
  const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
  const ratio = nextScale / scale
  // Keep the point under the cursor stationary while zooming.
  translateX = cursorX - (cursorX - translateX) * ratio
  translateY = cursorY - (cursorY - translateY) * ratio
  scale = nextScale
  applyTransform()
}

function zoomStep(factor: number): void {
  if (!overlay) return
  const rect = overlay.getBoundingClientRect()
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
}

function collectDocumentImages(): LightboxItem[] {
  const found: LightboxItem[] = []
  const seen = new Set<string>()
  document.querySelectorAll<HTMLImageElement>('#editor .ProseMirror img').forEach((element) => {
    const src = element.currentSrc || element.src
    if (!src || seen.has(src)) return
    seen.add(src)
    found.push({ src, alt: element.alt || '' })
  })
  return found
}

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay

  overlay = document.createElement('div')
  overlay.id = 'cmd-lightbox'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', '图片预览')
  // Programmatically focusable so the first Esc/cursor key lands here even
  // before any click.
  overlay.tabIndex = -1

  img = document.createElement('img')
  img.alt = ''
  img.draggable = false
  overlay.appendChild(img)

  const bar = document.createElement('div')
  bar.className = 'cmd-lightbox-bar'

  counterEl = document.createElement('span')
  counterEl.className = 'cmd-lightbox-counter'
  bar.appendChild(counterEl)

  captionEl = document.createElement('div')
  captionEl.className = 'cmd-lightbox-caption'
  bar.appendChild(captionEl)

  const controls = document.createElement('div')
  controls.className = 'cmd-lightbox-controls'

  const makeButton = (label: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.title = title
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onClick(event)
    })
    return button
  }

  zoomLabel = makeButton('100%', '缩放比例，点击恢复 100%', () => setScale(1))
  controls.append(
    makeButton('−', '缩小', () => zoomStep(1 / 1.25)),
    zoomLabel,
    makeButton('+', '放大', () => zoomStep(1.25)),
    makeButton('适应', '适应窗口', () => resetView()),
    makeButton('1:1', '原始尺寸', () => setScale(1)),
  )
  bar.appendChild(controls)
  overlay.appendChild(bar)

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'cmd-lightbox-close'
  closeBtn.textContent = '✕'
  closeBtn.title = '关闭 (Esc)'
  closeBtn.setAttribute('aria-label', '关闭预览')
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    closeLightbox()
  })
  overlay.appendChild(closeBtn)

  overlay.addEventListener('wheel', (event) => {
    event.preventDefault()
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12)
  }, { passive: false })

  overlay.addEventListener('mousedown', (event) => {
    if ((event.target as HTMLElement).closest('button')) return
    panning = true
    panStartX = event.clientX
    panStartY = event.clientY
    panBaseX = translateX
    panBaseY = translateY
    overlay?.classList.add('panning')
  })
  window.addEventListener('mousemove', (event) => {
    if (!panning) return
    translateX = panBaseX + (event.clientX - panStartX)
    translateY = panBaseY + (event.clientY - panStartY)
    applyTransform()
  })
  window.addEventListener('mouseup', () => {
    if (!panning) return
    panning = false
    overlay?.classList.remove('panning')
  })

  overlay.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('button')) return
    // Double-click toggles between 1:1 pixels and fit-to-window, the two
    // states people actually want when inspecting a screenshot.
    if (Math.abs(scale - 1) < 0.02) {
      resetView()
    } else {
      setScale(1)
    }
  })

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeLightbox()
  })

  // Document-level keys: focus can sit on a control button or the backdrop,
  // and the viewer must respond regardless of where focus landed.
  document.addEventListener('keydown', (event) => {
    if (!overlay?.classList.contains('open')) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeLightbox()
    } else if (event.key === 'ArrowLeft' && items.length > 1) {
      event.preventDefault()
      showIndex(index - 1)
    } else if (event.key === 'ArrowRight' && items.length > 1) {
      event.preventDefault()
      showIndex(index + 1)
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomStep(1.25)
    } else if (event.key === '-') {
      event.preventDefault()
      zoomStep(1 / 1.25)
    } else if (event.key === '0') {
      event.preventDefault()
      resetView()
    }
  })

  document.body.appendChild(overlay)
  return overlay
}

function setScale(next: number): void {
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  applyTransform()
}

export function openLightbox(src: string, alt = ''): void {
  const element = ensureOverlay()
  items = collectDocumentImages()
  const startIndex = Math.max(0, items.findIndex((item) => item.src === src))
  element.classList.add('open')
  showIndex(startIndex >= 0 ? startIndex : 0)
  if (items.length === 0) {
    items = [{ src, alt }]
    showIndex(0)
  }
  element.focus()
}

export function closeLightbox(): void {
  overlay?.classList.remove('open')
  if (img) img.src = ''
}

export function isLightboxOpen(): boolean {
  return !!overlay?.classList.contains('open')
}
