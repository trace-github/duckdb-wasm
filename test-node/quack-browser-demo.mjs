#!/usr/bin/env node
// Quack remote-querying demo (BROWSER): native DuckDB host <-- HTTP --> DuckDB-WASM
// client running in a real headless Chrome, using the browser's NATIVE synchronous
// XMLHttpRequest (no shim — the standard duckdb-wasm path).
//
//   - HOST    : native DuckDB via @duckdb/node-api (quack-host.mjs) — quack_serve.
//   - SERVER  : tiny static server for quack-client-page.html + /dist, with
//               COOP/COEP so the page is crossOriginIsolated (COI bundle needs it).
//   - CLIENT  : our @run-trace/duckdb-wasm build in Chrome; native XHR -> host.
//
// Usage: node test-node/quack-browser-demo.mjs   (set CHROME_PATH to override Chrome)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startHost } from './quack-host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');
const PAGE = join(__dirname, 'quack-client-page.html');
const PORT = 9877;
const URI = 'quack:localhost:9494';
const TOKEN = 'super_secret';
const require = createRequire(import.meta.url);
const puppeteer = require('../test-rig/node_modules/puppeteer-core');

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const home = process.env.HOME;
  const cands = [
    `${home}/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  return cands.find((p) => existsSync(p));
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // COOP/COEP -> crossOriginIsolated, so the COI (threaded) bundle loads.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      try {
        const url = req.url.split('?')[0];
        const file = url === '/' ? PAGE
          : url === '/arrow-bundle.mjs' ? join(__dirname, '..', 'test-rig', 'arrow-bundle.mjs')
          : url.startsWith('/dist/') ? join(DIST, url.slice('/dist/'.length)) : null;
        if (!file || !existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
        res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
        res.end(await readFile(file));
      } catch (e) { res.statusCode = 500; res.end(String(e)); }
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  const log = (s, m) => console.log(`[${s}] ${m}`);
  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome found; set CHROME_PATH'); process.exit(1); }
  if (!existsSync(join(DIST, 'duckdb-browser.mjs'))) { console.error('dist not built'); process.exit(1); }

  const host = await startHost({ uri: URI, token: TOKEN, log: (m) => log('host', m) });
  const server = await startServer();
  log('server', `serving page + /dist on http://localhost:${PORT} (COOP/COEP)`);
  log('browser', `launching Chrome: ${chrome}`);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
  let ok = false;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => log('page', m.text()));
    page.on('pageerror', (e) => log('page:error', e.message));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.__quackResult || window.__quackError', { timeout: 60000 });
    const err = await page.evaluate('window.__quackError || null');
    if (err) throw new Error('browser client error: ' + err);
    const { rows, udfRows } = await page.evaluate('window.__quackResult');
    console.log('       rows:', JSON.stringify(rows));
    console.log('       udf rows:', JSON.stringify(udfRows));
    const back = await host.readBack('SELECT magic, note FROM from_wasm');
    log('host', `sees client write-back: ${JSON.stringify(back)}`);
    ok = rows.length === 3 && Number(back?.[0]?.magic) === 99 &&
         udfRows.length === 3 && Number(udfRows[0].points) === 90 && Number(udfRows[2].points) === 290;
  } finally {
    await browser.close();
    server.close();
    await host.stop();
  }
  console.log('\n========================================');
  console.log(ok ? '  DEMO PASSED — browser wasm client queried native host over quack' : '  DEMO FAILED');
  console.log('========================================');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
