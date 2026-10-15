/// <reference types="vitest" />

import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'

const require = createRequire(import.meta.url)
// Forward slashes: resolve() yields backslashes on Windows, and
// vite-plugin-static-copy's glob engine treats those as escapes and matches
// nothing ("No file was found to copy"). No-op on POSIX.
const materialIconsDir = resolve(
  dirname(dirname(require.resolve('vscode-material-icons'))),
  'generated/icons/*'
).replace(/\\/g, '/')

function isDeferredStartupDependency(dep: string) {
  return /(?:^|\/)(MonacoFileEditor|monaco|editor\.worker|json\.worker|css\.worker|html\.worker|ts\.worker)-/.test(dep)
}

export default defineConfig({
  // Relative paths so Electron's file:// protocol finds assets
  // next to index.html instead of at the filesystem root.
  base: './',
  plugins: [
    react(),
    // Serve the VSCode Material Icon SVGs from node_modules at
    // /material-icons/*.svg in both dev and build output.
    viteStaticCopy({
      targets: [
        {
          src: materialIconsDir,
          dest: 'material-icons',
        },
      ],
    }),
    // Installable PWA shell for the remote web client. Only the static
    // bundle gets cached — agent state is always online.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.png',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-192.png',
        'icon-maskable-512.png',
      ],
      manifest: {
        name: 'ACE CODER',
        short_name: 'ACE CODER',
        description: 'Remote agent terminal for ACE CODER',
        // Ember Spade brand: graphite ground behind the ember mark.
        theme_color: '#17181C',
        background_color: '#17181C',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Maskable variants keep the mark inside the Android safe zone on a
          // full-bleed graphite tile.
          { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        // Keep the remote PWA install/update path to the shell and static
        // media. Lazy editor/highlighter chunks and workers stay network
        // loaded; agent state is online-only anyway.
        globPatterns: [
          'index.html',
          'registerSW.js',
          'manifest.webmanifest',
          'favicon.png',
          'apple-touch-icon.png',
          'icon-*.png',
          'icons.svg',
          'logo/*.png',
          'assets/index-*.js',
          'assets/index-*.css',
          'assets/react-core-*.js',
          'assets/radix-*.js',
          'assets/motion-*.js',
          'assets/xterm-*.js',
          // xterm's stylesheet is deliberately NOT bucketed into the xterm
          // chunk (see manualChunks below), so it lands in the terminal
          // component's own stylesheet, not an `xterm-*.css` asset. Precaching
          // a glob that matches nothing is a hard build error in workbox.
          'assets/TerminalFeed-*.css',
          'assets/*.png',
          'assets/*.woff',
          'assets/*.woff2',
          'assets/*.ttf',
        ],
        globIgnores: [
          'material-icons/**/*',
          'assets/MonacoFileEditor-*',
          'assets/*.worker-*.js',
        ],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // Agent state (every /api and /ws call) must bypass the service
        // worker so the client never serves stale data from the shell cache.
        // /hermes-desktop is the server-side proxy to the Hermes sidecar; if
        // the SW answers that iframe navigation with the cached Ace
        // index.html, Ace embeds itself recursively (stacked Teams
        // headers/navs on mobile).
        navigateFallbackDenylist: [/^\/api/, /^\/enroll/, /^\/ws/, /^\/hermes-desktop/],
      },
    }),
  ],
  build: {
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !isDeferredStartupDependency(dep))
      },
    },
    // esbuild's minifier mangles xterm's `let r; ...(r ||= {})` enum pattern
    // into `var p; ...(void 0 || (t = {}))` — `t` is undeclared, so the very
    // first DECRQM sequence from a PTY throws in the packaged app. Terser
    // handles `||=` correctly.
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('react') || id.includes('scheduler')) return 'react-core'
          if (id.includes('framer-motion')) return 'motion'
          if (id.includes('@radix-ui')) return 'radix'
          if (id.includes('lucide-react')) return 'icons'
          // Only the xterm JS goes in the xterm chunk. Bucketing xterm's CSS
          // here too makes the eager `import '@xterm/xterm/css/xterm.css'` in
          // main.tsx a static dependency of that chunk, which drags the whole
          // ~580KB terminal engine into the boot bundle even though no terminal
          // renders at startup. Leaving the CSS as a normal asset keeps only
          // the (tiny) stylesheet eager; the JS loads lazily with the terminal.
          if (id.includes('@xterm') && !id.endsWith('.css')) return 'xterm'
        },
      },
    },
  },
  server: {
    watch: {
      ignored: ['**/references/**', '**/.ace/worktrees/**'],
    },
  },
  test: {
    // .claude/worktrees holds stale per-agent workflow checkouts — without the
    // exclude, vitest's positional path FILTERS match those copies too and
    // local `npm test` fails on code that isn't this checkout's.
    exclude: ['**/node_modules/**', '**/dist/**', '**/release/**', '**/.git/**', '**/.ace/**', '**/.claude/**'],
  },
  optimizeDeps: {
    exclude: [],
    entries: ['src/main.tsx'],
  },
})
