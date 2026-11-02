'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch {
    try {
      await fsp.unlink(file);
    } catch {}
    await fsp.rename(tmp, file);
  }
}

function writeJsonSync(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

module.exports = { readJsonSync, writeJson, writeJsonSync };
