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
  dom.append(...Array.from(parsed.body.childNodes))

  // Inline-HTML images show their alt text as a caption below the image,
  // matching the markdown image node view.
  const image = dom.querySelector('img')
  if (image instanceof HTMLImageElement && image.alt) {
    const caption = document.createElement('span')
    caption.className = 'cmd-image-caption'
    caption.textContent = image.alt
    dom.appendChild(caption)
  }
  return dom
}

export const htmlView = $view(htmlSchema.node, (): NodeViewConstructor => {
  return (node) => ({
    dom: renderHTML(String(node.attrs.value ?? '')),
    stopEvent: () => true,
    // The rendered DOM is fully ours (stopEvent blocks native editing inside),
    // so attribute tweaks — e.g. the image toolbar resizing an <img> during a
    // drag — must not be mistaken for unexpected external mutations.
    ignoreMutation: () => true,
  })
})
