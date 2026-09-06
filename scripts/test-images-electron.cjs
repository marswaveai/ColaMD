// Run after npm run build: electron scripts/test-images-electron.cjs
// All app data, documents and settings are isolated in a fresh temp directory.
const { app, BrowserWindow, ipcMain, Menu, nativeImage, dialog, clipboard } = require('electron')
const fs = require('node:fs/promises')
const syncFS = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const root = syncFS.mkdtempSync(path.join(os.tmpdir(), 'colamd-electron-images-'))
for (const folder of ['home', 'userData', 'documents']) syncFS.mkdirSync(path.join(root, folder))
app.setPath('home', path.join(root, 'home'))
app.setPath('userData', path.join(root, 'userData'))
app.setPath('documents', path.join(root, 'documents'))
app.commandLine.appendSwitch('lang', 'zh-CN')
syncFS.mkdirSync(path.join(root, 'home/.colamd'))
syncFS.writeFileSync(path.join(root, 'home/.colamd/recent.json'), JSON.stringify({ recent: [], restoreOnLaunch: false }))
const doc = path.join(root, 'documents', '图片测试.md')
const png = nativeImage.createFromBitmap(Buffer.from([40, 140, 220, 255]), { width: 1, height: 1 }).toPNG()
syncFS.writeFileSync(doc, '# Image import test\n\nKeep this paragraph.\n')
const sourceImage = path.join(root, 'source (中文).png')
syncFS.writeFileSync(sourceImage, png)
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceImage] })
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(root, 'documents', '另存为.md') })
let scaleChoice = 50
let alignmentChoice = null
let expectedAlignment = null
const originalPopup = Menu.prototype.popup
Menu.prototype.popup = function (options) {
  const choices = this.items.filter((item) => /^\d+%$/.test(item.label))
  if (choices.length === 6) {
    assert.deepEqual(choices.map((item) => item.label), ['25%', '50%', '75%', '100%', '150%', '200%'])
    const alignments = this.items.filter((item) => item.id?.startsWith('image-align-'))
    assert.deepEqual(alignments.map((item) => item.id), ['image-align-left', 'image-align-center', 'image-align-right'])
    if (expectedAlignment) assert.ok(alignments.find((item) => item.id === `image-align-${expectedAlignment}`).checked, 'menu marks the current alignment')
    if (alignmentChoice) alignments.find((item) => item.id === `image-align-${alignmentChoice}`).click()
    else choices.find((item) => item.label === `${scaleChoice}%`).click()
    options.callback?.()
  } else originalPopup.call(this, options)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(100) }
  throw new Error('Timeout: ' + message)
}
let tested = false
let failure
app.on('browser-window-created', (_event, win) => {
  win.hide()
  win.on('show', () => win.hide())
})
ipcMain.on('renderer-ready', (event) => {
  if (tested) return
  tested = true
  const win = BrowserWindow.fromWebContents(event.sender)
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`)
  const command = (name) => win.webContents.send(name)
  const paste = () => page(async (base64) => {
    const editor = document.querySelector('.ProseMirror')
    editor.focus()
    const range = document.createRange(); range.selectNodeContents(editor.querySelector('p') || editor); range.collapse(false)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, png.toString('base64'))
  const count = () => page(() => document.querySelectorAll('.ProseMirror img[src]').length)
  const closeDialogs = () => page(() => { document.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })) })
  ;(async () => {
    assert.ok(Menu.getApplicationMenu().items.some((item) => /^(Image|图片)$/.test(item.label)))
    await page((doc) => window.electronAPI.openFilePath(doc), doc)
    await until(() => page(() => document.querySelector('.ProseMirror').textContent.includes('Keep this paragraph')), 'document open')
    command('image-open-settings')
    await until(() => page(() => !!document.querySelector('#image-setting-folder')), 'settings dialog')
    assert.equal(await page(() => document.querySelector('#image-setting-folder').options.length), 7)
    assert.equal(await page(() => document.querySelector('#image-setting-clipboardNaming').options.length), 7)
    await fs.writeFile(path.join(root, 'settings.png'), (await win.webContents.capturePage()).toPNG())
    await page(() => {
      const folder = document.querySelector('#image-setting-folder'); folder.value = 'hidden'; folder.dispatchEvent(new Event('change'))
      const name = document.querySelector('#image-setting-clipboardNaming'); name.value = 'document-timestamp'; name.dispatchEvent(new Event('change'))
    })
    await until(() => page(() => document.querySelector('.image-settings-preview').textContent.includes('.assets')), 'live folder preview')
    await page(() => document.querySelector('dialog .math-modal-btn.save').click())
    await until(() => page(() => !document.querySelector('dialog')), 'settings save')
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'home/.colamd/images.json'), 'utf8')).folder, 'hidden')
    command('image-open-settings')
    await until(() => page(() => document.querySelector('#image-setting-folder')?.value === 'hidden'), 'persisted settings')
    await closeDialogs()
    await paste()
    await until(async () => await count() === 1, 'binary clipboard image insertion')
    await until(() => page(() => document.querySelector('.ProseMirror img[src]')?.naturalWidth === 1), 'local image render')
    await paste()
    await until(async () => await count() === 2, 'second clipboard image')
    await until(async () => (await fs.readFile(doc, 'utf8')).includes('.assets/'), 'autosave relative reference')
    let saved = await fs.readFile(doc, 'utf8')
    assert.ok(!saved.includes('data:image/'))
    assert.ok(!saved.includes('file://'))
    const files = await fs.readdir(path.join(root, 'documents/.assets'))
    assert.equal(files.length, 2)
    for (const file of files) assert.deepEqual(await fs.readFile(path.join(root, 'documents/.assets', file)), png)
    command('image-insert-files')
    await until(async () => await count() === 3, 'file picker import')
    await until(() => page(() => [...document.querySelectorAll('.ProseMirror img[src]')].every((i) => i.naturalWidth === 1)), 'all imported images render')
    await until(async () => (await fs.readFile(doc, 'utf8')).includes('<.assets/source (中文).png>'), 'escaped parentheses save correctly')
    const clickFileImage = () => page(() => [...document.querySelectorAll('.ProseMirror img')].find((i) => i.alt.includes('source')).click())
    await clickFileImage()
    await until(() => page(() => document.querySelector('#image-source-markdown')?.value.includes('.assets/source (中文).png')), 'clicked image shows persisted relative path')
    assert.ok(await page(() => !!document.querySelector('.ProseMirror .image-source-inline') && !document.querySelector('dialog')), 'image source must be in the editor, without a dialog')
    await page(() => {
      const source = document.querySelector('#image-source-markdown')
      source.value = '![edited caption](<.assets/source (中文).png> "Image title")'
      source.dispatchEvent(new Event('input'))
      source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await until(() => page(() => !document.querySelector('.image-source-inline') && [...document.querySelectorAll('.ProseMirror img')].some((i) => i.alt === 'edited caption' && i.title === 'Image title' && i.naturalWidth === 1)), 'image source applies alt, title and relative path')
    await page(() => [...document.querySelectorAll('.ProseMirror img')].find((i) => i.alt === 'edited caption').click())
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'inline image source reopen')
    await page(() => {
      const source = document.querySelector('#image-source-markdown'); source.value = 'ordinary text'; source.dispatchEvent(new Event('input'))
    })
    assert.ok(await page(() => document.querySelector('#image-source-markdown').getAttribute('aria-invalid') === 'true'))
    await page(() => document.querySelector('#image-source-markdown').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.ok(await page(() => [...document.querySelectorAll('.ProseMirror img')].some((i) => i.alt === 'edited caption')))
    await page(() => [...document.querySelectorAll('.ProseMirror img')].find((i) => i.alt === 'edited caption').click())
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'inline replace image')
    await page(() => document.querySelector('.image-source-replace').click())
    await until(() => page(() => !document.querySelector('dialog') && [...document.querySelectorAll('.ProseMirror img')].some((i) => /source.*-1\.png/.test(decodeURIComponent(i.src)) && i.naturalWidth === 1)), 'replace image using configured import folder')
    assert.equal(await count(), 3)
    assert.deepEqual(await fs.readFile(sourceImage), png)
    const scaleFileImage = async (value) => {
      scaleChoice = value
      await page(() => [...document.querySelectorAll('.ProseMirror img[src]')].find((i) => i.alt.includes('source')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
      await until(() => page((value) => {
        const image = [...document.querySelectorAll('.ProseMirror img[src]')].find((i) => i.alt.includes('source'))
        return image && Number(getComputedStyle(image).zoom) === value / 100
      }, value), 'image scale ' + value)
    }
    for (const value of [25, 50, 75, 100, 150, 200, 50]) await scaleFileImage(value)
    await clickFileImage()
    await until(() => page(() => document.querySelector('#image-source-markdown')?.value.includes('zoom:')), 'scaled image source retains HTML zoom')
    assert.ok(await page(() => document.querySelector('#image-source-markdown').value.includes('.assets/source (中文)-1.png')))
    await page(() => document.querySelector('.image-source-replace').click())
    await until(() => page(() => !document.querySelector('dialog') && [...document.querySelectorAll('.ProseMirror img[src]')].some((i) => /source.*-2\.png/.test(decodeURIComponent(i.src)) && Number(getComputedStyle(i).zoom) === 0.5)), 'scaled image replacement preserves scale')
    command('toggle-source-mode')
    await until(() => page(() => document.querySelector('#source-editor').classList.contains('visible')), 'source mode')
    await page(async (base64) => {
      const editor = document.querySelector('#source-editor'); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length)
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'source-mode.png', { type: 'image/png' }))
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, png.toString('base64'))
    await until(() => page(() => (document.querySelector('#source-editor').value.match(/!\[|<img\b/g) || []).length === 4), 'source image paste')
    command('toggle-source-mode')
    await until(async () => await count() === 4, 'source to visual')
    command('menu-save-as')
    const moved = path.join(root, 'documents/另存为.md')
    await until(async () => fs.readFile(moved, 'utf8').then((text) => text.includes('.assets/')).catch(() => false), 'save as')
    saved = await fs.readFile(moved, 'utf8')
    assert.ok(!saved.includes('file://'))
    assert.ok(saved.includes('src=".assets/source (中文)-2.png"'))
    assert.ok(saved.includes('zoom:'))
    const reopenOther = path.join(root, 'documents/reopen-other.md')
    await fs.writeFile(reopenOther, '# Reopen test\n')
    await page((doc) => window.electronAPI.openSibling(doc), reopenOther)
    await until(async () => await count() === 0, 'leave document before reopen')
    await page((doc) => window.electronAPI.openSibling(doc), moved)
    await until(() => page(() => document.querySelectorAll('.ProseMirror img[src]').length === 4 && [...document.querySelectorAll('.ProseMirror img[src]')].every((i) => i.naturalWidth === 1)), 'all images render after save and reopen')
    assert.ok(await page(() => [...document.querySelectorAll('.ProseMirror img[src]')].some((i) => i.alt.includes('source') && Number(getComputedStyle(i).zoom) === 0.5)))
    await scaleFileImage(100)
    await until(async () => (await fs.readFile(moved, 'utf8')).includes('<.assets/source (中文)-2.png>'), 'reset image scale restores Markdown syntax')
    await page(() => document.querySelector('.ProseMirror img[src]').click())
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'inline source before document switch')
    await page((doc) => window.electronAPI.openSibling(doc), reopenOther)
    await until(async () => await count() === 0, 'switch while inline image source is open')
    assert.equal(await page(() => document.querySelectorAll('.image-source-inline').length), 0, 'document switch removes inline source')
    assert.equal(await fs.readFile(reopenOther, 'utf8'), '# Reopen test\n')
    await closeDialogs()
    await page((doc) => window.electronAPI.openSibling(doc), moved)
    await until(async () => await count() === 4, 'restore edited image document')
    await page(() => document.querySelector('.ProseMirror').focus())
    await fs.writeFile(path.join(root, 'editor.png'), (await win.webContents.capturePage()).toPNG())
    // Verify data-URL migration, including preservation of an image example
    // inside a fenced code block, through the actual menu command.
    command('toggle-source-mode')
    await until(() => page(() => document.querySelector('#source-editor').classList.contains('visible')), 'migration source mode')
    await page(async (base64) => {
      const source = document.querySelector('#source-editor')
      source.value = '# Migration\n\n![](data:image/png;base64,' + base64 + ')\n\n```md\n![](example.png)\n```\n'
      source.dispatchEvent(new Event('input', { bubbles: true }))
    }, png.toString('base64'))
    command('image-collect')
    await until(() => page(() => !!document.querySelector('dialog .math-modal-btn.save')), 'collection confirmation')
    await page(() => document.querySelector('dialog .math-modal-btn.save').click())
    await until(() => page(() => !document.querySelector('#source-editor').value.includes('data:image/')), 'embedded migration')
    assert.ok(await page(() => document.querySelector('#source-editor').value.includes('![](example.png)')))

    command('toggle-source-mode')
    await until(() => page(() => !document.querySelector('#source-editor').classList.contains('visible')), 'mixed paste visual mode')
    const beforeMixed = await count()
    await page(async (base64) => {
      const editor = document.querySelector('.ProseMirror'); editor.focus()
      const range = document.createRange(); range.selectNodeContents(editor.querySelector('p') || editor); range.collapse(false)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    await new Promise((resolve) => setTimeout(resolve, 30))
      const clipboard = new DataTransfer()
      clipboard.setData('text/html', '<p>Mixed <strong>formatting</strong><img src="data:image/png;base64,' + base64 + '"> tail.</p>')
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    }, png.toString('base64'))
    await until(async () => await count() === beforeMixed + 1, 'mixed text and image paste')
    assert.ok(await page(() => [...document.querySelectorAll('.ProseMirror strong')].some((e) => e.textContent === 'formatting')))
    assert.ok(await page(() => document.querySelector('.ProseMirror').textContent.includes('tail.')))
    const beforeDrop = await count()
    await page(async (base64) => {
      const editor = document.querySelector('.ProseMirror'); editor.focus()
      const paragraph = editor.querySelector('p:last-of-type')
      const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    await new Promise((resolve) => setTimeout(resolve, 30))
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
      const box = paragraph.getBoundingClientRect()
      editor.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5 }))
      document.execCommand('insertText', false, ' typed during import ')
    }, png.toString('base64'))
    await until(async () => await count() === beforeDrop + 1, 'drop with concurrent typing')
    assert.ok(await page(() => document.querySelector('.ProseMirror').textContent.includes('typed during import')))
    assert.ok(await page(() => document.querySelector('.ProseMirror').textContent.includes('tail.')))

    const server = require('node:http').createServer((request, response) => {
      setTimeout(() => { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png) }, request.url === '/slow.png' ? 500 : 0)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = 'http://127.0.0.1:' + server.address().port
      await page(async (root) => {
        const { settings } = await window.electronAPI.getImageSettings()
        await window.electronAPI.saveImageSettings({ ...settings, folder: 'root', rootDirectory: root, rootFolder: '.assets', downloadRemote: true })
      }, root)
      const pasteURL = (url) => page(async (url) => {
        const editor = document.querySelector('.ProseMirror'); editor.focus()
        const range = document.createRange(); range.selectNodeContents(editor.querySelector('p') || editor); range.collapse(false)
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    await new Promise((resolve) => setTimeout(resolve, 30))
        const clipboard = new DataTransfer(); clipboard.setData('text/html', '<img src="' + url + '">')
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
      }, url)
      const beforeRemote = await count()
      await pasteURL(address + '/image.png')
      await until(async () => await count() === beforeRemote + 1, 'remote image download')
      await until(async () => (await fs.readFile(moved, 'utf8')).includes('../.assets/'), 'selected root relative reference')
      const other = path.join(root, 'documents/switched.md')
      await fs.writeFile(other, '# Switched document\n\nKeep this unchanged.\n')
      await pasteURL(address + '/slow.png')
      await page((doc) => window.electronAPI.openSibling(doc), other)
      await until(() => page(() => document.querySelector('.ProseMirror').textContent.includes('Keep this unchanged')), 'switch during remote download')
      await sleep(750)
      assert.equal(await count(), 0)
      assert.equal(await fs.readFile(other, 'utf8'), '# Switched document\n\nKeep this unchanged.\n')
    } finally { await new Promise((resolve) => server.close(resolve)) }
    // A real-sized image catches zoom/max-width cancellation that a 1px fixture cannot.
    const width = 1600, height = 900
    const pixels = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      pixels[p] = x % 200 < 100 ? 180 : 100
      pixels[p + 1] = y % 200 < 100 ? 160 : 100
      pixels[p + 2] = 60; pixels[p + 3] = 255
    }
    await fs.writeFile(path.join(root, 'documents/large.png'), nativeImage.createFromBitmap(pixels, { width, height }).toPNG())
    const layoutDoc = path.join(root, 'documents/layout.md')
    await fs.writeFile(layoutDoc, '# Inline image and scale test\n\n![Large](large.png)\n\nContinue editing here.\n')
    await page((doc) => window.electronAPI.openSibling(doc), layoutDoc)
    await until(() => page(() => document.querySelector('.ProseMirror img')?.naturalWidth === 1600), 'large layout fixture')
    const dimensions = () => page(() => {
      const i = document.querySelector('.ProseMirror img'); const r = i.getBoundingClientRect()
      return { width: r.width, height: r.height }
    })
    const full = await dimensions()
    const scaleSizes = []
    for (const value of [25, 50, 75, 100, 150, 200, 100]) {
      scaleChoice = value
      await page(() => document.querySelector('.ProseMirror img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
      await until(() => page((v) => Number(getComputedStyle(document.querySelector('.ProseMirror img')).zoom) === v / 100, value), 'large image scale ' + value)
      const size = await dimensions()
      assert.ok(Math.abs(size.width - full.width * value / 100) < 2, `Scale ${value}: expected ${full.width * value / 100}, got ${size.width}`)
      assert.ok(Math.abs(size.height / size.width - height / width) < 0.01, 'scale preserves aspect ratio')
      scaleSizes.push({ scale: value, ...size })
    }
    console.log('Large image displayed sizes:', JSON.stringify(scaleSizes))
    await page(() => document.querySelector('.ProseMirror img').click())
    await until(() => page(() => !document.querySelector('#image-source-markdown')?.disabled && !!document.querySelector('#image-source-markdown')), 'inline source for large image')
    assert.ok(await page(() => {
      const source = document.querySelector('.image-source-inline').getBoundingClientRect()
      const image = document.querySelector('.ProseMirror img').getBoundingClientRect()
      return source.bottom <= image.top + 2 && !document.querySelector('dialog')
    }), 'source is in document flow above the image')
    const repeatImageClicks = async () => {
      await page(() => {
        const input = document.querySelector('#image-source-markdown')
        input.focus(); input.setSelectionRange(2, 6)
        window.__inlineClickCheck = {
          input, image: document.querySelector('.ProseMirror img'),
          panel: document.querySelector('.image-source-inline'),
          scroll: document.querySelector('#editor').scrollTop, removals: 0, clicks: 0, mouseDowns: []
        }
        const check = window.__inlineClickCheck
        check.onClick = (event) => { if (event.target === check.image && event.isTrusted) check.clicks++ }
        check.onDown = (event) => { if (event.target === check.image && event.isTrusted) check.mouseDowns.push(event) }
        document.addEventListener('click', check.onClick, true)
        document.addEventListener('mousedown', check.onDown, true)
        check.observer = new MutationObserver((records) => {
          for (const record of records) for (const removed of record.removedNodes) {
            if (removed === check.panel || removed === check.image || removed.contains?.(check.panel) || removed.contains?.(check.image)) check.removals++
          }
        })
        check.observer.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true })
      })
      // Chromium dispatches pointerdown, mousedown, focus changes, mouseup and
      // click. Element.click() alone misses the blur/reopen flicker regression.
      for (let i = 0; i < 3; i++) {
        const point = await page(() => {
          const rect = document.querySelector('.ProseMirror img').getBoundingClientRect()
          return { x: Math.round(rect.left + 20), y: Math.round(Math.max(45, rect.top) + 10) }
        })
        win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
        await sleep(100)
      }
      const result = await page(() => {
        const check = window.__inlineClickCheck
        check.observer.disconnect()
        document.removeEventListener('click', check.onClick, true)
        document.removeEventListener('mousedown', check.onDown, true)
        return {
          sameField: document.querySelector('#image-source-markdown') === check.input,
          sameImage: document.querySelector('.ProseMirror img') === check.image,
          samePanel: document.querySelector('.image-source-inline') === check.panel,
          removals: check.removals, clicks: check.clicks, prevented: check.mouseDowns.filter((event) => event.defaultPrevented).length,
          sameScroll: document.querySelector('#editor').scrollTop === check.scroll,
          selection: [check.input.selectionStart, check.input.selectionEnd]
        }
      })
      assert.deepEqual(result, { sameField: true, sameImage: true, samePanel: true, removals: 0, clicks: 3, prevented: 3, sameScroll: true, selection: [2, 6] })
    }
    await repeatImageClicks()
    await page(() => {
      const field = document.querySelector('#image-source-markdown')
      field.value = '![Edited inline](large.png)'; field.dispatchEvent(new Event('input'))
      document.querySelector('.ProseMirror').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
      document.querySelector('.ProseMirror').focus()
    })
    await until(() => page(() => !document.querySelector('.image-source-inline') && document.querySelector('.ProseMirror img')?.alt === 'Edited inline'), 'blur commits inline edit')
    await until(async () => (await fs.readFile(layoutDoc, 'utf8')).includes('![Edited inline](large.png)'), 'inline source autosaves plain Markdown')
    assert.ok(!(await fs.readFile(layoutDoc, 'utf8')).includes('image-source'))
    await page(() => document.querySelector('.ProseMirror img').click())
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'source before toggle')
    scaleChoice = 50
    await page(() => {
      const field = document.querySelector('#image-source-markdown')
      field.value = '![Saved before scaling](large.png)'; field.dispatchEvent(new Event('input'))
      document.querySelector('.ProseMirror img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    await until(() => page(() => document.querySelector('.ProseMirror img')?.alt === 'Saved before scaling' && Number(getComputedStyle(document.querySelector('.ProseMirror img')).zoom) === 0.5), 'right click commits source before scaling')
    await page(() => { window.__imageBeforeSource = document.querySelector('.ProseMirror img'); window.__imageBeforeSource.click() })
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'scaled source before toggle')
    assert.ok(await page(() => window.__imageBeforeSource === document.querySelector('.ProseMirror img')), 'opening scaled source must retain the loaded image')
    await repeatImageClicks()
    await page(() => document.querySelector('.ProseMirror p:last-child').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })))
    await until(() => page(() => !document.querySelector('.image-source-inline')), 'outside click collapses unchanged source')
    assert.ok(await page(() => window.__imageBeforeSource === document.querySelector('.ProseMirror img')), 'closing scaled source must retain the loaded image')
    await page(() => document.querySelector('.ProseMirror img').click())
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'reopen scaled source before toggle')
    command('toggle-source-mode')
    await until(() => page(() => document.querySelector('#source-editor').classList.contains('visible')), 'toggle removes inline source')
    assert.equal(await page(() => document.querySelectorAll('.image-source-inline').length), 0)
    command('toggle-source-mode')
    await until(() => page(() => !document.querySelector('#source-editor').classList.contains('visible')), 'return to visual')
    const imageLayout = () => page(() => {
      const image = document.querySelector('.ProseMirror img')
      const rect = image.getBoundingClientRect()
      const container = image.closest('p').getBoundingClientRect()
      return { width: rect.width, offset: rect.left - container.left, available: container.width, zoom: Number(getComputedStyle(image).zoom), display: image.style.display }
    })
    const checkAlignment = async (alignment, scale = 50) => {
      const layout = await imageLayout()
      const expectedOffset = alignment === 'left' ? 0 : (layout.available - layout.width) / (alignment === 'center' ? 2 : 1)
      assert.ok(Math.abs(layout.offset - expectedOffset) < 2, `${alignment}: expected offset ${expectedOffset}, got ${layout.offset}`)
      assert.ok(Math.abs(layout.width - full.width * scale / 100) < 2, 'alignment retains displayed scale')
      assert.equal(layout.zoom, scale / 100)
      assert.equal(layout.display, 'block')
      console.log('Image alignment:', alignment, JSON.stringify(layout))
    }
    expectedAlignment = 'left'
    for (const value of ['left', 'center', 'right', 'center']) {
      alignmentChoice = value
      await page(() => document.querySelector('.ProseMirror img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
      await until(() => page((value) => {
        const style = document.querySelector('.ProseMirror img').style
        return style.display === 'block' && style.marginLeft === (value === 'left' ? '0px' : 'auto') && style.marginRight === (value === 'right' ? '0px' : 'auto')
      }, value), 'image alignment ' + value)
      expectedAlignment = value
      await checkAlignment(value)
    }
    alignmentChoice = null
    scaleChoice = 25
    await page(() => document.querySelector('.ProseMirror img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
    await until(() => page(() => Number(getComputedStyle(document.querySelector('.ProseMirror img')).zoom) === 0.25), 'scaling centered image')
    await checkAlignment('center', 25)
    await until(async () => (await fs.readFile(layoutDoc, 'utf8')).includes('margin-left: auto; margin-right: auto;'), 'alignment persists in HTML')
    await page((doc) => window.electronAPI.openSibling(doc), reopenOther)
    await until(async () => await count() === 0, 'leave aligned document')
    await page((doc) => window.electronAPI.openSibling(doc), layoutDoc)
    await until(() => page(() => document.querySelector('.ProseMirror img')?.naturalWidth === 1600), 'reopen aligned document')
    await checkAlignment('center', 25)
    await page(() => document.querySelector('.ProseMirror img').click())
    await until(() => page(() => !!document.querySelector('#image-source-markdown') && !document.querySelector('#image-source-markdown').disabled), 'aligned image inline source')
    await repeatImageClicks()
    await page(() => document.querySelector('.image-source-replace').click())
    await until(() => page(() => document.querySelector('.ProseMirror img')?.naturalWidth === 1 && !document.querySelector('.image-source-inline')), 'replace aligned image')
    assert.ok(await page(() => {
      const style = document.querySelector('.ProseMirror img').style
      return style.display === 'block' && style.marginLeft === 'auto' && style.marginRight === 'auto' && Number(getComputedStyle(document.querySelector('.ProseMirror img')).zoom) === 0.25
    }), 'replacement preserves alignment and scale')
    expectedAlignment = null
    // Opt-in native clipboard check: read the existing system image without
    // replacing the user's clipboard. This uses Chromium's real paste command.
    if (process.env.COLAMD_NATIVE_CLIPBOARD === '1') {
      const original = clipboard.readImage()
      assert.ok(!original.isEmpty(), 'Copy an image to the system clipboard before running this opt-in check')
      const nativeDoc = path.join(root, 'documents/native-clipboard.md')
      await fs.writeFile(nativeDoc, '# Native clipboard\n\nPaste here.\n')
      await page((doc) => window.electronAPI.openSibling(doc), nativeDoc)
      await until(() => page(() => document.querySelector('.ProseMirror')?.textContent.includes('Paste here.')), 'native clipboard document')
      await page(async () => {
        const { defaults } = await window.electronAPI.getImageSettings()
        await window.electronAPI.saveImageSettings(defaults)
        const editor = document.querySelector('.ProseMirror'); editor.focus()
        const range = document.createRange(); range.selectNodeContents(editor.querySelector('p')); range.collapse(false)
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      })
      win.webContents.paste()
      await until(async () => await count() === 1, 'real system image clipboard paste')
      await until(() => page(() => document.querySelector('.ProseMirror img[src]')?.naturalWidth > 0), 'native clipboard image render')
      await until(async () => (await fs.readFile(nativeDoc, 'utf8')).includes('native-clipboard.assets/image-'), 'native clipboard relative reference')
      const folder = path.join(root, 'documents/native-clipboard.assets')
      const files = await fs.readdir(folder)
      assert.equal(files.length, 1)
      assert.match(files[0], /^image-\d{8}-\d{6}-\d{3}\.png$/)
      assert.deepEqual(nativeImage.createFromPath(path.join(folder, files[0])).toBitmap(), original.toBitmap())
      assert.ok(!(await fs.readFile(nativeDoc, 'utf8')).includes('data:image/'))
      const fullWidth = await page(() => document.querySelector('.ProseMirror img[src]').getBoundingClientRect().width)
      scaleChoice = 50
      await page(() => document.querySelector('.ProseMirror img[src]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
      await until(() => page(() => Number(getComputedStyle(document.querySelector('.ProseMirror img[src]')).zoom) === 0.5), 'native clipboard image scale')
      const halfWidth = await page(() => document.querySelector('.ProseMirror img[src]').getBoundingClientRect().width)
      assert.ok(Math.abs(halfWidth - fullWidth / 2) < 2, `50% must visibly shrink a large image (${fullWidth} -> ${halfWidth})`)
      console.log(`Native image displayed width: ${fullWidth} -> ${halfWidth} at 50%.`)
      console.log('Native system clipboard image: pasted, rendered, timestamped file saved; pixels match original.')
    }
    // Load a user-specified document read-only for optional local verification.
    if (process.env.COLAMD_VERIFY_DOCUMENT) {
      const original = syncFS.readFileSync(process.env.COLAMD_VERIFY_DOCUMENT)
      // The app opens the original path to exercise its actual relative images.
      await page((doc) => window.electronAPI.openFilePath(doc), process.env.COLAMD_VERIFY_DOCUMENT)
      const extra = BrowserWindow.getAllWindows().find((candidate) => candidate !== win)
      await until(() => extra?.webContents.executeJavaScript("document.querySelectorAll('.ProseMirror img[src]').length === 3 && [...document.querySelectorAll('.ProseMirror img[src]')].every(i => i.naturalWidth > 0)"), 'user document images render')
      assert.deepEqual(syncFS.readFileSync(process.env.COLAMD_VERIFY_DOCUMENT), original)
    }
    console.log(JSON.stringify({ passed: true, checks: ['native Image menu', 'settings options and preview', 'settings persistence', 'binary clipboard import', 'multiple images', 'file picker', 'inline image source layout/Enter/blur/validation/Escape/repeated native clicks without DOM replacement', 'replace image from file', 'six scale presets with exact large-image dimensions', 'scaled HTML source and replacement', 'scale persistence and reset', 'left/center/right image positions and menu checkmarks', 'alignment with scale, save/reopen and replacement', 'source-mode paste', 'autosave relative paths', 'Save As and reopen with parentheses', 'Base64 collection', 'code example preservation', 'mixed rich-text image paste', 'drop while typing', 'remote download', 'selected root relative paths', 'document switch during import'], artifacts: root }))
  })().catch(async (error) => { failure = error; console.error(error); console.log('Artifacts:', root); console.log(await page(() => ({dialogs: [...document.querySelectorAll('dialog')].map(d => d.textContent), content: document.querySelector('.ProseMirror')?.innerHTML}))); await fs.writeFile(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }).finally(() => {
    // Leave the temp artifacts for review, but never run normal close-save UI.
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.exit(failure ? 1 : 0)
  })
})
setTimeout(() => { console.error('Electron image tests timed out:', root); app.exit(1) }, 60000).unref()
require(process.env.COLAMD_TEST_ASAR ? path.join(process.env.COLAMD_TEST_ASAR, 'dist/main/index.js') : '../dist/main/index.js')
