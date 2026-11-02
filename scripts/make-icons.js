'use strict';

/**
 * Renders assets/logo.svg to PNGs with headless Chrome and packs a Windows .ico.
 * Usage: node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const extIcons = path.join(root, 'extension', 'icons');

const chromeCandidates = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = chromeCandidates.find((p) => p && fs.existsSync(p));
if (!chrome) {
  console.error('Chrome or Edge was not found. Render assets/logo.svg manually.');
  process.exit(1);
}

const svg = fs.readFileSync(path.join(assets, 'logo.svg'), 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}
svg{display:block;width:512px;height:512px}
</style></head><body>${svg}</body></html>`;
const htmlPath = path.join(assets, '.render.html');
fs.writeFileSync(htmlPath, html, 'utf8');

const out512 = path.join(assets, 'icon512.png');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smiley-icon-'));
try {
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--window-size=512,512',
      `--screenshot=${out512}`,
      'file:///' + htmlPath.replace(/\\/g, '/'),
    ],
    { stdio: 'pipe', timeout: 120000 }
  );
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(htmlPath, { force: true });
}

if (!fs.existsSync(out512)) {
  console.error('Screenshot failed; no icon was produced.');
  process.exit(1);
}

// Resize using Electron's nativeImage so the ico gets crisp PNG members.
const electron = process.platform === 'win32' ? path.join(root, 'node_modules', '.bin', 'electron.cmd') : path.join(root, 'node_modules', '.bin', 'electron');
const resizeScript = path.join(root, 'scripts', 'resize-icons.js');
execFileSync(electron, [resizeScript], { stdio: 'inherit', cwd: root, timeout: 180000, shell: process.platform === 'win32' });
console.log('Icons generated.');
