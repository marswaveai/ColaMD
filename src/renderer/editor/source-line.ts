const MIRROR_STYLES = [
  'font', 'letter-spacing', 'word-spacing', 'line-height', 'padding', 'tab-size',
  'word-break', 'overflow-wrap', 'white-space', 'direction', 'text-align', 'text-indent', 'text-transform',
] as const

function createMirror(source: HTMLTextAreaElement): HTMLDivElement {
  const style = getComputedStyle(source)
  const mirror = document.createElement('div')
  for (const key of MIRROR_STYLES) {
    mirror.style.setProperty(key, style.getPropertyValue(key))
  }
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    left: '0', top: '0', width: `${source.clientWidth}px`,
    boxSizing: 'border-box',
  })
  return mirror
}

/** The caret's top within the textarea's scrollable content, including wrapping. */
export function sourcePositionTop(source: HTMLTextAreaElement, position: number): number {
  const offset = Math.max(0, Math.min(position, source.value.length))
  const mirror = createMirror(source)
  mirror.textContent = source.value.slice(0, offset)
  const marker = document.createElement('span')
  const end = source.value.indexOf('\n', offset)
  // Retain the rest of this logical line so word wrapping at the caret is
  // identical, and measure its first fragment rather than the whole span.
  marker.textContent = source.value.slice(offset, end < 0 ? undefined : end) || '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  try {
    const rect = marker.getClientRects()[0] ?? marker.getBoundingClientRect()
    return rect.top - mirror.getBoundingClientRect().top
  } finally {
    mirror.remove()
  }
}

/** Measure exact tops for multiple zero-based logical lines in a single mirror pass. */
export function sourceLineTops(source: HTMLTextAreaElement, zeroBasedLines: number[]): number[] {
  if (zeroBasedLines.length === 0) return []
  const text = source.value
  // 按升序一次性切出所有目标行的字符偏移，单次 layout 测完，避免滚动时重复建 mirror。
  const wanted = new Map<number, number[]>()
  zeroBasedLines.forEach((line, idx) => {
    const bucket = wanted.get(line)
    if (bucket) bucket.push(idx)
    else wanted.set(line, [idx])
  })
  const sortedLines = [...wanted.keys()].sort((a, b) => a - b)
  const mirror = createMirror(source)
  const markers: { line: number; el: HTMLSpanElement }[] = []

  let cursor = 0
  let currentLine = 0
  let targetPtr = 0
  let lastEmitted = 0

  while (targetPtr < sortedLines.length) {
    const want = sortedLines[targetPtr]
    while (currentLine < want && cursor < text.length) {
      const nl = text.indexOf('\n', cursor)
      if (nl < 0) {
        cursor = text.length
        break
      }
      cursor = nl + 1
      currentLine += 1
    }
    const lineStart = cursor
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl < 0 ? text.length : nl
    if (lineStart > lastEmitted) {
      mirror.appendChild(document.createTextNode(text.slice(lastEmitted, lineStart)))
    }
    const marker = document.createElement('span')
    marker.textContent = text.slice(lineStart, lineEnd) || '\u200b'
    mirror.appendChild(marker)
    markers.push({ line: want, el: marker })
    lastEmitted = lineEnd
    targetPtr += 1
  }

  document.body.appendChild(mirror)
  try {
    const baseTop = mirror.getBoundingClientRect().top
    const out = new Array<number>(zeroBasedLines.length).fill(0)
    for (const { line, el } of markers) {
      const rect = el.getClientRects()[0] ?? el.getBoundingClientRect()
      const top = rect.top - baseTop
      for (const idx of wanted.get(line) ?? []) out[idx] = top
    }
    return out
  } finally {
    mirror.remove()
  }
}

/** Select a one-based source line, including in a textarea with wrapped lines. */
export function jumpToSourceLine(source: HTMLTextAreaElement, line: number): void {
  const lines = source.value.split('\n')
  const index = Math.max(0, Math.min(line - 1, lines.length - 1))
  const prefix = lines.slice(0, index).join('\n') + (index ? '\n' : '')
  const rawLen = lines[index].endsWith('\r') ? lines[index].length - 1 : lines[index].length
  source.focus({ preventScroll: true })
  source.setSelectionRange(prefix.length, prefix.length + rawLen)
  source.scrollTop = Math.max(0, sourcePositionTop(source, prefix.length) - source.clientHeight / 3)
}
