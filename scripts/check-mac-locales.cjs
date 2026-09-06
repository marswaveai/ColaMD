// Run against the final .app, not the source Electron distribution.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = process.argv[2]
assert.ok(app, 'Usage: node scripts/check-mac-locales.cjs /path/to/ColaMD.app')
const resources = path.join(app, 'Contents', 'Resources')
const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
const locales = fs.readdirSync(framework).filter((name) => name.endsWith('.lproj'))
assert.ok(locales.includes('en.lproj'), 'English runtime resources are missing')
assert.ok(locales.includes('zh_CN.lproj'), 'Chinese runtime resources are missing')
for (const locale of locales) {
  assert.ok(fs.existsSync(path.join(resources, locale)), `Missing app language marker: ${locale}`)
  assert.ok(fs.statSync(path.join(resources, locale)).isDirectory(), `Not a language directory: ${locale}`)
}
console.log(`macOS language markers verified: ${locales.length} locales, including Chinese and English`)
