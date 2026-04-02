const ALLOWED_HTML_TAGS = new Set([
  'kbd', 'mark', 'sub', 'sup', 'br', 'hr', 'abbr', 'del', 'ins',
  'span', 'div', 'details', 'summary', 'small', 'strong', 'em',
  'code', 'pre', 'b', 'i', 'u', 's', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'blockquote', 'ul', 'ol', 'li', 'p', 'a',
  'img', 'figure', 'figcaption', 'ruby', 'rt', 'rp'
])

const GLOBAL_ALLOWED_ATTRS = new Set([
  'title', 'class', 'role', 'lang', 'dir', 'aria-label', 'aria-hidden'
])

const TAG_ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align']),
  ol: new Set(['start']),
  details: new Set(['open'])
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

function isSafeUrl(tagName: string, attrName: string, value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return true
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return true
  if (tagName === 'img' && attrName === 'src' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return true
  if (tagName === 'img' && attrName === 'src' && trimmed.startsWith('blob:')) return true

  try {
    const parsed = new URL(trimmed, 'https://colamd.local')
    return SAFE_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

function shouldKeepAttribute(tagName: string, attrName: string, value: string): boolean {
  if (attrName.startsWith('on') || attrName === 'style') return false
  if (attrName.startsWith('aria-')) return true
  if (GLOBAL_ALLOWED_ATTRS.has(attrName)) return true
  if (attrName === 'href' || attrName === 'src') return isSafeUrl(tagName, attrName, value)
  return TAG_ALLOWED_ATTRS[tagName]?.has(attrName) ?? false
}

export function sanitizeHTMLFragment(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, 'text/html')

  const walk = (node: Element): void => {
    for (const attr of Array.from(node.attributes)) {
      const attrName = attr.name.toLowerCase()
      if (!shouldKeepAttribute(node.tagName.toLowerCase(), attrName, attr.value)) {
        node.removeAttribute(attr.name)
      }
    }

    if (node.tagName.toLowerCase() === 'a' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer')
    }

    // Collect promoted children before processing so we can recurse into them
    const promoted: Element[] = []
    for (const child of Array.from(node.children)) {
      const tagName = child.tagName.toLowerCase()
      if (!ALLOWED_HTML_TAGS.has(tagName)) {
        // collect childNodes BEFORE replaceWith mutates the DOM
        const childNodes = Array.from(child.childNodes)
        promoted.push(...Array.from(childNodes).filter((n): n is Element => n instanceof Element))
        child.replaceWith(...childNodes)
      } else {
        walk(child)
      }
    }
    // Walk promoted elements so their attributes are also sanitized
    for (const el of promoted) {
      // Check if the promoted element's own tag is allowed, otherwise strip it too
      if (ALLOWED_HTML_TAGS.has(el.tagName.toLowerCase())) {
        walk(el)
      } else {
        // Strip disallowed tag but promote its children for further processing
        const childNodes = Array.from(el.childNodes)
        el.replaceWith(...childNodes)
        promoted.push(...Array.from(childNodes).filter((n): n is Element => n instanceof Element))
      }
    }
  }

  walk(doc.body)
  return doc.body.innerHTML
}
