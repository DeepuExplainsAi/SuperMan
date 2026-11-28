import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { materializeExternalAliases } from './standalone-links.mjs';
await mkdir('public/brand', { recursive: true });
const png = await sharp('public/brand/logo-mark.svg').resize(512, 512).png().toBuffer();
await writeFile('public/brand/icon.png', png);
const icoPng = await sharp(png).resize(256, 256).png().toBuffer();
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(icoPng.length, 14); ico.writeUInt32LE(22, 18);
await writeFile('public/brand/icon.ico', Buffer.concat([ico, icoPng]));
const entry = Buffer.alloc(8); entry.write('ic09'); entry.writeUInt32BE(png.length + 8, 4);
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(png.length + 16, 4);
await writeFile('public/brand/icon.icns', Buffer.concat([header, entry, png]));
await cp('public', '.next/standalone/public', { recursive: true });
await cp('.next/static', '.next/standalone/.next/static', { recursive: true });
await cp('supabase/migrations', '.next/standalone/supabase/migrations', { recursive: true });
// Ensure the WASM payload is included even if tracing changes between Next versions.
await cp('node_modules/@electric-sql/pglite', '.next/standalone/node_modules/@electric-sql/pglite', { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
console.log(`Prepared standalone server for ${pkg.name} ${pkg.version}`);

// node-pty is loaded dynamically, so Next's dependency tracer cannot discover it.
await cp('node_modules/node-pty', '.next/standalone/node_modules/node-pty', { recursive: true });
// Both macOS prebuilds are N-API compatible and must remain available in the universal bundle.

// Playwright dynamically reads browsers.json and bundled helpers even with a system browser.
await cp("node_modules/playwright-core", ".next/standalone/node_modules/playwright-core", { recursive: true });
await materializeExternalAliases('.next/standalone');

// The Electron main process uses only built-ins; server dependencies belong in extraResources, not app.asar.
// A separate app manifest keeps builder dependency collection away from the Next development tree.
await mkdir('build/desktop', { recursive: true });
await cp('build/electron', 'build/desktop/build/electron', { recursive: true });
const desktopPkg = { ...pkg };
delete desktopPkg.dependencies;
delete desktopPkg.optionalDependencies;
delete desktopPkg.devDependencies;
await writeFile('build/desktop/package.json', JSON.stringify(desktopPkg, null, 2) + '\n');
