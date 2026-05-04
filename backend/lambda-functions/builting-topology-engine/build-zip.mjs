// build-zip.mjs — Pure Node.js ZIP creator (no subprocess, no external deps)
// Creates a valid ZIP file using zlib deflate + manual ZIP format construction

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = __dirname;
const outPath = path.join(dir, 'builting-topology-engine.zip');

// Remove existing zip
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

// CRC-32 table
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt32LE(buf, val, offset) {
  buf[offset] = val & 0xff;
  buf[offset+1] = (val >>> 8) & 0xff;
  buf[offset+2] = (val >>> 16) & 0xff;
  buf[offset+3] = (val >>> 24) & 0xff;
}
function writeUInt16LE(buf, val, offset) {
  buf[offset] = val & 0xff;
  buf[offset+1] = (val >>> 8) & 0xff;
}

function collectFiles(baseDir, relDir = '') {
  const results = [];
  for (const entry of fs.readdirSync(path.join(baseDir, relDir) || baseDir)) {
    const rel = relDir ? `${relDir}/${entry}` : entry;
    const abs = path.join(baseDir, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist' && entry !== '.DS_Store') {
        results.push(...collectFiles(baseDir, rel));
      }
    } else if (!entry.endsWith('.zip') && entry !== '.DS_Store' &&
               entry !== 'build-zip.mjs' && entry !== 'build-zip.js') {
      results.push(rel);
    }
  }
  return results;
}

const files = collectFiles(dir);
console.log('Files to include:', files);

const parts = [];       // raw bytes to write
const centralDir = [];  // central directory entries
let offset = 0;

for (const name of files) {
  const data = fs.readFileSync(path.join(dir, name));
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBytes = Buffer.from(name, 'utf8');

  // Local file header
  const lhSize = 30 + nameBytes.length;
  const lh = Buffer.alloc(lhSize);
  writeUInt32LE(lh, 0x04034b50, 0);  // signature
  writeUInt16LE(lh, 20, 4);           // version needed
  writeUInt16LE(lh, 0, 6);            // flags
  writeUInt16LE(lh, 8, 8);            // deflate compression
  writeUInt16LE(lh, 0, 10);           // mod time
  writeUInt16LE(lh, 0, 12);           // mod date
  writeUInt32LE(lh, crc, 14);
  writeUInt32LE(lh, compressed.length, 18);
  writeUInt32LE(lh, data.length, 22);
  writeUInt16LE(lh, nameBytes.length, 26);
  writeUInt16LE(lh, 0, 28);           // extra length
  nameBytes.copy(lh, 30);

  parts.push(lh, compressed);

  // Central directory entry
  const cdSize = 46 + nameBytes.length;
  const cd = Buffer.alloc(cdSize);
  writeUInt32LE(cd, 0x02014b50, 0);  // signature
  writeUInt16LE(cd, 20, 4);           // version made by
  writeUInt16LE(cd, 20, 6);           // version needed
  writeUInt16LE(cd, 0, 8);            // flags
  writeUInt16LE(cd, 8, 10);           // deflate
  writeUInt16LE(cd, 0, 12);           // mod time
  writeUInt16LE(cd, 0, 14);           // mod date
  writeUInt32LE(cd, crc, 16);
  writeUInt32LE(cd, compressed.length, 20);
  writeUInt32LE(cd, data.length, 24);
  writeUInt16LE(cd, nameBytes.length, 28);
  writeUInt16LE(cd, 0, 30);           // extra
  writeUInt16LE(cd, 0, 32);           // comment
  writeUInt16LE(cd, 0, 34);           // disk start
  writeUInt16LE(cd, 0, 36);           // int attrs
  writeUInt32LE(cd, 0, 38);           // ext attrs
  writeUInt32LE(cd, offset, 42);      // local header offset
  nameBytes.copy(cd, 46);
  centralDir.push(cd);

  offset += lhSize + compressed.length;
  console.log(`  added: ${name} (${data.length} -> ${compressed.length} bytes)`);
}

// Write central directory
const cdStart = offset;
let cdLen = 0;
for (const cd of centralDir) { parts.push(cd); cdLen += cd.length; }

// End of central directory record
const eocd = Buffer.alloc(22);
writeUInt32LE(eocd, 0x06054b50, 0);  // signature
writeUInt16LE(eocd, 0, 4);            // disk num
writeUInt16LE(eocd, 0, 6);            // disk with cd
writeUInt16LE(eocd, files.length, 8);
writeUInt16LE(eocd, files.length, 10);
writeUInt32LE(eocd, cdLen, 12);
writeUInt32LE(eocd, cdStart, 16);
writeUInt16LE(eocd, 0, 20);           // comment length
parts.push(eocd);

fs.writeFileSync(outPath, Buffer.concat(parts));
const size = fs.statSync(outPath).size;
console.log(`\nDone! ${outPath}`);
console.log(`Size: ${(size/1024).toFixed(1)} KB`);
