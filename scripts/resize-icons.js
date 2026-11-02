'use strict';

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const extIcons = path.join(root, 'extension', 'icons');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(path.join(assets, 'icon512.png'));
  if (source.isEmpty()) {
    console.error('Could not load assets/icon512.png');
    app.exit(1);
    return;
  }
  fs.mkdirSync(extIcons, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBySize = new Map();
  for (const size of sizes) {
    const img = source.resize({ width: size, height: size, quality: 'best' });
    const png = img.toPNG();
    pngBySize.set(size, png);
    if ([16, 32, 48, 128].includes(size)) {
      fs.writeFileSync(path.join(extIcons, `icon${size}.png`), png);
    }
  }
  fs.writeFileSync(path.join(assets, 'icon.png'), pngBySize.get(256));
  fs.writeFileSync(path.join(assets, 'tray.png'), pngBySize.get(32));

  // ICO with PNG-compressed members (supported by Windows Vista and newer).
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  const entries = [];
  let offset = 6 + 16 * icoSizes.length;
  for (const size of icoSizes) {
    const png = pngBySize.get(size);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...entries, ...icoSizes.map((s) => pngBySize.get(s))]));
  console.log('Wrote icon.ico, icon.png, tray.png and extension icons.');
  app.exit(0);
});
