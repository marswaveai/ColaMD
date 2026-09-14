import { visit } from 'unist-util-visit'

// remark-math treats any two `$` signs on a line as inline LaTeX, so prices
// like "价格 $5，成本 $6" or "$5.00 | $6.00" in a table row render as broken
// formulas. Obsidian applies the same guard: spans that look like currency or
// plain prose fall back to literal text; real LaTeX keeps rendering.
function looksLikeLatex(value: string): boolean {
  // LaTeX commands and structures: \frac, ^, _, {a}
  if (/[\\^_{}]/.test(value)) return true
  // Bare symbols: $x$, $xy$
  if (/^[a-zA-Z\s]+$/.test(value)) return true
  // Algebra: letters combined with operators, e.g. a+b, y=2x
  if (/[a-zA-Z]/.test(value) && /[=+\-*/<>]/.test(value)) return true
  return false
}

export function remarkMathFalsePositiveGuard(): (tree: unknown) => void {
  return (tree: unknown) => {
    visit(tree as never, 'inlineMath', (node: { value?: unknown }, index: number | null, parent: { children: unknown[] } | null | undefined) => {
      if (index === null || index === undefined || !parent) return
      const value = String(node.value ?? '')
      if (looksLikeLatex(value)) return
      parent.children[index] = { type: 'text', value: `$${value}$` }
    })
  }
}
