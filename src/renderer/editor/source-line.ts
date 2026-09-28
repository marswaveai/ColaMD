/** Select a one-based source line, including in a textarea with wrapped lines. */
export function jumpToSourceLine(source: HTMLTextAreaElement, line: number): void {
  const lines = source.value.split('\n')
  const index = Math.max(0, Math.min(line - 1, lines.length - 1))
  const prefix = lines.slice(0, index).join('\n') + (index ? '\n' : '')
  source.focus({ preventScroll: true })
  source.setSelectionRange(prefix.length, prefix.length + lines[index].length)

  // Logical line * line-height is wrong after long lines wrap. Measure using
  // the textarea's font, padding and content width without changing its value.
  const style = getComputedStyle(source)
  const mirror = document.createElement('div')
  for (const key of ['font', 'letter-spacing', 'line-height', 'padding', 'tab-size', 'word-break']) {
    mirror.style.setProperty(key, style.getPropertyValue(key))
  }
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    left: '0', top: '0', width: `${source.clientWidth}px`,
    boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
  })
  mirror.textContent = prefix
  const marker = document.createElement('span')
  marker.textContent = lines[index] || '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  try {
    source.scrollTop = Math.max(0, marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top - source.clientHeight / 3)
  } finally {
    mirror.remove()
  }
}
