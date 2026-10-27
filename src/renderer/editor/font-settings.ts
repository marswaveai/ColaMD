import { isChinese } from '../ui-language'

// Layering: user preference > theme > built-in defaults. Themes keep their own
// font rules; a body class + CSS variables override only the editor prose and
// the source editor, leaving code blocks and the rest of the UI untouched.

export interface EditorFontPrefs {
  family: string
  size: number
}

const STORE_KEY = 'colamd-editor-font'
const fontListeners = new Set<() => void>()

/** 字体应用完毕后通知布局使用者：只换字体族时编辑器尺寸不变，自己察觉不到字宽变了。 */
export function onEditorFontChange(listener: () => void): void {
  fontListeners.add(listener)
}

function isZh(): boolean {
  return isChinese()
}

export function loadSavedEditorFont(): EditorFontPrefs | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EditorFontPrefs>
    if (typeof parsed.family !== 'string' && typeof parsed.size !== 'number') return null
    return {
      family: typeof parsed.family === 'string' ? parsed.family : '',
      size: typeof parsed.size === 'number' ? parsed.size : 0
    }
  } catch {
    return null
  }
}

function sanitizeFamily(family: string): string {
  return family.replace(/[{};<>@]/g, '').trim()
}

// 字体族和字号各管各的，两个类分开挂。
//
// 2026-10-06 报「主题的字体改丢了」：⌘+ 只该改字号，却也因此挂上了 has-custom-font，
// 而那时 --editor-font 是空的，于是 base.css 里那条 `font-family: var(--editor-font)
// !important` 变成无效声明，把主题自己的字体顶掉了。只调字号就只碰字号。
export function applyEditorFont(prefs: EditorFontPrefs | null): void {
  const body = document.body
  const family = prefs ? sanitizeFamily(prefs.family) : ''
  const size = prefs && prefs.size >= 10 && prefs.size <= 40 ? prefs.size : 0
  body.classList.toggle('has-custom-font', Boolean(family))
  body.classList.toggle('has-custom-font-size', Boolean(size))
  if (family) body.style.setProperty('--editor-font', family)
  else body.style.removeProperty('--editor-font')
  if (size) body.style.setProperty('--editor-font-size', `${size}px`)
  else body.style.removeProperty('--editor-font-size')
  fontListeners.forEach(listener => listener())
}

export function persistEditorFont(prefs: EditorFontPrefs): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(prefs))
  applyEditorFont(prefs)
  // Let other windows pick the change up too (they apply it idempotently).
  window.electronAPI?.setEditorFont?.(prefs)
}

// ⌘+ / ⌘- 调的是**正文字号**，不是整页缩放。
//
// 整页缩放会把顶栏一起放大，而 macOS 的红绿灯是系统按窗口画的、尺寸不跟着变，放大之后
// 就不居中了（2026-10-06 报的）。界面保持原尺寸、只让文档跟着变大变小，也更接近
// 「缩放一篇文章」该有的意思。范围与步进跟字体设置里那个滑块一致。
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 40

function currentEditorFontSize(): number {
  const saved = loadSavedEditorFont()
  if (saved && saved.size >= FONT_SIZE_MIN && saved.size <= FONT_SIZE_MAX) return saved.size
  const probe = document.querySelector('#editor .cm-content')
  const computed = probe ? parseFloat(getComputedStyle(probe).fontSize) : Number.NaN
  return Number.isFinite(computed) ? Math.round(computed) : 16
}

export function stepEditorFontSize(delta: number): void {
  const saved = loadSavedEditorFont() ?? { family: '', size: 0 }
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, currentEditorFontSize() + delta))
  persistEditorFont({ family: saved.family, size: next })
}

export function clearEditorFont(): void {
  localStorage.removeItem(STORE_KEY)
  applyEditorFont(null)
  window.electronAPI?.setEditorFont?.({ family: '', size: 0 })
}

/** ⌘0：只把字号恢复成主题的默认值，用户自己挑过的字体族留着。 */
export function resetEditorFontSize(): void {
  const saved = loadSavedEditorFont()
  if (saved?.family) persistEditorFont({ family: saved.family, size: 0 })
  else clearEditorFont()
}

export function showFontSettingsModal(): void {
  const saved = loadSavedEditorFont()
  const zh = isZh()
  const t = {
    title: zh ? '编辑器字体' : 'Editor Font',
    font: zh ? '字体' : 'Font',
    size: zh ? '字号' : 'Size',
    reset: zh ? '恢复默认' : 'Reset',
    cancel: zh ? '取消' : 'Cancel',
    apply: zh ? '应用' : 'Apply'
  }

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'math-modal font-modal'

  const header = document.createElement('h3')
  header.textContent = t.title

  const row = document.createElement('div')
  row.className = 'font-modal-row'

  const familyCol = document.createElement('div')
  familyCol.className = 'font-modal-col'

  const familyLabel = document.createElement('label')
  familyLabel.className = 'font-modal-label'
  familyLabel.textContent = t.font

  const familyInput = document.createElement('input')
  familyInput.className = 'math-modal-input font-modal-input'
  familyInput.placeholder = 'LXGW WenKai, Songti SC, Menlo…'
  familyInput.value = saved?.family ?? ''
  familyInput.autocomplete = 'off'

  // Scrollable custom font dropdown (datalist is unscrollable and can't be styled)
  const fontList = document.createElement('div')
  fontList.className = 'font-modal-list'
  fontList.style.display = 'none'
  let fontNames: string[] = []
  void window.electronAPI.listSystemFonts?.().then((fonts) => {
    if (!fonts.length) return
    fontNames = fonts
    if (document.activeElement === familyInput) renderFontList(familyInput.value)
  })

  let activeIndex = -1

  function renderFontList(query: string): void {
    const q = query.trim().toLowerCase()
    const items = (q ? fontNames.filter((f) => f.toLowerCase().includes(q)) : fontNames).slice(0, 1000)
    if (!items.length) {
      fontList.style.display = 'none'
      return
    }
    activeIndex = -1
    fontList.replaceChildren(...items.map((name) => {
      const item = document.createElement('div')
      item.className = 'font-modal-list-item'
      item.textContent = name
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        familyInput.value = name
        fontList.style.display = 'none'
        updatePreview()
      })
      return item
    }))
    fontList.style.display = 'block'
  }

  function hideFontList(): void {
    fontList.style.display = 'none'
    activeIndex = -1
  }

  let blurTimer: ReturnType<typeof setTimeout> | null = null
  familyInput.addEventListener('focus', () => {
    if (blurTimer) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
    renderFontList(familyInput.value)
  })
  familyInput.addEventListener('input', () => {
    renderFontList(familyInput.value)
    updatePreview()
  })
  familyInput.addEventListener('blur', () => {
    blurTimer = setTimeout(hideFontList, 150)
  })
  familyInput.addEventListener('keydown', (e) => {
    const items = fontList.querySelectorAll('.font-modal-list-item')
    if (fontList.style.display === 'none' || !items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex = e.key === 'ArrowDown'
        ? Math.min(activeIndex + 1, items.length - 1)
        : Math.max(activeIndex - 1, 0)
      items.forEach((el, i) => el.classList.toggle('active', i === activeIndex))
      items[activeIndex].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      familyInput.value = (items[activeIndex] as HTMLElement).textContent ?? ''
      hideFontList()
      updatePreview()
    } else if (e.key === 'Escape') {
      hideFontList()
    }
  })

  const sizeCol = document.createElement('div')
  sizeCol.className = 'font-modal-col font-modal-col-size'

  const sizeLabel = document.createElement('label')
  sizeLabel.className = 'font-modal-label'
  sizeLabel.textContent = t.size

  const sizeInput = document.createElement('input')
  sizeInput.className = 'math-modal-input font-modal-size'
  sizeInput.type = 'number'
  sizeInput.min = '10'
  sizeInput.max = '40'
  sizeInput.step = '1'
  sizeInput.placeholder = '16'
  sizeInput.value = saved?.size ? String(saved.size) : ''

  const preview = document.createElement('div')
  preview.className = 'font-modal-preview'

  const previewText = document.createElement('span')
  preview.appendChild(previewText)

  const updatePreview = (): void => {
    const family = sanitizeFamily(familyInput.value)
    const size = parseInt(sizeInput.value, 10)
    preview.style.fontFamily = family || 'inherit'
    preview.style.fontSize = size ? `${Math.min(Math.max(size, 10), 40)}px` : '16px'
    previewText.textContent =
      'The quick brown fox jumps over the lazy dog. 中文字体排版预览 0123456789'
  }
  familyInput.addEventListener('input', updatePreview)
  sizeInput.addEventListener('input', updatePreview)
  updatePreview()

  const footer = document.createElement('div')
  footer.className = 'math-modal-footer font-modal-footer'

  const footerLeft = document.createElement('div')
  footerLeft.className = 'font-modal-footer-group'

  const footerRight = document.createElement('div')
  footerRight.className = 'font-modal-footer-group'

  const resetBtn = document.createElement('button')
  resetBtn.textContent = t.reset
  resetBtn.className = 'math-modal-btn cancel'
  resetBtn.addEventListener('click', () => {
    clearEditorFont()
    overlay.remove()
  })

  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = t.cancel
  cancelBtn.className = 'math-modal-btn cancel'
  cancelBtn.addEventListener('click', () => overlay.remove())

  const applyBtn = document.createElement('button')
  applyBtn.textContent = t.apply
  applyBtn.className = 'math-modal-btn save'
  applyBtn.addEventListener('click', () => {
    const family = sanitizeFamily(familyInput.value)
    const size = parseInt(sizeInput.value, 10)
    if (!family && !size) {
      clearEditorFont()
    } else {
      persistEditorFont({ family, size: Number.isFinite(size) ? size : 0 })
    }
    overlay.remove()
  })

  familyCol.append(familyLabel, familyInput, fontList)
  sizeCol.append(sizeLabel, sizeInput)
  row.append(familyCol, sizeCol)
  footerLeft.appendChild(resetBtn)
  footerRight.append(cancelBtn, applyBtn)
  footer.append(footerLeft, footerRight)
  modal.append(header, row, preview, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  familyInput.focus()
}