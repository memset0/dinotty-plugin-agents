// Build via esbuild's JS API (not the CLI shim) so it works identically under
// pnpm and in CI. Produces the full installable dist/: the UI bundle, the CLI
// bundle, and the static node launcher copied in beside them.
import { build } from 'esbuild'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

// CLI layer: src/cli.ts -> dist/cli (node program, run by bin/cli-wrapper)
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/cli',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
})

// UI layer: src/ui.ts -> dist/main.js (ESM module loaded in dinotty's webview)
await build({
  entryPoints: ['src/ui.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'dist/main.js',
})

// Static node launcher that plugin.json's bin.entry points at.
copyFileSync('bin/cli-wrapper', 'dist/cli-wrapper')
chmodSync('dist/cli', 0o755)
chmodSync('dist/cli-wrapper', 0o755)

console.log('built dist/: cli, main.js, cli-wrapper')
