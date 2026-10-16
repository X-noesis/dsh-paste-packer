// Extract selected files out of a DSH app.asar by path substring.
// Usage: node extract-asar.mjs <asarPath> <matchSubstring> <destDir>
import fs from 'node:fs';
import path from 'node:path';

const [asarPath, match, destDir] = process.argv.slice(2);
if (!asarPath || !match || !destDir) {
  console.error('usage: node extract-asar.mjs <asarPath> <matchSubstring> <destDir>');
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const root = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = 8 + headerSize;

/** @type {{rel: string, size: number, offset: number}[]} */
const hits = [];

function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      walk(child, rel);
    } else if (child.size !== undefined && rel.includes(match)) {
      hits.push({ rel, size: child.size, offset: Number(child.offset) });
    }
  }
}
walk(root, '');

if (hits.length === 0) {
  console.error(`no entries matched ${JSON.stringify(match)}`);
  process.exit(1);
}

// Paths are emitted relative to the matched directory, so destDir becomes it.
const outBase = path.resolve(destDir);
const firstIdx = hits[0].rel.indexOf(match);
const stripPrefix = hits[0].rel.slice(0, firstIdx + match.length + 1);

let written = 0;
for (const hit of hits) {
  const relInside = hit.rel.slice(stripPrefix.length);
  const target = path.join(outBase, relInside);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buf = Buffer.alloc(hit.size);
  if (hit.size > 0) fs.readSync(fd, buf, 0, hit.size, dataStart + hit.offset);
  fs.writeFileSync(target, buf);
  written += 1;
}
fs.closeSync(fd);
console.log(`extracted ${written} file(s) into ${outBase}`);
for (const hit of hits) console.log(`  ${hit.size.toString().padStart(8)}  ${hit.rel}`);
