import { defineConfig } from 'vite';

// Change this to your repo name if using a project site: '/repo-name/'
export default defineConfig({
  base: '/',
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  // Prevent Vite from prebundling ffmpeg — that rewrites `new URL("./worker.js", …)`
  // to a broken `/@fs/.../deps/worker.js` URL (404 / empty MIME in Firefox).
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: {
    headers: {
      // Required for ffmpeg.wasm SharedArrayBuffer / cross-origin isolation.
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
