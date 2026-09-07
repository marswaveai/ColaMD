export type UiLanguage = 'zh' | 'en'

let language: UiLanguage = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'

export function getUiLanguage(): UiLanguage {
  return language
}

const listeners = new Set<() => void>()

export function onUiLanguageChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setUiLanguage(next: UiLanguage): void {
  if (language === next) return
  language = next
  for (const listener of listeners) listener()
}

export function isChinese(): boolean {
  return language === 'zh'
}
