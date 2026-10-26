// Converts every extensions/*.js into plain-JS bookmarklets in bookmarklets/.
// Usage: node scripts/build-bookmarklets.mjs [--check]
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = 'extensions';
const OUT_DIR = 'bookmarklets';
const MANIFEST = 'manifest.json';
const PREFIX = 'javascript:';
const SIZE_WARN = 64 * 1024;
const REQUIRED = ['name', 'description'];
const checkOnly = process.argv.includes('--check');

function parseMetadata(source, file) {
  const header = source.match(/^\s*\/\*([\s\S]*?)\*\//);
  const meta = {};
  if (header) {
    for (const line of header[1].split(/\r?\n/)) {
      const m = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/);
      if (m) meta[m[1]] = m[2];
    }
  }
  const missing = REQUIRED.filter(k => !meta[k]);
  if (missing.length) throw new Error(`${file}: missing header metadata ${missing.map(k => '@' + k).join(', ')}`);
  return meta;
}

function toBookmarklet(minified) {
  const code = minified.trim().replace(/;$/, '');
  return PREFIX + 'void ' + code.replace(/[%#\r\n]/g, encodeURIComponent);
}

function validate(url, file) {
  const code = decodeURIComponent(url.slice(PREFIX.length));
  // Wrapping in return(...) fails if the code is more than one expression, which would defeat the `void`.
  new Function(`return (${code})`);
  if (/[^\x20-\x7e]/.test(url)) throw new Error(`${file}: bookmarklet contains non-ASCII or control characters`);
}

async function build() {
  const files = (await readdir(path.join(ROOT, SRC_DIR))).filter(f => f.endsWith('.js')).sort();
  const outputs = new Map();
  const manifest = [];

  for (const file of files) {
    const id = file.slice(0, -3);
    const source = await readFile(path.join(ROOT, SRC_DIR, file), 'utf8');
    const meta = parseMetadata(source, file);
    const result = await minify(source, {
      compress: true,
      mangle: true,
      format: { ascii_only: true, comments: false },
    });
    const url = toBookmarklet(result.code);
    try {
      validate(url, file);
    } catch (e) {
      throw new Error(`${file}: generated bookmarklet is invalid - ${e.message}`);
    }
    if (url.length > SIZE_WARN) console.warn(`warning: ${file} bookmarklet is ${url.length} chars, some browsers may truncate it`);

    const minPath = `${OUT_DIR}/${id}.min.js`;
    const urlPath = `${OUT_DIR}/${id}.bookmarklet.txt`;
    outputs.set(minPath, result.code + '\n');
    outputs.set(urlPath, url);
    manifest.push({
      id,
      name: meta.name,
      description: meta.description,
      page: meta.page || '',
      source: `${SRC_DIR}/${file}`,
      minified: minPath,
      bookmarklet: urlPath,
      size: url.length,
    });
    console.log(`${file} -> ${url.length} chars`);
  }

  outputs.set(`${OUT_DIR}/${MANIFEST}`, JSON.stringify({ extensions: manifest }, null, 2) + '\n');
  return outputs;
}

async function existingOutputs() {
  try {
    return (await readdir(path.join(ROOT, OUT_DIR))).map(f => `${OUT_DIR}/${f}`);
  } catch {
    return [];
  }
}

const outputs = await build();
const stale = (await existingOutputs()).filter(f => !outputs.has(f));

if (checkOnly) {
  const problems = [...stale.map(f => `stale: ${f}`)];
  for (const [rel, content] of outputs) {
    const current = await readFile(path.join(ROOT, rel), 'utf8').catch(() => null);
    if (current === null) problems.push(`missing: ${rel}`);
    else if (current.replace(/\r\n/g, '\n') !== content) problems.push(`outdated: ${rel}`);
  }
  if (problems.length) {
    console.error(problems.join('\n') + '\nRun `npm run build` to update bookmarklets/.');
    process.exit(1);
  }
  console.log('bookmarklets/ is up to date');
} else {
  await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
  for (const f of stale) await rm(path.join(ROOT, f));
  for (const [rel, content] of outputs) await writeFile(path.join(ROOT, rel), content);
  console.log(`wrote ${outputs.size} files to ${OUT_DIR}/`);
}
