export type UiLanguage = 'zh' | 'en'

let language: UiLanguage = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'

export function getUiLanguage(): UiLanguage {
  return language
}

export function setUiLanguage(next: UiLanguage): void {
  language = next
}

export function isChinese(): boolean {
  return language === 'zh'
}
