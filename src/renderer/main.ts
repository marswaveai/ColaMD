import { createEditor, getMarkdown, setMarkdown } from './editor/editor'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
import './themes/base.css'

async function init(): Promise<void> {
  applyTheme(loadSavedTheme())

  await createEditor('editor')

  const api = window.electronAPI

  api.onMenuOpen(async () => {
    const result = await api.openFile()
    if (result) setMarkdown(result.content)
  })

  api.onMenuSave(() => api.saveFile(getMarkdown()))
  api.onMenuSaveAs(() => api.saveFileAs(getMarkdown()))
  api.onMenuExportPDF(() => api.exportPDF())
  api.onNewFile(() => setMarkdown(''))
  api.onFileOpened((data) => setMarkdown(data.content))
  api.onFileChanged((content) => setMarkdown(content))
  api.onSetTheme((theme) => applyTheme(theme))

  api.onMenuImportTheme(async () => {
    const css = await api.loadCustomTheme()
    if (css) applyTheme('custom', css)
  })

  // Handle drag-and-drop of text files
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (!filePath) return
    const result = await api.openFilePath(filePath)
    if (result) setMarkdown(result.content)
  })
}

init().catch((e) => console.error('ColaMD init failed:', e))
