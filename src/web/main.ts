// The web playground entry: the same editor core and the same theme CSS as the
// desktop app, with the desktop chrome left out. Nothing here reaches for
// Electron: the editor core only calls it in four optional, guarded places.
//
// Two ways in:
//   /try/          the standalone page
//   /try/?embed=1  a small block for the homepage, with a full screen button.
//                  The homepage owns the frame around it, so this page asks the
//                  parent over postMessage when to grow and when to come back.
//
// Scope is deliberate (MVP): typing, the 12 themes, and one sample document.
// Tabs, the file list, search, export, diagrams and formulas stay in the app.

import { createEditor, setMarkdown } from '../renderer/editor/editor'
import { applyTheme } from '../renderer/themes/theme-manager'
import { SAMPLES } from './sample'
import '../renderer/themes/base.css'
import '../renderer/themes/premium.css'
import './web.css'

type Lang = 'zh' | 'en'

const EMBED = new URLSearchParams(location.search).has('embed')

// The web page uses the same thin scrollbars the desktop app uses off macOS:
// the system overlay ones look heavy inside a window.
document.body.classList.add('web-playground')

// id, 中文名, English name. Same twelve themes as the desktop app.
const THEMES: Array<[string, string, string]> = [
  ['light', '浅色', 'Light'],
  ['elegant', '雅致', 'Elegant'],
  ['notion', '简白', 'Notion'],
  ['writer', '作家', 'Writer'],
  ['bear', '熊红', 'Bear'],
  ['sepia', '羊皮纸', 'Sepia'],
  ['dark', '深色', 'Dark'],
  ['midnight', '午夜', 'Midnight'],
  ['solarized-dark', '夜航', 'Solarized Dark'],
  ['nord', '极地', 'Nord'],
  ['gruvbox', '暖木', 'Gruvbox'],
  ['dracula', '德古拉', 'Dracula']
]

const COPY = {
  zh: {
    docTitle: 'ColaMD 主题体验',
    subtitle: '主题体验',
    hint: '这是真的编辑器，直接改这里的字试试。',
    maximize: '全屏',
    restore: '退出全屏',
    note: '这是网页预览：写的字不会保存，也不会联网。真正的 ColaMD 把文件放在你自己的电脑上。',
    cta: '下载桌面版',
    toggle: 'EN'
  },
  en: {
    docTitle: 'ColaMD themes in the browser',
    subtitle: 'themes, in the browser',
    hint: 'This is the real editor. Type in it.',
    maximize: 'Full screen',
    restore: 'Exit full screen',
    note: 'This is a web preview: nothing is saved and nothing leaves the page. The real ColaMD keeps your files on your own computer.',
    cta: 'Download for desktop',
    toggle: '中文'
  }
} as const

const THEME_KEY = 'colamd-try-theme'
const LANG_KEY = 'colamd-try-lang'

// Message types. The child asks, the parent decides; the parent then tells the
// child what happened, so both sides can never end up disagreeing.
const ASK_FULLSCREEN = 'colamd-try:ask-fullscreen'
const SET_FULLSCREEN = 'colamd-try:set-fullscreen'
const SET_LANG = 'colamd-try:set-lang'

function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY)
  if (saved === 'zh' || saved === 'en') return saved
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function initialTheme(): string {
  const saved = localStorage.getItem(THEME_KEY)
  return THEMES.some(([id]) => id === saved) ? (saved as string) : 'elegant'
}

function renderThemeSwitch(lang: Lang, active: string, onPick: (id: string) => void): void {
  const host = document.getElementById('theme-switch') as HTMLElement
  host.textContent = ''
  for (const [id, zh, en] of THEMES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.theme = id
    button.textContent = lang === 'zh' ? zh : en
    button.setAttribute('aria-pressed', String(id === active))
    button.addEventListener('click', () => onPick(id))
    host.append(button)
  }
}

let lang: Lang = initialLang()
let theme = initialTheme()
// Standalone /try/ is already wide open; the embedded block starts small.
let full = !EMBED

function syncMaxButton(): void {
  const button = document.getElementById('try-max')
  if (!button) return
  const label = full ? COPY[lang].restore : COPY[lang].maximize
  button.setAttribute('aria-label', label)
  button.setAttribute('title', label)
  const span = button.querySelector('span')
  if (span) span.textContent = label
}

function applyCopy(next: Lang): void {
  const copy = COPY[next]
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  document.title = copy.docTitle
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = el.dataset.i18n as keyof typeof copy
    if (key in copy && key !== 'maximize') el.textContent = copy[key]
  }
  const toggle = document.getElementById('lang-toggle') as HTMLElement
  toggle.textContent = copy.toggle
  syncMaxButton()
}

function setTheme(id: string): void {
  theme = id
  applyTheme(id)
  localStorage.setItem(THEME_KEY, id)
  renderThemeSwitch(lang, theme, setTheme)
}

function setLang(next: Lang): void {
  lang = next
  localStorage.setItem(LANG_KEY, next)
  applyCopy(next)
  renderThemeSwitch(next, theme, setTheme)
  setMarkdown(SAMPLES[next], true)
}

function setFull(next: boolean): void {
  full = next
  const root = document.documentElement
  root.classList.toggle('try-full', full)
  // Standalone and full screen both put the whole thing in a centred window.
  // The homepage block does not: the site's own window is the frame there.
  root.classList.toggle('try-window', !EMBED || full)
  syncMaxButton()
}

function askFullscreen(next: boolean): void {
  setFull(next)
  if (EMBED) window.parent.postMessage({ type: ASK_FULLSCREEN, full: next }, location.origin)
}

document.getElementById('lang-toggle')?.addEventListener('click', () => {
  setLang(lang === 'zh' ? 'en' : 'zh')
})

document.getElementById('try-max')?.addEventListener('click', () => askFullscreen(!full))

document.addEventListener('keydown', (event) => {
  if (EMBED && full && event.key === 'Escape') askFullscreen(false)
})

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return
  const data = event.data as { type?: string; full?: boolean; lang?: Lang } | null
  if (!data || typeof data.type !== 'string') return
  if (data.type === SET_FULLSCREEN) setFull(Boolean(data.full))
  if (data.type === SET_LANG && (data.lang === 'zh' || data.lang === 'en')) setLang(data.lang)
})

applyTheme(theme)
applyCopy(lang)
renderThemeSwitch(lang, theme, setTheme)
setFull(full)

async function boot(): Promise<void> {
  await createEditor('editor')
  setMarkdown(SAMPLES[lang], true)
  if (EMBED) {
    // Tell the homepage we are here and ready for language updates.
    window.parent.postMessage({ type: 'colamd-try:ready' }, location.origin)
  } else {
    document.querySelector<HTMLElement>('#editor .cm-content')?.focus()
  }
}

void boot()
