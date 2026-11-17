// Builds dist/chrome and dist/firefox (Safari is generated from the Chrome build
// with `xcrun safari-web-extension-converter dist/chrome`).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.dirname(new URL(import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

const base = {
  manifest_version: 3,
  name: 'SuperSpellCheck',
  version: pkg.version,
  description: 'Private, context-aware spelling and grammar checking that runs on your device.',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_popup: 'popup.html', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  options_ui: { page: 'options.html', open_in_tab: true },
  permissions: ['storage', 'activeTab'],
  // AI deep check is opt-in; the host permission is requested when the user turns it on.
  optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: true, match_about_blank: true }],
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
};

const targets = {
  chrome: { ...base, background: { service_worker: 'background.js', type: 'module' }, minimum_chrome_version: '116' },
  firefox: {
    ...base,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'superspellcheck@superspellcheck.app', strict_min_version: '128.0' } },
  },
};

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

async function build() {
  for (const [name, manifest] of Object.entries(targets)) {
    const out = path.join(root, 'dist', name);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    await esbuild.build({
      entryPoints: { background: 'src/background.ts' },
      bundle: true, format: 'esm', target: 'es2022', outdir: out, minify: !watch, sourcemap: watch ? 'inline' : false,
    });
    await esbuild.build({
      entryPoints: { content: 'src/content.ts', options: 'src/options.ts', popup: 'src/popup.ts' },
      bundle: true, format: 'iife', target: 'es2022', outdir: out, minify: !watch, sourcemap: watch ? 'inline' : false,
    });
    for (const f of fs.readdirSync(path.join(root, 'static'))) copy(path.join(root, 'static', f), path.join(out, f));
    for (const f of fs.readdirSync(path.join(root, 'icons'))) copy(path.join(root, 'icons', f), path.join(out, 'icons', f));
    copy(path.join(root, 'pkg', 'ssc_engine_bg.wasm'), path.join(out, 'ssc_engine_bg.wasm'));
    fs.mkdirSync(path.join(out, 'data'), { recursive: true });
    for (const f of ['lexicon.txt', 'unigrams.txt', 'bigrams.txt', 'lexicon_variants.txt']) {
      const gz = zlib.gzipSync(fs.readFileSync(path.join(root, '..', 'data', f)), { level: 9 });
      fs.writeFileSync(path.join(out, 'data', f + '.gz'), gz);
    }
    copy(path.join(root, '..', 'data', 'LICENSES.md'), path.join(out, 'data', 'LICENSES.md'));
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`built dist/${name}`);
  }
}

await build();
