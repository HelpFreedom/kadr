// `import text from './file?raw'` — vite bundles the file's text (used for the
// files Kadr writes into the fragment workspace, electron/fragment-kit/).
declare module '*?raw' {
  const text: string
  export default text
}
