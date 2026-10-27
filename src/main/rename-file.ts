import { basename, dirname, extname, isAbsolute, join } from 'path'
import { link, lstat, unlink } from 'fs/promises'

// link is exclusive: an existing destination is never replaced, even if it
// appears between validation and the filesystem operation. Keep the same inode,
// bytes and metadata; remove the original name only after the new name exists.
export async function renameDocument(source: string, name: string): Promise<string> {
  if (!isAbsolute(source) || !name || name !== name.trim() || /[\\/\x00-\x1f:]/.test(name) || name === '.' || name === '..') {
    throw Object.assign(new Error('Invalid filename'), { code: 'EINVAL' })
  }
  if (!extname(name)) name += extname(source)
  if (extname(name).toLowerCase() !== extname(source).toLowerCase()) {
    throw Object.assign(new Error('Keep the document extension'), { code: 'EINVAL' })
  }
  const target = join(dirname(source), name)
  const info = await lstat(source)
  if (!info.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'EINVAL' })
  if (basename(source) === name) return source
  await link(source, target)
  try {
    await unlink(source)
  } catch (error) {
    await unlink(target).catch(() => {})
    throw error
  }
  return target
}
