/** The caret's top within the textarea's scrollable content, including wrapping. */
export function sourcePositionTop(source: HTMLTextAreaElement, position: number): number {
  const offset = Math.max(0, Math.min(position, source.value.length))
  const style = getComputedStyle(source)
  const mirror = document.createElement('div')
  for (const key of ['font', 'letter-spacing', 'word-spacing', 'line-height', 'padding', 'tab-size', 'word-break', 'overflow-wrap', 'white-space', 'direction', 'text-align', 'text-indent', 'text-transform']) {
    mirror.style.setProperty(key, style.getPropertyValue(key))
  }
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    left: '0', top: '0', width: `${source.clientWidth}px`,
    boxSizing: 'border-box',
  })
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

/** Select a one-based source line, including in a textarea with wrapped lines. */
export function jumpToSourceLine(source: HTMLTextAreaElement, line: number): void {
  const lines = source.value.split('\n')
  const index = Math.max(0, Math.min(line - 1, lines.length - 1))
  const prefix = lines.slice(0, index).join('\n') + (index ? '\n' : '')
  source.focus({ preventScroll: true })
  source.setSelectionRange(prefix.length, prefix.length + lines[index].length)
  source.scrollTop = Math.max(0, sourcePositionTop(source, prefix.length) - source.clientHeight / 3)
}
