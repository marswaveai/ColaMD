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

  // Persist theme choice
  localStorage.setItem('colamd-theme', name)

  // Tell the main process so the theme menu can show the selected state
  window.electronAPI?.reportTheme?.(name)
}

export function loadSavedTheme(): string {
  const saved = localStorage.getItem('colamd-theme')
  if (!saved) return 'elegant'
  // Custom themes are stored as "custom:<file>.css"; keeping the name lets
  // freshly opened windows reload their CSS instead of falling back (issue #57)
  if (themes[saved] || saved.startsWith('custom:')) return saved
  return 'elegant'
}
