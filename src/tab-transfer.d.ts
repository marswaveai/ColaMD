export interface DetachedTab {
  filePath: string | null
  content: string
  dirty: boolean
  sourceMode: boolean
  sourceText: string
  diskContent: string | null
  scrollTop: number
  selection: { anchor: number; head: number }
}
