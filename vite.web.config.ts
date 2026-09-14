import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// The web playground: the same editor core and the same theme CSS as the desktop
// app, built as a plain static page. The editor core does not talk to Electron
// (only four optional calls live in it, all guarded), so this target needs no
// shim and no fork of the renderer. See docs/web-playground.md.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/web/index.html') }
    }
  }
})
