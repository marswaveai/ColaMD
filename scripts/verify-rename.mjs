import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, stat, lstat, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Consume the real TypeScript helper without requiring Node's native TS loader.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/main/rename-file.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const { renameDocument } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

const dir = await mkdtemp(join(tmpdir(), 'colamd-rename-'))
try {
  const source = join(dir, '原文件.md')
  const other = join(dir, '其他文件.md')
  const bytes = Buffer.from('---\r\ntitle: 测试\r\n---\r\n# 保留原字节\r\n')
  await writeFile(source, bytes)
  await writeFile(other, 'do not overwrite')
  const before = await stat(source)
  const otherBefore = await stat(other)
  const target = await renameDocument(source, '新名称')
  assert.equal(target, join(dir, '新名称.md'))
  assert.deepEqual(await readFile(target), bytes)
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs)
  assert.equal((await stat(target)).ino, before.ino)
  await assert.rejects(lstat(source), { code: 'ENOENT' })
  await assert.rejects(renameDocument(target, '其他文件.md'), { code: 'EEXIST' })
  assert.equal(await readFile(other, 'utf8'), 'do not overwrite')
  assert.equal((await stat(other)).mtimeMs, otherBefore.mtimeMs)
  for (const name of ['', ' ', '../escape.md', 'a/b.md', 'a\\b.md', 'a\0.md', '.', '..', 'new.txt']) {
    await assert.rejects(renameDocument(target, name), { code: 'EINVAL' })
  }
  await assert.rejects(renameDocument(join(dir, 'missing.md'), 'x.md'), { code: 'ENOENT' })
  await assert.rejects(renameDocument(join(dir, 'missing.md'), 'missing.md'), { code: 'ENOENT' })
  assert.equal(await renameDocument(target, '新名称.md'), target)
  await symlink(target, source)
  await assert.rejects(renameDocument(source, 'symlink.md'), { code: 'EINVAL' })
  await assert.rejects(renameDocument(source, '原文件.md'), { code: 'EINVAL' })
  const a = join(dir, 'a.md'), b = join(dir, 'b.md')
  await writeFile(a, 'A'); await writeFile(b, 'B')
  const outcomes = await Promise.allSettled([renameDocument(a, 'race.md'), renameDocument(b, 'race.md')])
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find((r) => r.status === 'rejected').reason.code, 'EEXIST')
  assert.equal(await readFile(outcomes[0].status === 'rejected' ? a : b, 'utf8'), outcomes[0].status === 'rejected' ? 'A' : 'B')
  console.log('PASS: Unicode, unchanged bytes/mtime/inode, missing extension, collisions, invalid paths, missing source, symlinks and concurrent targets')
} finally {
  await rm(dir, { recursive: true, force: true })
}
