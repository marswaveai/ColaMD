// 用户文件里的 HTML 要画出来，但画在我们自己的界面里。
//
// 这里是唯一一道闸：markdown 文件是别人给的，里面的 HTML 会进到应用的 DOM 里。
// 放行的原则是「只留能排版的东西」：
//   - 会执行、会加载外部资源、会盖住界面的标签（script/iframe/object/style/video…）整块删掉；
//   - `on*` 事件属性、`javascript:` 地址一律去掉；
//   - `style` 只留排版相关的属性，`position`/`z-index` 这类能让元素盖住整个应用的不留。
//
// 放行不了的就当普通文字，绝不为了好看去执行文件里的东西。

/** 整块删掉的标签：会执行代码、会拉外部资源、会盖住界面。 */
const BLOCKED_TAGS = new Set([
  'audio', 'base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'meta',
  'noscript', 'object', 'script', 'select', 'style', 'template', 'textarea', 'video',
])

/** `style` 里放行的属性。其余（position/z-index/transform 等）一律丢掉。 */
const SAFE_STYLE_PROPERTY = /^(?:text-align|color|background|background-color|font|font-size|font-family|font-weight|font-style|line-height|letter-spacing|margin|margin-(?:top|right|bottom|left)|padding|padding-(?:top|right|bottom|left)|border|border-(?:top|right|bottom|left|width|style|color|radius)|border-radius|width|height|max-width|max-height|min-width|min-height|vertical-align|display|float|list-style|opacity|white-space|text-decoration|text-indent)$/i

/** 地址类属性里不许出现的协议。 */
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i

function cleanStyle(value: string): string {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && SAFE_STYLE_PROPERTY.test(part.split(':')[0]?.trim() ?? ''))
    .join('; ')
}

function cleanElement(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name)
      continue
    }
    if (name === 'style') {
      const safe = cleanStyle(attribute.value)
      if (safe) element.setAttribute('style', safe)
      else element.removeAttribute('style')
      continue
    }
    if ((name === 'src' || name === 'href' || name === 'xlink:href') && DANGEROUS_URL.test(attribute.value)) {
      element.removeAttribute(attribute.name)
    }
  }
}

/**
 * 把一段 HTML 消毒成可以安全插进界面的片段。
 *
 * 用 `DOMParser` 解析：解析出来的文档是惰性的，`<script>` 不会执行、`<img>` 不会加载，
 * 所以「先解析、再清理、最后才插入」这条路是安全的。
 */
export function sanitizeHTML(value: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html')
  const fragment = document.createDocumentFragment()

  const walk = (node: Node, parent: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as Element
      if (BLOCKED_TAGS.has(element.tagName.toLowerCase())) continue
      cleanElement(element)
      const clone = element.cloneNode(false)
      parent.appendChild(clone)
      walk(element, clone)
    }
  }

  walk(parsed.body, fragment)
  return fragment
}

/** 一个标签的消毒版本（行内 HTML：`<br>`、`<img>`、成对标签的开合各算一个）。 */
export function sanitizeTag(value: string): HTMLElement | null {
  const fragment = sanitizeHTML(value)
  const element = fragment.firstElementChild
  return element instanceof HTMLElement ? element : null
}
