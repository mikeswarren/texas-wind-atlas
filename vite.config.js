import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig } from 'vite'

function git(...args) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // Tarball export, or no git on PATH. A stamp is worth having, not worth
    // failing a build over.
    return ''
  }
}

// A built bundle is otherwise anonymous. A stale dist/ on a laptop and the live
// site differ only by a content hash that maps back to no commit, so telling
// them apart meant diffing filenames and guessing. Every build now drops a
// build.json naming the commit it came from, which makes "what is actually
// deployed" one `curl https://map.hitky.com/build.json`.
function buildStamp() {
  return {
    name: 'build-stamp',
    apply: 'build',
    writeBundle(options) {
      const commit = git('rev-parse', 'HEAD')
      const stamp = {
        commit: commit || 'unknown',
        short: commit ? commit.slice(0, 8) : 'unknown',
        subject: git('log', '-1', '--format=%s'),
        // A dirty tree produces a bundle that matches no commit at all. Say so,
        // rather than name the commit it merely resembles.
        dirty: git('status', '--porcelain') !== '',
        built: new Date().toISOString(),
      }
      writeFileSync(resolve(options.dir, 'build.json'), JSON.stringify(stamp, null, 2) + '\n')
    },
  }
}

export default defineConfig({
  plugins: [buildStamp()],
  // Served from the domain root at map.hitky.com.
  base: '/',
  build: {
    outDir: 'dist',
    // The turbine GeoJSON must stay a fetchable file, never inlined into JS.
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // mapbox-gl is ~90% of the bundle and changes only when the dependency
        // does. Splitting it means app edits don't re-download 530 KB.
        manualChunks: { mapbox: ['mapbox-gl'] },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
  },
})
