import { dirname, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'

export interface MarkdownLink {
  path: string
  fragment: string
  line?: number
}

/** Resolve against the document, not the renderer's app.asar URL or process cwd. */
export function resolveMarkdownLink(href: string, sourcePath: string | null): MarkdownLink | null {
  if (!href || href.startsWith('#')) return null
  const hash = href.indexOf('#')
  const fragment = hash < 0 ? '' : href.slice(hash + 1)
  let pathname = (hash < 0 ? href : href.slice(0, hash)).split('?')[0]
  // Strip a one-based source line before decoding, preserving encoded colons
  // in filenames and the colon in a Windows drive prefix.
  const suffix = /:(\d+)$/.exec(pathname)
  const line = suffix ? Number(suffix[1]) : undefined
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null
  if (suffix) pathname = pathname.slice(0, suffix.index)
  let path: string
  if (/^file:/i.test(pathname)) {
    path = fileURLToPath(pathname)
  } else {
    // A drive letter is not a URI scheme. All other schemes remain disallowed.
    if (/^[a-z][a-z\d+.-]*:/i.test(pathname) && !/^[a-z]:[\\/]/i.test(pathname)) return null
    const decoded = decodeURIComponent(pathname)
    if (!isAbsolute(decoded) && !sourcePath) return null
    path = isAbsolute(decoded) ? resolve(decoded) : resolve(dirname(sourcePath!), decoded)
  }
  if (!['.md', '.markdown', '.mdown', '.mkd'].includes(extname(path).toLowerCase())) return null
  return { path, fragment, line }
}
