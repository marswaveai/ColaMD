// 检索面板：编辑器侧的高亮与滚动。
//
// 核心换成 CodeMirror 之后，这里的两件事跟着换：
//   1. 高亮从 ProseMirror 的 DecorationSet 换成 CM6 的 Decoration
//   2. 改写从 transaction 换成 changes
// 源码模式那条路仍走 textarea，不受影响。
//
// 高亮的 StateField 在 search-highlight.ts：它要装进编辑器扩展，从这里定义会绕成
// core → search-panel → editor → core 的循环依赖。

import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, type StateEffect } from '@codemirror/state'
import { getEditorView } from './editor'
import { setSearchHighlight } from './search-highlight'
import { getUiLanguage, type UiLanguage } from '../ui-language'
import { findTextMatches, replaceTextMatches } from './table-editing'

export class SearchPanel {
  private container: HTMLDivElement
  private input: HTMLInputElement
  private replaceInput: HTMLInputElement
  private countEl: HTMLSpanElement
  private replaceRow: HTMLDivElement
  private replaceButton: HTMLButtonElement
  private replaceAllButton: HTMLButtonElement
  private prevButton: HTMLButtonElement
  private nextButton: HTMLButtonElement
  private closeButton: HTMLButtonElement
  private matches: { from: number; to: number }[] = []
  private currentIndex = -1
  private visible = false

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'search-panel'
    this.container.style.display = 'none'

    this.input = document.createElement('input')
    this.input.type = 'text'
    this.input.placeholder = 'Search...'
    this.input.className = 'search-input'

    this.countEl = document.createElement('span')
    this.countEl.className = 'search-count'

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'search-replace-row'
    this.replaceInput = document.createElement('input')
    this.replaceInput.type = 'text'
    this.replaceInput.placeholder = 'Replace...'
    this.replaceInput.className = 'search-input search-replace-input'
    const replaceBtn = this.btn('替换', 'search-action', () => this.replaceCurrent())
    const replaceAllBtn = this.btn('全部替换', 'search-action', () => this.replaceAll())
    this.replaceButton = replaceBtn
    this.replaceAllButton = replaceAllBtn
    this.replaceRow.append(this.replaceInput, replaceBtn, replaceAllBtn)

    const prevBtn = this.btn('\u2039', 'search-btn', () => this.prev())
    const nextBtn = this.btn('\u203A', 'search-btn', () => this.next())
    const closeBtn = this.btn('\u00D7', 'search-btn search-close', () => this.hide())
    this.prevButton = prevBtn
    this.nextButton = nextBtn
    this.closeButton = closeBtn

    this.container.append(this.input, this.countEl, prevBtn, nextBtn, closeBtn, this.replaceRow)

    this.input.addEventListener('input', () => this.search())
    this.input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        this.replaceAll()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) this.prev()
        else this.next()
      }
    })

    this.replaceInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        this.replaceAll()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        this.replaceCurrent()
      }
    })

    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.hide()
      } else {
        e.stopPropagation()
      }
    })

    document.addEventListener(
      'keydown',
      (e) => {
        if (this.visible && e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          this.hide()
        }
      },
      true
    )

    document.body.appendChild(this.container)
    this.setLanguage(getUiLanguage())
  }

  setLanguage(language: UiLanguage): void {
    const zh = language === 'zh'
    this.input.placeholder = zh ? '查找' : 'Find'
    this.replaceInput.placeholder = zh ? '替换为' : 'Replace with'
    this.replaceButton.textContent = zh ? '替换' : 'Replace'
    this.replaceAllButton.textContent = zh ? '全部替换' : 'Replace All'
    this.prevButton.title = zh ? '上一个' : 'Previous'
    this.nextButton.title = zh ? '下一个' : 'Next'
    this.closeButton.title = zh ? '关闭' : 'Close'
  }

  show(): void {
    this.container.style.display = 'grid'
    this.visible = true
    this.input.focus()
    this.input.select()
    if (this.input.value) this.search()
  }

  hide(): void {
    this.container.style.display = 'none'
    this.visible = false
    this.clearDecorations()
    this.matches = []
    this.currentIndex = -1
    this.countEl.textContent = ''
    const sourceEditor = this.getSourceEditor()
    if (sourceEditor) {
      sourceEditor.focus()
      return
    }
    const view = getEditorView()
    if (view) view.focus()
  }

  private replaceCurrent(): void {
    if (this.currentIndex < 0 || this.currentIndex >= this.matches.length) return
    const sourceEditor = this.getSourceEditor()
    const replacement = this.replaceInput.value
    if (sourceEditor) {
      const match = this.matches[this.currentIndex]
      sourceEditor.setRangeText(replacement, match.from, match.to, 'select')
      sourceEditor.dispatchEvent(new Event('input', { bubbles: true }))
      this.searchSourceEditor(this.input.value, sourceEditor)
      return
    }
    const view = getEditorView()
    if (!view) return
    const match = this.matches[this.currentIndex]
    replaceTextMatches(view, [match], replacement)
    this.search()
  }

  private replaceAll(): void {
    const query = this.input.value
    if (!query || this.matches.length === 0) return
    const sourceEditor = this.getSourceEditor()
    const replacement = this.replaceInput.value
    if (sourceEditor) {
      sourceEditor.value = sourceEditor.value.replace(new RegExp(this.escapeRegExp(query), 'gi'), () => replacement)
      sourceEditor.dispatchEvent(new Event('input', { bubbles: true }))
      this.searchSourceEditor(query, sourceEditor)
      return
    }
    const view = getEditorView()
    if (!view) return
    replaceTextMatches(view, this.matches, replacement)
    this.search()
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  private btn(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.textContent = text
    button.className = className
    button.addEventListener('click', onClick)
    return button
  }

  private search(): void {
    const query = this.input.value
    const sourceEditor = this.getSourceEditor()
    if (sourceEditor) {
      this.searchSourceEditor(query, sourceEditor)
      return
    }

    const view = getEditorView()
    if (!view) return

    this.matches = []
    this.currentIndex = -1

    if (!query) {
      this.clearDecorations()
      this.updateCount()
      return
    }

    this.matches = findTextMatches(view.state, query)

    if (this.matches.length > 0) {
      this.currentIndex = 0
      this.highlight(view, true)
    } else {
      this.clearDecorations()
    }
    this.updateCount()
  }

  private getSourceEditor(): HTMLTextAreaElement | null {
    const sourceEditor = document.getElementById('source-editor') as HTMLTextAreaElement | null
    return sourceEditor?.classList.contains('visible') ? sourceEditor : null
  }

  private searchSourceEditor(query: string, sourceEditor: HTMLTextAreaElement): void {
    this.clearDecorations()
    this.matches = []
    this.currentIndex = -1

    if (!query) {
      this.updateCount()
      return
    }

    for (const match of sourceEditor.value.matchAll(new RegExp(this.escapeRegExp(query), 'gi'))) {
      this.matches.push({ from: match.index!, to: match.index! + match[0].length })
    }

    if (this.matches.length > 0) {
      this.currentIndex = 0
      this.selectSourceMatch(sourceEditor)
    }
    this.updateCount()
  }

  /**
   * 画高亮，顺便把当前匹配项滚进视野。
   *
   * 滚动交给 CM6 自己的 scrollIntoView，不要自己算：正文滚在 `.cm-scroller` 上，
   * 而 `#editor` 早就不动了（换内核时漏改，2026-10-03 报的「按下一个不跳」）。
   * 另外远处的匹配项还没渲染进 DOM，`coordsAtPos()` 会返回 null，自己算等于直接放弃；
   * CM6 这条路会先把目标行纳入视口再滚，因此不受渲染范围限制。
   */
  private highlight(view: NonNullable<ReturnType<typeof getEditorView>>, scroll = false): void {
    const builder = new RangeSetBuilder<Decoration>()
    this.matches.forEach((match, index) => {
      const className = index === this.currentIndex ? 'search-match-current' : 'search-match'
      builder.add(match.from, match.to, Decoration.mark({ class: className }))
    })
    const effects: StateEffect<unknown>[] = [setSearchHighlight.of(builder.finish())]
    const current = this.matches[this.currentIndex]
    if (scroll && current) effects.push(EditorView.scrollIntoView(current.from, { y: 'center' }))
    view.dispatch({ effects })
  }

  private clearDecorations(): void {
    const view = getEditorView()
    if (!view) return
    view.dispatch({ effects: setSearchHighlight.of(Decoration.none) })
  }

  private next(): void {
    if (this.matches.length === 0) return
    this.currentIndex = (this.currentIndex + 1) % this.matches.length
    const sourceEditor = this.getSourceEditor()
    if (sourceEditor) {
      this.selectSourceMatch(sourceEditor)
      this.updateCount()
      return
    }

    const view = getEditorView()
    if (view) this.highlight(view, true)
    this.updateCount()
  }

  private prev(): void {
    if (this.matches.length === 0) return
    this.currentIndex = (this.currentIndex - 1 + this.matches.length) % this.matches.length
    const sourceEditor = this.getSourceEditor()
    if (sourceEditor) {
      this.selectSourceMatch(sourceEditor)
      this.updateCount()
      return
    }

    const view = getEditorView()
    if (view) this.highlight(view, true)
    this.updateCount()
  }

  private updateCount(): void {
    if (this.matches.length === 0) {
      this.countEl.textContent = this.input.value ? '0/0' : ''
    } else {
      this.countEl.textContent = `${this.currentIndex + 1}/${this.matches.length}`
    }
  }

  private selectSourceMatch(sourceEditor: HTMLTextAreaElement): void {
    if (this.currentIndex < 0 || this.currentIndex >= this.matches.length) return
    const match = this.matches[this.currentIndex]
    sourceEditor.focus()
    sourceEditor.setSelectionRange(match.from, match.to)
    this.input.focus()
  }
}
