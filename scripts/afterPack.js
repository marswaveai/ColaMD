const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function (context) {
  if (process.platform !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
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
