export type PageLayoutMode = 'continuous' | 'two' | 'three'

const STORAGE_KEY = 'colamd-page-layout'
const PAGE_GAP = 40
const PAGE_MAX_WIDTH = 780
const PAGE_MIN_WIDTH = 320
const WHEEL_THRESHOLD = 42
const WHEEL_GESTURE_END_MS = 180
const SCROLL_SNAP_IDLE_MS = 180
const SCROLL_SNAP_EPSILON = 1

const pageCounts: Record<PageLayoutMode, number> = {
  continuous: 1,
  two: 2,
  three: 3,
}

let activeController: PageLayoutController | null = null

export function isPageLayoutMode(value: unknown): value is PageLayoutMode {
  return value === 'continuous' || value === 'two' || value === 'three'
}

export function loadSavedPageLayout(): PageLayoutMode {
  const saved = localStorage.getItem(STORAGE_KEY)
  return isPageLayoutMode(saved) ? saved : 'continuous'
}

/**
 * Reveal a viewport rect inside the active paged editor. Search uses this
 * without depending on the controller instance owned by main.ts.
 */
export function revealInPagedLayout(rect: Pick<DOMRect, 'left' | 'right' | 'width'>): boolean {
  if (!activeController?.isPaged()) return false
  activeController.revealRect(rect)
  return true
}

export function revealElementInPagedLayout(element: HTMLElement): boolean {
  if (!activeController?.isPaged()) return false
  activeController.revealElement(element)
  return true
}

export function isPagedLayoutActive(): boolean {
  return activeController?.isPaged() ?? false
}

export class PageLayoutController {
  private readonly pagedScroller: HTMLElement
  private mode: PageLayoutMode = 'continuous'
  private pageWidth = 0
  private pagePitch = 0
  private spreadStep = 0
  private wheelDelta = 0
  private wheelDirection = 0
  private wheelCommitted = false
  private wheelEndTimer: ReturnType<typeof setTimeout> | null = null
  private scrollSnapTimer: ReturnType<typeof setTimeout> | null = null
  private resizeFrame = 0
  private resizeObserver: ResizeObserver

  constructor(
    private readonly editor: HTMLElement,
    initialMode: PageLayoutMode,
    private readonly onModeChanged?: (mode: PageLayoutMode) => void,
  ) {
    activeController = this
    this.pagedScroller = editor.querySelector<HTMLElement>(':scope > .milkdown') ?? editor
    this.resizeObserver = new ResizeObserver(() => this.queueResize())
    this.resizeObserver.observe(editor)
    editor.addEventListener('wheel', this.onWheel, { passive: false })
    editor.addEventListener('keydown', this.onKeyDown, true)
    this.pagedScroller.addEventListener('scroll', this.onScrollerScroll, { passive: true })
    this.applyMode(initialMode, false)
    this.publishMode()
  }

  isPaged(): boolean {
    return this.mode !== 'continuous'
  }

  getMode(): PageLayoutMode {
    return this.mode
  }

  getProgress(): number {
    const range = this.isPaged()
      ? this.pagedScroller.scrollWidth - this.pagedScroller.clientWidth
      : this.editor.scrollHeight - this.editor.clientHeight
    const position = this.isPaged() ? this.pagedScroller.scrollLeft : this.editor.scrollTop
    return range > 0 ? Math.max(0, Math.min(1, position / range)) : 0
  }

  restoreProgress(progress: number): void {
    const ratio = Math.max(0, Math.min(1, progress))
    requestAnimationFrame(() => {
      if (this.isPaged()) {
        const range = Math.max(0, this.pagedScroller.scrollWidth - this.pagedScroller.clientWidth)
        const target = this.snapTarget(range * ratio)
        this.pagedScroller.scrollTo({ left: target, top: 0 })
      } else {
        const range = Math.max(0, this.editor.scrollHeight - this.editor.clientHeight)
        this.editor.scrollTo({ left: 0, top: range * ratio })
      }
    })
  }

  setMode(next: PageLayoutMode): void {
    localStorage.setItem(STORAGE_KEY, next)
    this.applyMode(next, true)
    this.publishMode()
  }

  revealElement(element: HTMLElement): void {
    this.revealRect(element.getBoundingClientRect())
  }

  revealRect(rect: Pick<DOMRect, 'left' | 'right' | 'width'>): void {
    if (!this.isPaged() || this.spreadStep <= 0) return
    const viewport = this.pagedScroller.getBoundingClientRect()
    const inset = 24
    if (rect.left >= viewport.left + inset && rect.right <= viewport.right - inset) return

    const absoluteCenter = this.pagedScroller.scrollLeft + rect.left - viewport.left + rect.width / 2
    const desired = absoluteCenter - this.pagedScroller.clientWidth / 2
    const target = this.snapTarget(desired)
    this.pagedScroller.scrollTo({ left: target, behavior: this.scrollBehavior() })
  }

  private applyMode(next: PageLayoutMode, preservePosition: boolean): void {
    if (next === this.mode) {
      if (this.isPaged()) this.updateDimensions()
      else this.clearDimensions()
      this.syncBodyState()
      return
    }
    const previousProgress = this.getProgress()
    const previousPage = this.isPaged() && this.spreadStep > 0
      ? Math.round(this.pagedScroller.scrollLeft / this.spreadStep) * pageCounts[this.mode]
      : null

    this.mode = next
    document.body.classList.toggle('page-layout-paged', this.isPaged())
    document.body.classList.toggle('page-layout-two', next === 'two')
    document.body.classList.toggle('page-layout-three', next === 'three')
    this.syncBodyState()

    if (this.isPaged()) {
      this.updateDimensions()
    } else {
      this.cancelPendingSnap()
      this.clearDimensions()
    }

    requestAnimationFrame(() => {
      if (!preservePosition) {
        this.editor.scrollTo({ left: 0, top: 0 })
        this.pagedScroller.scrollTo({ left: 0, top: 0 })
        return
      }

      if (this.isPaged()) {
        const target = previousPage === null
          ? this.snapTarget(previousProgress * Math.max(0, this.pagedScroller.scrollWidth - this.pagedScroller.clientWidth))
          : this.snapTarget(Math.floor(previousPage / pageCounts[next]) * this.spreadStep)
        this.editor.scrollTo({ left: 0, top: 0 })
        this.pagedScroller.scrollTo({ left: target, top: 0 })
      } else {
        const range = Math.max(0, this.editor.scrollHeight - this.editor.clientHeight)
        this.editor.scrollTo({ left: 0, top: range * previousProgress })
      }
    })
  }

  private publishMode(): void {
    this.onModeChanged?.(this.mode)
  }

  private syncBodyState(): void {
    document.body.dataset.pageLayout = this.mode
    document.body.dataset.pageLayoutPreference = this.mode
    delete document.body.dataset.pageLayoutFallback
  }

  private updateDimensions(): void {
    if (!this.isPaged()) return
    const count = pageCounts[this.mode]
    const styles = getComputedStyle(this.editor)
    const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
    const available = Math.max(0, this.editor.clientWidth - horizontalPadding)
    const fitWidth = (available - PAGE_GAP * (count - 1)) / count
    this.pageWidth = Math.min(PAGE_MAX_WIDTH, Math.max(PAGE_MIN_WIDTH, fitWidth))
    this.pagePitch = this.pageWidth + PAGE_GAP
    this.spreadStep = count * this.pagePitch
    const spreadWidth = count * this.pageWidth + (count - 1) * PAGE_GAP

    this.editor.style.setProperty('--page-layout-count', String(count))
    this.editor.style.setProperty('--page-layout-gap', `${PAGE_GAP}px`)
    this.editor.style.setProperty('--page-layout-page-width', `${this.pageWidth}px`)
    this.editor.style.setProperty('--page-layout-spread-width', `${spreadWidth}px`)
  }

  private clearDimensions(): void {
    this.pageWidth = 0
    this.pagePitch = 0
    this.spreadStep = 0
    this.editor.style.removeProperty('--page-layout-count')
    this.editor.style.removeProperty('--page-layout-gap')
    this.editor.style.removeProperty('--page-layout-page-width')
    this.editor.style.removeProperty('--page-layout-spread-width')
  }

  private queueResize(): void {
    if (!this.isPaged() || this.resizeFrame) return
    const page = this.spreadStep > 0
      ? Math.round(this.pagedScroller.scrollLeft / this.spreadStep) * pageCounts[this.mode]
      : 0
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = 0
      this.updateDimensions()
      requestAnimationFrame(() => {
        const spread = Math.floor(page / pageCounts[this.mode])
        this.pagedScroller.scrollTo({ left: this.snapTarget(spread * this.spreadStep), top: 0 })
      })
    })
  }

  private snapTarget(value: number): number {
    const max = Math.max(0, this.pagedScroller.scrollWidth - this.pagedScroller.clientWidth)
    if (this.spreadStep <= 0) return Math.max(0, Math.min(max, value))
    const clamped = Math.max(0, Math.min(max, value))
    const lower = Math.floor(clamped / this.spreadStep) * this.spreadStep
    const upper = Math.min(max, lower + this.spreadStep)
    return Math.abs(clamped - lower) <= Math.abs(upper - clamped) ? lower : upper
  }

  private cancelPendingSnap(): void {
    if (!this.scrollSnapTimer) return
    clearTimeout(this.scrollSnapTimer)
    this.scrollSnapTimer = null
  }

  private snapAfterScroll(): void {
    this.scrollSnapTimer = null
    if (!this.isPaged() || this.spreadStep <= 0) return
    const target = this.snapTarget(this.pagedScroller.scrollLeft)
    if (Math.abs(target - this.pagedScroller.scrollLeft) <= SCROLL_SNAP_EPSILON) return
    this.pagedScroller.scrollTo({ left: target, top: 0, behavior: this.scrollBehavior() })
  }

  private onScrollerScroll = (): void => {
    if (!this.isPaged()) return
    this.cancelPendingSnap()
    this.scrollSnapTimer = setTimeout(() => this.snapAfterScroll(), SCROLL_SNAP_IDLE_MS)
  }

  private turnSpread(direction: number): void {
    if (!this.isPaged() || !direction || this.spreadStep <= 0) return
    const current = Math.round(this.pagedScroller.scrollLeft / this.spreadStep)
    const target = this.snapTarget((current + Math.sign(direction)) * this.spreadStep)
    this.pagedScroller.scrollTo({ left: target, behavior: this.scrollBehavior() })
  }

  private scrollBehavior(): ScrollBehavior {
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  }

  private resetWheelGesture(): void {
    this.wheelDelta = 0
    this.wheelDirection = 0
    this.wheelCommitted = false
    this.wheelEndTimer = null
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.isPaged() || event.ctrlKey) return

    // Leave horizontal gestures native so wide code, diagrams, and other
    // constrained content can scroll. The scroller-level idle handler snaps
    // any resulting outer scroll back to the nearest complete spread.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return

    const rawDelta = event.deltaY
    if (!rawDelta) return
    event.preventDefault()

    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? this.editor.clientHeight
        : 1
    const delta = rawDelta * scale
    const direction = Math.sign(delta)

    if (this.wheelEndTimer) clearTimeout(this.wheelEndTimer)
    this.wheelEndTimer = setTimeout(() => this.resetWheelGesture(), WHEEL_GESTURE_END_MS)

    if (this.wheelCommitted) return
    if (this.wheelDirection && direction !== this.wheelDirection) this.wheelDelta = 0
    this.wheelDirection = direction
    this.wheelDelta += delta

    if (Math.abs(this.wheelDelta) < WHEEL_THRESHOLD) return
    this.wheelCommitted = true
    this.turnSpread(direction)
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isPaged() || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key !== 'PageDown' && event.key !== 'PageUp') return
    event.preventDefault()
    this.turnSpread(event.key === 'PageDown' ? 1 : -1)
  }
}
