import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: thumbgrove:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

// The dev server needs inline scripts for hot reload, so the policy is only added to builds.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'thumbgrove-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: 'src/main/index.ts', worker: 'src/main/library/worker.ts', tagger: 'src/main/recognition/tagger.ts' } } }
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), contentSecurityPolicy()],
    // Absolute, because the dev server would otherwise look for this path inside the renderer root.
    build: { rollupOptions: { input: fileURLToPath(new URL('src/renderer/index.html', import.meta.url)) } }
  }
})
