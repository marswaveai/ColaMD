import { dirname, resolve, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { ImageSettings } from '../image-types'
import { defaultImageSettings, imageSource, markdownImageSource } from './image-storage'

// Keep titles and angle-delimited destinations intact. The previous [^)]+
// matcher truncated local filenames containing parentheses on the next save.
function rewriteImageSources(content: string, map: (src: string) => string): string {
  const markdown = content.replace(
    /(!\[(?:\\.|[^\]\\\r\n])*\]\()(<[^>\r\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))+)([ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\)))?(\))/g,
    (_all, prefix, destination: string, title, suffix) => {
      const raw = destination.startsWith('<') ? destination.slice(1, -1) : destination
      // Milkdown escapes punctuation such as \( in serialized destinations.
      // Decode Markdown escapes before URL/path conversion; a backslash here
      // is not a filesystem separator (otherwise photo\(1\) becomes photo/(1/)).
      const src = raw.replace(/\\([!-/:-@\[-`{-~])/g, '$1')
      return prefix + markdownImageSource(map(src)) + (title || '') + suffix
    }
  )
  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (_all, prefix, quote, src: string) => {
      // DOM serialization escapes attribute values; map filesystem/URL values,
      // then escape ampersands again when writing the HTML attribute.
      const decoded = src.replaceAll('&quot;', '"').replace(/&#39;|&apos;/g, "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
      return `${prefix}${quote}${map(decoded).replaceAll('&', '&amp;').replaceAll(quote, quote === '"' ? '%22' : '%27')}${quote}`
    })
}

// Literal Markdown examples must stay literal, including during Save As.
export function mapImageSources(content: string, map: (src: string) => string): string {
  const inline = (text: string): string => {
    const runs = [...text.matchAll(/`+/g)]
    let result = ''
    let start = 0
    for (let i = 0; i < runs.length; i++) {
      const open = runs[i]
      const closeIndex = runs.findIndex((run, j) => j > i && run[0].length === open[0].length)
      if (closeIndex === -1) continue
      const close = runs[closeIndex]
      result += rewriteImageSources(text.slice(start, open.index), map)
      start = close.index! + close[0].length
      result += text.slice(open.index, start)
      i = closeIndex
    }
    return result + rewriteImageSources(text.slice(start), map)
  }
  let result = ''
  let pending = ''
  let fence = ''
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      result += line
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+[ \t]*(?:\r?\n)?$/.test(line)) fence = ''
    } else if (marker) {
      result += inline(pending) + line
      pending = ''
      fence = marker
    } else pending += line
  }
  return result + inline(pending)
}

export function resolveImagePaths(content: string, filePath: string): string {
  return mapImageSources(content, (src) => {
    if (/^(?:https?:|file:|data:|blob:)/i.test(src)) return src
    let decoded = src
    try { decoded = decodeURIComponent(src) } catch { /* literal percent */ }
    return pathToFileURL(isAbsolute(decoded) ? decoded : resolve(dirname(filePath), decoded)).href
  })
}

export function restoreImagePaths(content: string, filePath: string, settings: ImageSettings = defaultImageSettings): string {
  return mapImageSources(content, (src) => {
    if (!/^file:/i.test(src)) return src
    try { return imageSource(fileURLToPath(src), filePath, settings) } catch { return src }
  })
}
