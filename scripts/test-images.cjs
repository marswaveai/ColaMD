// Compile the filesystem layer in a temporary directory; exercise real files
// without starting Electron or touching the user's document/settings folders.
const ts = require('typescript')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'colamd-image-tests-'))
try {
  for (const name of ['image-storage', 'image-paths']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/main', name + '.ts'), 'utf8')
    const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
    fs.writeFileSync(path.join(output, name + '.js'), result.outputText)
  }
  const result = spawnSync(process.execPath, ['--test', path.join(__dirname, '../tests/image-storage.test.cjs')], {
    stdio: 'inherit', env: { ...process.env, COLAMD_IMAGE_TEST_BUILD: output }
  })
  process.exitCode = result.status ?? 1
} finally { fs.rmSync(output, { recursive: true, force: true }) }
