// Copies the @ffmpeg/core ESM WASM build into public/ffmpeg so the app can
// load it from same-origin at runtime. ESM is required because @ffmpeg/ffmpeg
// spawns a module worker that does `import(coreURL)` (UMD has no default export).
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const dest = join(root, 'public', 'ffmpeg');

const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

if (!existsSync(src)) {
  console.warn(
    '[copy-ffmpeg-core] @ffmpeg/core ESM build not found in node_modules — skipping. ' +
      'Run `npm install` first, or MP3/FLAC/OGG export will not work.'
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

for (const file of files) {
  const from = join(src, file);
  const to = join(dest, file);
  if (!existsSync(from)) {
    console.warn(`[copy-ffmpeg-core] missing ${file} in @ffmpeg/core/dist/esm, skipping`);
    continue;
  }
  copyFileSync(from, to);
  console.log(`[copy-ffmpeg-core] copied ${file} -> public/ffmpeg/${file}`);
}
