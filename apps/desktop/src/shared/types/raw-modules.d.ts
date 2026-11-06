/**
 * Ambient declaration for Vite's `?raw` imports. The `@cloudforge/database`
 * package inlines its bootstrap SQL via `import sql from '...sql?raw'`; this
 * declaration lets the main-process program (which bundles that source) type it.
 */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

/** The documentation articles, bundled for the window and for MCP. */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
