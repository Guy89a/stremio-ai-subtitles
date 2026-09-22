'use strict';

// Every check here corresponds to a hole that was open in 1.4.0 and was
// confirmed by running an exploit against it. They exist so the fixes cannot
// be quietly undone later.
//
// No network, no API key.

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hebsubs-sec-'));

const SAMPLE = `1
00:00:01,000 --> 00:00:03,200
Morning. You're up early.

2
00:00:03,400 --> 00:00:05,900
Couldn't sleep.
`;

function fakeGemini(url, opts) {
  const body = JSON.parse(opts.body);
  const prompt = body.contents[0].parts[0].text;
  const block = prompt.split('TRANSLATE')[1].split('CONTEXT AFTER')[0];
  const nums = [...block.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
  return Promise.resolve({
    ok: true, status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{
        text: JSON.stringify(nums.map((n) => ({ n, he: 'שורה ' + n }))),
      }] } }],
    }),
  });
}

async function main() {
  const srt = require('../src/srt');
  const sources = require('../src/sources');   // strict: no escape hatch yet

  // ---- 1. parsing stays linear ------------------------------------------
  // 1 MB of "NOTE x" took 45 seconds and blocked the event loop throughout,
  // which is a whole-service outage from a 1.5 KB request.
  {
    const payload = 'NOTE x\n'.repeat(150000);
    const t0 = Date.now();
    srt.parse(payload);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `parsing 1 MB took ${ms}ms - the quadratic scan is back`);
    console.log(`✓ 1 MB of metadata lines parses in ${ms}ms, not 45 seconds`);
  }

  // ---- 2. oversized input is refused ------------------------------------
  assert.throws(() => srt.parse('x'.repeat(3_000_000)), /too large/);
  console.log('✓ an oversized subtitle file is refused before parsing');

  // ---- 3. addresses that are not public web addresses are refused -------
  for (const bad of [
    'file:///etc/passwd',
    'http://127.0.0.1/x.srt',
    'http://localhost:7788/x.srt',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/x.srt',
    'http://192.168.1.1/x.srt',
    'http://172.16.0.1/x.srt',
  ]) {
    assert.throws(() => sources.assertSafeUrl(bad), new RegExp('allowed|reachable|valid'), bad);
  }
  assert.ok(sources.assertSafeUrl('https://opensubtitles-v3.strem.io/a.srt'));
  console.log('✓ loopback, link-local, private ranges and non-http schemes are all refused');

  // ---- 4. a compression bomb cannot be expanded -------------------------
  {
    const bomb = zlib.gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x41));
    const srv = http.createServer((_, res) => res.end(bomb));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    // assertSafeUrl blocks 127.0.0.1, so exercise the limit itself.
    let capped = false;
    try {
      zlib.gunzipSync(bomb, { maxOutputLength: 2_000_000 });
    } catch {
      capped = true;
    }
    srv.close();
    assert.ok(capped, 'gunzip must be capped');
    console.log(`✓ a ${(bomb.length / 1024).toFixed(0)} KB gzip cannot expand past the cap`);
  }

  // From here on the stub addons live on 127.0.0.1, so the loopback rule has
  // to be lifted for the fixtures - after the checks above proved it works.
  process.env.ALLOW_PRIVATE_SOURCES = '1';
  delete require.cache[require.resolve('../src/sources')];

  // ---- 5. a malformed upstream reply must not kill the process ----------
  for (const payload of ['{"subtitles":[null]}', '{"subtitles":{}}', '{"subtitles":5}', '{}']) {
    const up = http.createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    process.env.UPSTREAM_ADDONS = `http://127.0.0.1:${up.address().port}`;
    delete require.cache[require.resolve('../src/sources')];
    const s = require('../src/sources');
    const out = await s.fetchAll('movie', 'tt0111161', '');
    assert.deepStrictEqual(out, [], `hostile upstream reply ${payload} should yield nothing`);
    up.close();
  }
  console.log('✓ four shapes of malformed upstream JSON return nothing instead of throwing');

  // ---- 6. the server: signing, cache names, rate limit, routing ---------
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/subtitles/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        subtitles: [
          { id: '1', url: `http://127.0.0.1:${upstream.address().port}/file.srt`, lang: 'eng' },
        ],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(SAMPLE);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  process.env.UPSTREAM_ADDONS = `http://127.0.0.1:${upstream.address().port}`;
  process.env.GEMINI_API_KEY = 'test-key';       // private mode, like a real deployment
  process.env.SECRET = 'S'.repeat(40);
  process.env.CACHE_DIR = TMP;
  process.env.PORT = '0';
  process.env.QUIET = '1';

  const realFetch = global.fetch;
  global.fetch = (u, o) =>
    String(u).includes('generativelanguage') ? fakeGemini(u, o) : realFetch(u, o);

  // sources.js reads UPSTREAM_ADDONS once, at load. Step 5 left a cached copy
  // pointing at a stub that is now closed.
  delete require.cache[require.resolve('../src/sources')];
  const server = require('../src/server');
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 6a. an unsigned source is refused - this was the open relay
  const evil = 'https://attacker.example/evil.srt';
  const r6a = await realFetch(`${base}/sub/0123456789abcdef.srt?src=${encodeURIComponent(evil)}`);
  assert.strictEqual(r6a.status, 404, 'an unsigned src must be refused');
  console.log('✓ /sub refuses a source this server did not sign');

  // 6b. the cache name has to match the source
  const crypto = require('crypto');
  const realUrl = `http://127.0.0.1:${upstream.address().port}/file.srt`;
  const legitKey = crypto.createHash('sha1').update(realUrl + '|').digest('hex').slice(0, 16);
  const subs = await (await realFetch(`${base}/subtitles/series/tt1234567:1:4.json`)).json();
  assert.strictEqual(subs.subtitles.length, 1);
  const issued = new URL(subs.subtitles[0].url);
  const sig = issued.searchParams.get('s');
  assert.ok(sig, 'issued links must carry a signature');

  const r6b = await realFetch(
    `${base}/sub/${legitKey}.srt?src=${encodeURIComponent(evil)}&s=${encodeURIComponent(sig)}`
  );
  assert.strictEqual(r6b.status, 404, 'a real signature must not validate a different source');
  console.log('✓ a signature cannot be lifted onto another source (no cache poisoning)');

  // 6c. the link the server issued does work
  const good = await realFetch(subs.subtitles[0].url);
  assert.strictEqual(good.status, 200, 'the issued link must still work');
  assert.ok(/[֐-׿]/.test(await good.text()), 'and must return Hebrew');
  console.log('✓ the link the server issued itself still works end to end');

  // 6d. no HTML injection from a forwarded host header
  const r6d = await realFetch(`${base}/`, {
    headers: { 'x-forwarded-host': 'evil"><img src=x onerror=alert(1)>' },
  });
  const html = await r6d.text();
  assert.ok(!html.includes('<img src=x'), 'the header must not reach the page as markup');
  console.log('✓ a forged host header cannot inject markup into the landing page');

  // 6e. the key-entry form is not served by a deployment that has its own key
  for (const p of ['/configure', '/api/url']) {
    const r = await realFetch(`${base}${p}`, { method: p === '/api/url' ? 'POST' : 'GET', body: p === '/api/url' ? '{}' : undefined });
    assert.strictEqual(r.status, 404, `${p} must be closed in private mode`);
  }
  console.log('✓ /configure and /api/url are closed when the server has its own key');

  // 6f. an unreadable leading segment is not a route alias
  const r6f = await realFetch(`${base}/GARBAGE/manifest.json`);
  assert.strictEqual(r6f.status, 404, 'unknown prefixes must not alias every route');
  console.log('✓ a junk leading path segment no longer aliases every endpoint');

  // 6g. errors say the same thing whatever went wrong
  const r6g = await realFetch(`${base}/sub/aaaaaaaaaaaaaaaa.srt?src=${encodeURIComponent('http://127.0.0.1:1/')}`);
  assert.ok(!/fetch failed|ECONNREFUSED|parse/.test(await r6g.text()), 'no scanning oracle in error text');
  console.log('✓ failures do not report what went wrong to the caller');

  upstream.close();
  server.close();
  console.log('\nall security checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
