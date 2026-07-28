import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * @ffmpeg/ffmpeg's worker is imported via `?url`, so Vite emits it as a raw
 * asset into dist/assets/worker-XXXX.js. That file still does:
 *   import … from "./const.js"
 *   import … from "./errors.js"
 * which Vite never resolves. Copy the two siblings next to every emitted
 * worker so the relative imports succeed at runtime.
 */
function copyFfmpegWorkerSiblings(): Plugin {
  return {
    name: 'copy-ffmpeg-worker-siblings',
    closeBundle() {
      // worker is an exported subpath; package.json is not.
      const workerPath = require.resolve('@ffmpeg/ffmpeg/worker');
      const esmDir = dirname(workerPath); // …/dist/esm
      const outDir = join(dirname(fileURLToPath(import.meta.url)), 'dist', 'assets');

      if (!existsSync(outDir)) return;
      mkdirSync(outDir, { recursive: true });

      for (const file of ['const.js', 'errors.js']) {
        const from = join(esmDir, file);
        const to = join(outDir, file);
        if (!existsSync(from)) {
          console.warn(`[copy-ffmpeg-worker-siblings] missing ${from}`);
          continue;
        }
        copyFileSync(from, to);
        console.log(`[copy-ffmpeg-worker-siblings] copied ${file} → dist/assets/${file}`);
      }
    },
  };
}

export default defineConfig({
  base: '/',
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  plugins: [copyFfmpegWorkerSiblings()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});