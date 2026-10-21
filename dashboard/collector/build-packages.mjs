#!/usr/bin/env node
// Explicit input allowlist: no credentials, local files, tests or binaries enter archives.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('Usage: node build-packages.mjs OUTPUT_DIR');
const files = [
  'README.md', 'install.py', 'launch-codex.py', 'release.json',
  'generated/local.yaml', 'generated/configure-client-telemetry.py',
  'vendor/tomli/__init__.py', 'vendor/tomli/_parser.py', 'vendor/tomli/_re.py',
  'vendor/tomli/_types.py', 'vendor/tomli/LICENSE', 'vendor/README.md',
];
function entry(name, bytes) {
  const header = Buffer.alloc(512);
  const string = (value, start, length) => header.write(value, start, length, 'utf8');
  const octal = (value, start, length) => string(value.toString(8).padStart(length - 1, '0') + '\0', start, length);
  string('ccdash-collector/' + name, 0, 100);
  octal(name.endsWith('.py') ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
  string('        ', 148, 8); string('0', 156, 1); string('ustar\0', 257, 6); string('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  string(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
const entries = await Promise.all(files.sort().map(async name => entry(name, await readFile(resolve(root, name)))));
await mkdir(output, { recursive: true });
const manifest = { collectorVersion: JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8')).version, packages: {} };
for (const platform of ['linux', 'darwin']) {
  const archive = gzipSync(Buffer.concat([...entries, entry('platform', Buffer.from(platform + '\n')), Buffer.alloc(1024)]), { level: 9 });
  await writeFile(resolve(output, `ccdash-collector-${platform}.tar.gz`), archive);
  manifest.packages[`ccdash-collector-${platform}.tar.gz`] = createHash('sha256').update(archive).digest('hex');
}
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
