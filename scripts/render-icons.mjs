/**
 * Rasterise logo.svg into the extension's icon set — Chrome's `icons` manifest
 * key rejects SVG. WXT picks up `public/icon/<size>.png` automatically.
 *
 * Run with `pnpm icons` after editing logo.svg.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'logo.svg');
const OUT_DIR = path.join(ROOT, 'public', 'icon');
const SIZES = [16, 32, 48, 96, 128];

/**
 * Rasterise far above the largest icon and downsample: a resize kernel
 * antialiases better than a rasteriser pointed straight at 16px. logo.svg is
 * 500×500 at the default 72dpi, so this renders it at 4000×4000.
 */
const RENDER_DENSITY = 72 * 8;

const svg = await readFile(SOURCE);
await mkdir(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const file = path.join(OUT_DIR, `${size}.png`);
  await sharp(svg, { density: RENDER_DENSITY })
    .resize(size, size, { kernel: 'lanczos3', fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(file);
  console.log(`wrote ${path.relative(ROOT, file)} (${size}×${size})`);
}
