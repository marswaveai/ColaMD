import { $view } from '@milkdown/kit/utils'
import { htmlSchema } from '@milkdown/kit/preset/commonmark'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'

const BLOCKED_TAGS = new Set(['audio', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style', 'video'])

function renderHTML(value: string): HTMLSpanElement {
  const dom = document.createElement('span')
  dom.classList.add('milkdown-html-inline')

  const parsed = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html')
  parsed.body.querySelectorAll('*').forEach((element) => {
    if (BLOCKED_TAGS.has(element.tagName.toLowerCase())) {
      element.remove()
      return
    }
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        element.removeAttribute(attribute.name)
      }
      const resource = attribute.name.toLowerCase() === 'src' || attribute.name.toLowerCase() === 'href'
      if (resource && /^(?:javascript|vbscript):/i.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name)
      }
    }
  })
  // Chromium applies a percentage max-width in the zoomed coordinate system.
  // With just max-width:100%, a large screenshot at 50% can still fill almost
  // the entire editor. Scale the width limit as well as the intrinsic image:
  // displayed width = min(intrinsic width, available width) * zoom.
  // Keep this rendering constraint out of the serialized HTML.
  parsed.body.querySelectorAll('img').forEach((image) => {
    const zoom = image.style.zoom
    const factor = parseFloat(zoom) / (zoom.endsWith('%') ? 100 : 1)
    if (Number.isFinite(factor) && factor > 0 && !image.style.maxWidth) {
      image.style.maxWidth = `${factor * 100}%`
    }
  })
  dom.append(...Array.from(parsed.body.childNodes))
  return dom
}

export const htmlView = $view(htmlSchema.node, (): NodeViewConstructor => {
  return (node) => {
    const value = String(node.attrs.value ?? '')
    return {
      dom: renderHTML(value),
      // Selection decorations must not rebuild/reload an unchanged image.
      update: (next) => next.type === node.type && String(next.attrs.value ?? '') === value,
      stopEvent: () => true,
    }
  }
})
