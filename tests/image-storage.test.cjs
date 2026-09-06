const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { fileURLToPath, pathToFileURL } = require('node:url')
const {
  storeImage, imageDirectory, imageSource, validateImageSettings, defaultImageSettings,
  loadImageSettings, persistImageSettings, existingImageInput
} = require(path.join(process.env.COLAMD_IMAGE_TEST_BUILD, 'image-storage.js'))
const { resolveImagePaths, restoreImagePaths } = require(path.join(process.env.COLAMD_IMAGE_TEST_BUILD, 'image-paths.js'))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=', 'base64')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'colamd-images-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const doc = path.join(root, '中文 notes', '实验.md')
  await fs.mkdir(path.dirname(doc))
  await fs.writeFile(doc, '# Document\n')
  return { root, doc, settings: { ...defaultImageSettings }, input: { name: 'image.png', data: png, origin: 'clipboard' } }
}

test('clipboard PNG bytes become a relative Markdown attachment and survive reopen', async (t) => {
  const f = await fixture(t)
  const result = await storeImage(f.input, f.settings, f.doc)
  assert.deepEqual(await fs.readFile(fileURLToPath(result.src)), png)
  assert.match(result.src, /image-\d{8}-\d{6}-\d{3}\.png$/)
  const content = `![screenshot](${result.src})`
  const saved = restoreImagePaths(content, f.doc)
  assert.ok(saved.startsWith('![screenshot](实验.assets/'))
  assert.equal(resolveImagePaths(saved, f.doc), content)
})

test('all folder presets resolve against the document or explicit root', async (t) => {
  const f = await fixture(t)
  const expected = { document: '.', assets: 'assets', hidden: '.assets', 'document-assets': '实验.assets', 'hidden-document': '.assets/实验' }
  for (const [folder, suffix] of Object.entries(expected)) {
    assert.equal(imageDirectory({ ...f.settings, folder }, f.doc), path.resolve(path.dirname(f.doc), suffix))
  }
  const rootSettings = { ...f.settings, folder: 'root', rootDirectory: f.root, rootFolder: '.assets' }
  assert.equal(imageDirectory(rootSettings, f.doc), path.join(f.root, '.assets'))
  assert.equal(imageSource(path.join(f.root, '.assets', 'one.png'), f.doc, rootSettings), '../.assets/one.png')
  assert.equal(imageDirectory({ ...rootSettings, rootFolder: '.' }, f.doc), f.root)
  assert.equal(imageDirectory({ ...f.settings, folder: 'custom', customFolder: '../${year}/${month}/${filename}' }, f.doc, new Date(2026, 8, 6)), path.join(f.root, '2026/09/实验'))
})

test('concurrent same-name imports never overwrite each other', async (t) => {
  const f = await fixture(t)
  const imports = await Promise.all(Array.from({ length: 20 }, (_, i) => storeImage({ ...f.input, origin: 'file', data: Buffer.concat([png, Buffer.from([i])]) }, f.settings, f.doc)))
  assert.equal(new Set(imports.map((i) => i.src)).size, 20)
  for (const [i, image] of imports.entries()) assert.equal((await fs.readFile(fileURLToPath(image.src))).at(-1), i)
})

test('content deduplication reuses only identical bytes', async (t) => {
  const f = await fixture(t)
  f.settings.deduplicate = true
  const first = await storeImage(f.input, f.settings, f.doc)
  const same = await storeImage({ ...f.input, name: 'different-name.png' }, f.settings, f.doc)
  const other = await storeImage({ ...f.input, data: Buffer.concat([png, Buffer.from('different')]) }, f.settings, f.doc)
  assert.equal(first.src, same.src)
  assert.notEqual(first.src, other.src)
})

test('reference mode retains the original file; clipboard images still get a file', async (t) => {
  const f = await fixture(t)
  f.settings.action = 'reference'
  const original = path.join(f.root, 'original.png')
  await fs.writeFile(original, png)
  const image = await storeImage({ path: original, name: 'original.png', origin: 'file' }, f.settings, f.doc)
  assert.equal(image.src, pathToFileURL(original).href)
  const clipboard = await storeImage(f.input, f.settings, f.doc)
  assert.notEqual(clipboard.src, image.src)
  assert.deepEqual(await fs.readFile(fileURLToPath(clipboard.src)), png)
})

test('embed preserves bytes and explicit collection can externalize them', async (t) => {
  const f = await fixture(t)
  f.settings.action = 'embed'
  const embedded = await storeImage(f.input, f.settings, f.doc)
  assert.equal(embedded.src, 'data:image/png;base64,' + png.toString('base64'))
  const input = existingImageInput(embedded.src, f.doc)
  const image = await storeImage(input, f.settings, f.doc, true)
  assert.deepEqual(await fs.readFile(fileURLToPath(image.src)), png)
})

test('all naming modes produce safe paths; extensions follow the actual bytes', async (t) => {
  const f = await fixture(t)
  for (const mode of ['original', 'timestamp', 'document-timestamp', 'random', 'hash', 'sequence', 'custom']) {
    const settings = { ...f.settings, clipboardNaming: mode, nameTemplate: '${documentName}-${date}-${time}-${name}-${hash}-${random}.${ext}' }
    const image = await storeImage({ ...f.input, name: 'wrong.jpg' }, settings, f.doc)
    const destination = fileURLToPath(image.src)
    assert.equal(path.extname(destination), '.png')
    assert.equal(path.dirname(destination), imageDirectory(settings, f.doc))
    assert.deepEqual(await fs.readFile(destination), png)
  }
})

test('sequential filenames fill the next unused number', async (t) => {
  const f = await fixture(t)
  f.settings.clipboardNaming = 'sequence'
  assert.ok((await storeImage(f.input, f.settings, f.doc)).src.endsWith('-001.png'))
  assert.ok((await storeImage(f.input, f.settings, f.doc)).src.endsWith('-002.png'))
})

test('invalid bytes, traversal templates and invalid settings fail without touching the document', async (t) => {
  const f = await fixture(t)
  await assert.rejects(storeImage({ ...f.input, data: Buffer.from('not an image') }, f.settings, f.doc), /Unsupported/)
  assert.throws(() => validateImageSettings({ ...f.settings, folder: 'root', rootDirectory: f.root, rootFolder: '../escape' }), /inside/)
  assert.throws(() => validateImageSettings({ ...f.settings, clipboardNaming: 'custom', nameTemplate: '../${name}.${ext}' }), /filename/)
  assert.throws(() => validateImageSettings({ ...f.settings, clipboardNaming: 'custom', nameTemplate: '${unknown}' }), /Unknown/)
  assert.equal(await fs.readFile(f.doc, 'utf8'), '# Document\n')
})

test('unwritable image destination leaves original Markdown unchanged', async (t) => {
  const f = await fixture(t)
  const blocked = imageDirectory(f.settings, f.doc)
  await fs.writeFile(blocked, 'this is a file, not a directory')
  await assert.rejects(storeImage(f.input, f.settings, f.doc))
  assert.equal(await fs.readFile(f.doc, 'utf8'), '# Document\n')
})

test('paths with spaces, Unicode, parentheses and titles round trip and rebase on Save As', async (t) => {
  const f = await fixture(t)
  const target = path.join(path.dirname(f.doc), '.assets', '中文 image (1).png')
  const url = pathToFileURL(target).href
  const content = `![plot](<${url}> "a title")\n<img src="${url}" width="200">`
  for (const escapePath of [false, true]) {
    const settings = { ...f.settings, escapePath, dotPrefix: true }
    const saved = restoreImagePaths(content, f.doc, settings)
    assert.equal(resolveImagePaths(saved, f.doc), content)
    const newDoc = path.join(f.root, 'moved.md')
    assert.equal(resolveImagePaths(restoreImagePaths(content, newDoc, settings), newDoc), content)
  }
})

test('HTTP and Base64 image destinations are retained on save', async (t) => {
  const f = await fixture(t)
  const content = `![remote](https://example.com/a.png)\n![](data:image/png;base64,${png.toString('base64')})`
  assert.equal(restoreImagePaths(content, f.doc), content)
  assert.equal(resolveImagePaths(content, f.doc), content)
})

test('Milkdown-escaped parentheses remain filename characters after save and reopen', async (t) => {
  const f = await fixture(t)
  const target = path.join(path.dirname(f.doc), '.assets', '中文 image (1).png')
  const url = pathToFileURL(target).href
  const serialized = `![plot](${url.replace(/[()]/g, '\\$&')})`
  const saved = restoreImagePaths(serialized, f.doc)
  assert.equal(saved, '![plot](<.assets/中文 image (1).png>)')
  assert.equal(resolveImagePaths(saved, f.doc), `![plot](<${url}>)`)
  const escapedAlt = serialized.replace('![plot]', '![plot \\[1\\]]')
  assert.equal(restoreImagePaths(escapedAlt, f.doc), '![plot \\[1\\]](<.assets/中文 image (1).png>)')
  assert.equal(resolveImagePaths('![plot](.assets/photo\\(1\\).png)', f.doc),
    `![plot](<${pathToFileURL(path.join(path.dirname(f.doc), '.assets/photo(1).png')).href}>)`)
})

test('scaled HTML images preserve zoom and ampersands through save and reopen', async (t) => {
  const f = await fixture(t)
  const url = pathToFileURL(path.join(path.dirname(f.doc), '.assets', 'a&b (1).png')).href.replaceAll('&', '&amp;')
  const html = `<img src="${url}" alt="a &amp; b" style="zoom: 50%;">`
  const saved = restoreImagePaths(html, f.doc)
  assert.equal(saved, '<img src=".assets/a&amp;b (1).png" alt="a &amp; b" style="zoom: 50%;">')
  assert.equal(resolveImagePaths(saved, f.doc), html)
})

test('settings persist atomically and invalid files recover to defaults', async (t) => {
  const f = await fixture(t)
  const location = path.join(f.root, 'settings/images.json')
  assert.deepEqual(await loadImageSettings(location), defaultImageSettings)
  const wanted = { ...f.settings, folder: 'hidden', clipboardNaming: 'document-timestamp' }
  await persistImageSettings(location, wanted)
  assert.deepEqual(await loadImageSettings(location), wanted)
  await assert.rejects(persistImageSettings(location, { ...wanted, action: 'invalid' }))
  assert.deepEqual(await loadImageSettings(location), wanted)
  await fs.writeFile(location, 'invalid json')
  assert.deepEqual(await loadImageSettings(location), defaultImageSettings)
})


test('image-looking Markdown inside inline and fenced code stays literal', async (t) => {
  const f = await fixture(t)
  const content = 'Example: `![](one.png)` and ``![](two.png)``.\n\n```md\n![](three.png)\n```\n\n~~~html\n<img src="four.png">\n~~~\n'
  assert.equal(resolveImagePaths(content, f.doc), content)
  assert.equal(restoreImagePaths(content, f.doc), content)
})


test('concurrent identical imports deduplicate across requests', async (t) => {
  const f = await fixture(t)
  f.settings.deduplicate = true
  const images = await Promise.all(Array.from({ length: 12 }, () => storeImage(f.input, f.settings, f.doc)))
  assert.equal(new Set(images.map((image) => image.src)).size, 1)
})


test('multi-megabyte embedded screenshots can be opened and saved', async (t) => {
  const f = await fixture(t)
  const content = '![](data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024) + ')'
  assert.equal(resolveImagePaths(content, f.doc), content)
  assert.equal(restoreImagePaths(content, f.doc), content)
})
