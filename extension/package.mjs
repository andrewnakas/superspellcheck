// Zips dist/<browser> into store-ready archives in dist/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.dirname(new URL(import.meta.url).pathname);
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const target of ['chrome', 'firefox']) {
  const dir = path.join(root, 'dist', target);
  const out = path.join(root, 'dist', `superspellcheck-${target}-${version}.zip`);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: dir });
  console.log(`${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}
