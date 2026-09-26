const themes: Record<string, string> = {
  light: 'theme-light',
  dark: 'theme-dark',
  elegant: 'theme-elegant',
  sepia: 'theme-sepia',
  notion: 'theme-notion',
  bear: 'theme-bear',
  writer: 'theme-writer',
  'solarized-dark': 'theme-solarized-dark',
  nord: 'theme-nord',
  gruvbox: 'theme-gruvbox',
  dracula: 'theme-dracula',
  midnight: 'theme-midnight'
}

let customStyleEl: HTMLStyleElement | null = null

export function applyTheme(name: string, customCSS?: string): void {
  const body = document.body

  // Remove all theme classes
  Object.values(themes).forEach(cls => body.classList.remove(cls))
  body.classList.remove('theme-custom')

  // Remove custom theme style
  if (customStyleEl) {
    customStyleEl.remove()
    customStyleEl = null
  }

  if (customCSS || name.startsWith('custom:')) {
    if (customCSS) {
      customStyleEl = document.createElement('style')
      customStyleEl.textContent = customCSS
      document.head.appendChild(customStyleEl)
    }
    body.classList.add('theme-custom')
  } else if (themes[name]) {
    body.classList.add(themes[name])
  }

  applyCodePalette()

  // Persist theme choice
  localStorage.setItem('colamd-theme', name)

  // Tell the main process so the theme menu can show the selected state
  window.electronAPI?.reportTheme?.(name)

  // …and hand it the resolved shell colours. Windows paints the window controls
  // inside our own row (titleBarOverlay), and that overlay has to be told a real
  // colour: the chrome surface and the row icons' grey, read off the live computed
  // style so a custom theme works the same as a built-in one.
  const bar = document.getElementById('titlebar')
  if (bar) {
    const surface = getComputedStyle(bar).backgroundColor
    // The OS draws its three glyphs, and they have to sit at the same weight as
    // our four: the platform wants one SOLID colour, while the row's icons are a
    // translucent mix over the chrome, so composite it the way the browser would
    // before handing it over.
    //
    // Both values go over as plain #rrggbb, because the platform parses no CSS
    // Color 4: Chromium hands us `color(srgb 0.1 0.1 0.1)`, Windows rejected the
    // whole overlay call, and the buttons kept the colours from window creation on
    // every theme — including a light strip on a black row (real Windows test,
    // 2026-09-15). Painting each colour onto a canvas and reading the pixel back
    // gives the platform the one string it understands.
    const iconEl = document.getElementById('file-toggle-btn') ?? document.body
    const icon = getComputedStyle(iconEl).color
    const surfaceHex = painted(surface, '#ffffff')
    window.electronAPI?.reportTitlebarColors?.({ background: surfaceHex, symbol: painted(icon, surfaceHex) })
  }
}

// Resolve a colour to #rrggbb, as painted over an opaque one: a translucent value
// is composited exactly the way the browser would, and any CSS colour syntax the
// canvas understands (the platform understands fewer) comes back as hex.
function painted(color: string, background: string): string {
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return color
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${hex(r)}${hex(g)}${hex(b)}`
  } catch {
    // An unparseable colour keeps the caller's value rather than turning the
    // window controls invisible.
    return color
  }
}

/**
 * 代码块里的语法着色用哪一套配色。
 *
 * 判据是**代码块底色的明暗**，不是主题的明暗：elegant 和 bear 是浅色主题却配深色
 * 代码块，跟着主题走会得到浅底浅字。这跟 Mermaid 图挑配色是同一条规则
 * （见 editor/mermaid-bridge.ts），所以两处看起来才是一致的。
 *
 * 只在 body 上换一个类，颜色本身留在 base.css 里：颜色属于主题，判断属于这里。
 */
function applyCodePalette(): void {
  const bg = getComputedStyle(document.body).getPropertyValue('--code-block-bg').trim()
  document.body.classList.toggle('code-palette-light', !isDarkSurface(bg))
}

/** 底色算亮还是暗（sRGB 亮度）。认不出来时按深色算：内置主题里深色代码块是多数。 */
function isDarkSurface(color: string): boolean {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  let channels: number[] | null = null
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1]
    channels = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
  } else {
    const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
    if (rgb) channels = [rgb[1], rgb[2], rgb[3]].map(Number)
  }
  if (!channels) return true
  const [r, g, b] = channels
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

export function loadSavedTheme(): string {
  const saved = localStorage.getItem('colamd-theme')
  if (!saved) return 'elegant'
  // Custom themes are stored as "custom:<file>.css". Preserve the name so a
  // newly opened window can reload its stylesheet instead of falling back.
  if (themes[saved] || saved.startsWith('custom:')) return saved
  return 'elegant'
}
