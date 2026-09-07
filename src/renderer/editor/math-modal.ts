import { getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'

export class MathModal {
  private container: HTMLDivElement
  private input: HTMLTextAreaElement
  private isBlockCheckbox: HTMLInputElement
  private header: HTMLHeadingElement
  private blockLabel: HTMLLabelElement
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  private currentTarget: { pos: number; isBlock: boolean } | null = null

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Edit LaTeX Formula'

    this.input = document.createElement('textarea')
    this.input.className = 'math-modal-input'
    this.input.placeholder = 'Enter LaTeX code here... (e.g., E=mc^2)'
    this.input.rows = 4

    const options = document.createElement('div')
    options.className = 'math-modal-options'

    this.isBlockCheckbox = document.createElement('input')
    this.isBlockCheckbox.type = 'checkbox'
    this.isBlockCheckbox.id = 'math-is-block'

    const label = document.createElement('label')
    this.blockLabel = label
    label.htmlFor = 'math-is-block'
    label.textContent = ' Display as block formula (centered)'

    options.append(this.isBlockCheckbox, label)

    const footer = document.createElement('div')
    footer.className = 'math-modal-footer'

    const cancelBtn = document.createElement('button')
    this.cancelButton = cancelBtn
    cancelBtn.textContent = 'Cancel'
    cancelBtn.className = 'math-modal-btn cancel'
    cancelBtn.addEventListener('click', () => this.hide())

    const saveBtn = document.createElement('button')
    this.saveButton = saveBtn
    saveBtn.textContent = 'Insert / Update'
    saveBtn.className = 'math-modal-btn save'
    saveBtn.addEventListener('click', () => this.save())

    footer.append(cancelBtn, saveBtn)
    modal.append(header, this.input, options, footer)
    this.container.appendChild(modal)

    this.container.addEventListener('mousedown', (e) => {
      if (e.target === this.container) this.hide()
    })

    this.container.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.hide()
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        this.save()
      }
    })

    document.body.appendChild(this.container)
    this.setLanguage(isChinese() ? 'zh' : 'en')
  }

  setLanguage(language: UiLanguage): void {
    const zh = language === 'zh'
    this.header.textContent = zh ? '编辑公式' : 'Edit LaTeX Formula'
    this.input.placeholder = zh ? '输入 LaTeX 代码，例如 E=mc^2' : 'Enter LaTeX code, e.g. E=mc^2'
    this.blockLabel.textContent = zh ? ' 作为块公式显示（居中）' : ' Display as block formula (centered)'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? '插入 / 更新' : 'Insert / Update'
  }

  show(initialValue = '', isBlock = false, targetPos: number | null = null): void {
    this.currentTarget = targetPos !== null ? { pos: targetPos, isBlock } : null
    this.input.value = initialValue
    this.isBlockCheckbox.checked = isBlock

    this.container.style.display = 'flex'

    setTimeout(() => {
      this.input.focus()
      if (initialValue) this.input.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
    this.currentTarget = null
    const sourceEditor = this.getSourceEditor()
    if (sourceEditor) {
      sourceEditor.focus()
      return
    }
    const view = getEditorView()
    if (view) view.focus()
  }

  private save(): void {
    const value = this.input.value.trim()
    const isBlock = this.isBlockCheckbox.checked
    const sourceEditor = this.getSourceEditor()

    if (sourceEditor && this.currentTarget === null) {
      if (value) {
        const formula = isBlock ? `\n$$\n${value}\n$$\n` : `$${value}$`
        sourceEditor.setRangeText(
          formula,
          sourceEditor.selectionStart,
          sourceEditor.selectionEnd,
          'end'
        )
      }
      this.hide()
      return
    }

    const view = getEditorView()

    if (!view) {
      this.hide()
      return
    }

    const tr = view.state.tr
    const schema = view.state.schema
    const nodeType = isBlock ? schema.nodes.math_block : schema.nodes.math_inline

    if (!nodeType) {
      console.error('Math schema nodes not found. Is the math plugin loaded?')
      this.hide()
      return
    }

    if (this.currentTarget !== null) {
      const { pos, isBlock: wasBlock } = this.currentTarget
      const node = view.state.doc.nodeAt(pos)

      if (node && (node.type.name === 'math_inline' || node.type.name === 'math_block')) {
        if (!value) {
          tr.delete(pos, pos + node.nodeSize)
        } else if (isBlock === wasBlock) {
          if (isBlock) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, value })
          } else {
            tr.replaceWith(pos, pos + node.nodeSize, nodeType.create(null, schema.text(value)))
          }
        } else if (isBlock) {
          tr.replaceWith(pos, pos + node.nodeSize, nodeType.create({ value }))
        } else {
          tr.replaceWith(pos, pos + node.nodeSize, nodeType.create(null, schema.text(value)))
        }
      }
    } else if (value) {
      const insertNode = isBlock ? nodeType.create({ value }) : nodeType.create(null, schema.text(value))
      tr.replaceSelectionWith(insertNode)
    }

    view.dispatch(tr)
    this.hide()
  }

  private getSourceEditor(): HTMLTextAreaElement | null {
    const sourceEditor = document.getElementById('source-editor') as HTMLTextAreaElement | null
    return sourceEditor?.classList.contains('visible') ? sourceEditor : null
  }
}

export const mathModal = new MathModal()
