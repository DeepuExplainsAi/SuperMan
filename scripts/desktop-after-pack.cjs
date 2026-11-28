/* eslint @typescript-eslint/no-require-imports: "off" -- electron-builder loads this CommonJS hook. */
const { cp, rm } = require('node:fs/promises');
const { basename, join } = require('node:path');
const { Arch } = require('builder-util');

// The server is already architecture-aware (both Mac prebuilds are staged). Copy it once after the
// Electron universal merge instead of spawning `file` for every server file in both temporary apps.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  if (context.arch === Arch.universal) {
    await cp(join(context.packager.projectDir, '.next', 'standalone'), join(resources, 'server'), { recursive: true, dereference: true });
    await cp(join(context.packager.projectDir, 'public'), join(resources, 'public'), { recursive: true });
  } else if (/-universal-(?:x64|arm64)-temp$/.test(basename(context.appOutDir))) {
    await rm(join(resources, 'server'), { recursive: true, force: true });
    await rm(join(resources, 'public'), { recursive: true, force: true });
  }
};
