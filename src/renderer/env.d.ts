declare module 'katex/dist/katex.min.css?inline' {
  const css: string
  export default css
}

interface Window {
  electronAPI: import('../preload/index').ElectronAPI
  /** 主进程在 printToPDF 前后叫它，把光标与当前行的源码从纸上拿掉。 */
  __colamdPrintExport?: { enter: () => void; exit: () => void }
  __colamdExportDocumentHTML?: () => string
}
