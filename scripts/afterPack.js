const { execFileSync } = require('child_process')
const { mkdir, readdir } = require('fs/promises')
const path = require('path')

exports.default = async function (context) {
  if (process.platform !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // electron-builder's local electronDist copy can omit Electron's empty
  // top-level .lproj directories. macOS uses these to choose the app language;
  // without them Chinese systems fall back to English even though the framework
  // still contains Chinese resources. Restore only the locales actually shipped.
  const resources = path.join(appPath, 'Contents', 'Resources')
  const frameworkResources = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
  const locales = (await readdir(frameworkResources, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.lproj'))
  await Promise.all(locales.map((entry) => mkdir(path.join(resources, entry.name), { recursive: true })))

  console.log(`Cleaning extended attributes and resource forks from ${appPath}`)
  // Remove extended attributes
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' })
  // Remove HFS+ resource forks that xattr -cr doesn't handle
  execFileSync(
    'find',
    [appPath, '-type', 'f', '-exec', 'sh', '-c', 'cat /dev/null > "$1/..namedfork/rsrc" 2>/dev/null; true', '_', '{}', ';'],
    { stdio: 'inherit' }
  )
}
