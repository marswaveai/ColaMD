// 验收脚本启动 Electron 时用这个壳，而不是直接 `electron .`。
//
// 为什么需要它：Chromium 的 `--window-position` 对 Electron 的 BrowserWindow 不生效，
// Electron 44 上实测被直接忽略，窗口照样出现在屏幕正中。测试窗口弹到人脸上就是抢
// 用户的注意力，所以在主进程里自己动手。窗口一建出来就做四件事：
//
//   - 透明度压到 0：macOS 不允许窗口完全离开屏幕，会把位置钳回边缘，光挪位置不够；
//   - 挪到屏幕外；
//   - 交出键盘焦点（否则跑测试的时候用户打不了字）；
//   - app.hide()：实测只有这一下能让前台 app 不被顶掉，菜单栏不会翻成 Electron。
//     别改成 app.dock.hide()，那个反而会让 Electron 抢到前台。
//
// 用法：electron scripts/offscreen-window.cjs <要打开的文件> <其它参数>
// 参数布局和 `electron . <文件>` 一致（主进程取的是 process.argv.slice(2)）。
const { app } = require('electron')
const { join } = require('path')
const { mkdirSync } = require('fs')

// user-data-dir 不隔离 app.getPath('home')；验收的最近文件与主题也必须独立。
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
if (profile) {
  const verificationHome = join(profile, 'isolated-home')
  mkdirSync(verificationHome, { recursive: true })
  app.setPath('home', verificationHome)
}

const FAR_AWAY = -100000

app.on('browser-window-created', (_event, win) => {
  try {
    win.setOpacity(0)
    win.setPosition(FAR_AWAY, FAR_AWAY)
    win.setFocusable(false)
    win.blur()
    if (process.platform === 'darwin') app.hide()
  } catch {
    // 窗口已经关了，不关我们的事
  }
})

require(join(__dirname, '..', 'dist', 'main', 'index.js'))
