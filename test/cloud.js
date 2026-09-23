'use strict';

// The names pass adds one request per episode; it has its own suite
// (test/names.js). Off here so these checks stay about their own subject.
process.env.NAME_GLOSSARY = '0';

// Stub addons run on 127.0.0.1; the server refuses private addresses otherwise.
process.env.ALLOW_PRIVATE_SOURCES = '1';

// Checks the public-deployment path: the user's API key must never appear in
// any URL, a stolen link must be rate limited, and the configure flow must work.

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'AQ.TOTALLY-FAKE-USER-KEY-abcdefghijklmnop';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hebsubs-cloud-'));

const SAMPLE = `1
00:00:01,000 --> 00:00:03,000
Good morning.

2
00:00:03,200 --> 00:00:05,000
Is the coffee ready?
`;

async function main() {
  // ---- 1. sealing ---------------------------------------------------------
  process.env.SECRET = 'a-long-enough-server-secret-value';
  const secret = require('../src/secret');

  assert.ok(secret.enabled(), 'a SECRET was provided, so sealing should be on');
  const token = secret.seal({ key: KEY });
  assert.ok(!token.includes(KEY), 'the token must not contain the key verbatim');
  assert.ok(!Buffer.from(token.slice(2), 'base64url').toString('latin1').includes('AQ.'),
    'the key must not be recoverable by simply decoding the token');
  assert.deepStrictEqual(secret.open(token), { key: KEY }, 'sealing must round-trip');
  console.log('✓ key seals into an opaque token and comes back intact');

  const bad = token.slice(0, -4) + 'AAAA';
  assert.strictEqual(secret.open(bad), null, 'a tampered token must be rejected');
  assert.strictEqual(secret.open('e1notbase64'), null, 'garbage must be rejected');
  assert.strictEqual(secret.open('plain-text'), null, 'unsealed input must be rejected');
  console.log('✓ tampered or forged tokens are rejected');

  // ---- 2. a stub upstream + stub Gemini -----------------------------------
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/subtitles/')) {
      // Give every episode its own source file, as a real provider would -
      // otherwise they would all collapse into one cache entry.
      const tag = encodeURIComponent(req.url.replace(/\W+/g, '_'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        subtitles: [{ id: '1', url: `http://127.0.0.1:${upstream.address().port}/f-${tag}.srt`, lang: 'eng' }],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(SAMPLE);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const realFetch = global.fetch;
  let geminiSawKey = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('generativelanguage')) {
      geminiSawKey = (opts.headers || {})['x-goog-api-key'];
      if (u.includes(':generateContent')) {
        const nums = [...JSON.parse(opts.body).contents[0].parts[0].text
          .split('TRANSLATE')[1].split('CONTEXT AFTER')[0].matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(nums.map((n) => ({ n, he: 'שורה ' + n }))) }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  // ---- 3. boot a public-style server (SECRET, but no key of its own) -------
  process.env.UPSTREAM_ADDONS = `http://127.0.0.1:${upstream.address().port}`;
  process.env.CACHE_DIR = TMP;
  process.env.PORT = '0';
  process.env.QUIET = '1';
  process.env.RATE_LIMIT_PER_DAY = '1';
  delete process.env.GEMINI_API_KEY;

  const server = require('../src/server');
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---- 4. manifest signalling --------------------------------------------
  const bare = await (await realFetch(`${base}/manifest.json`)).json();
  assert.strictEqual(bare.behaviorHints.configurable, true, 'public server must advertise a configure step');
  assert.strictEqual(bare.behaviorHints.configurationRequired, true, 'unconfigured manifest must demand config');

  const conf = await (await realFetch(`${base}/${token}/manifest.json`)).json();
  assert.strictEqual(conf.behaviorHints.configurationRequired, false, 'a configured manifest is ready to use');
  console.log('✓ manifest asks for configuration only when it has none');

  // ---- 5. the key must not leak into any URL ------------------------------
  const subs = await (await realFetch(`${base}/${token}/subtitles/series/tt1234567:1:1.json`)).json();
  assert.strictEqual(subs.subtitles.length, 1, 'expected one Hebrew entry');
  const subUrl = subs.subtitles[0].url;
  assert.ok(!subUrl.includes(KEY), 'THE KEY MUST NOT APPEAR IN THE SUBTITLE URL');
  assert.ok(!subUrl.toLowerCase().includes('&k='), 'no raw key parameter may be present');
  assert.ok(subUrl.includes(encodeURIComponent(token)) || subUrl.includes(token), 'the sealed token should be carried instead');
  console.log('✓ the subtitle URL carries the sealed token, never the key');

  // ---- 6. and the whole thing still works end to end ----------------------
  const srtRes = await realFetch(subUrl);
  const body = await srtRes.text();
  assert.ok(srtRes.ok, `.srt endpoint returned ${srtRes.status}`);
  assert.ok(/[֐-׿]/.test(body), 'served file should contain Hebrew');
  assert.ok(body.includes('00:00:01,000 --> 00:00:03,000'), 'original timings preserved');
  assert.strictEqual(geminiSawKey, KEY, 'the server must have used the real key when calling Google');
  console.log('✓ end to end: sealed link translates and keeps the timings');

  // ---- 7. a stolen link is capped ----------------------------------------
  const second = await (await realFetch(`${base}/${token}/subtitles/series/tt7654321:2:2.json`)).json();
  assert.strictEqual(second.subtitles.length, 0, 'a second new episode must be refused at RATE_LIMIT_PER_DAY=1');
  const repeat = await (await realFetch(`${base}/${token}/subtitles/series/tt1234567:1:1.json`)).json();
  assert.strictEqual(repeat.subtitles.length, 1, 'an already-cached episode must still be served');
  console.log('✓ daily cap limits new episodes but never blocks cached ones');

  // ---- 8. configure page and its API -------------------------------------
  const page = await realFetch(`${base}/configure`);
  const html = await page.text();
  assert.ok(html.includes('aistudio.google.com'), 'configure page should point at AI Studio');
  assert.ok(html.includes('/api/url'), 'configure page should post to the url builder');

  const short = await (await realFetch(`${base}/api/url`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'abc' }),
  })).json();
  assert.ok(short.error, 'a too-short key must be refused');
  console.log('✓ configure page loads and refuses nonsense keys');

  // ---- 9. nothing sensitive hit the disk ---------------------------------
  for (const f of fs.readdirSync(TMP)) {
    const c = fs.readFileSync(path.join(TMP, f), 'utf8');
    assert.ok(!c.includes(KEY), `the key leaked into cache file ${f}`);
  }
  console.log('✓ no cached file contains the key');

  upstream.close();
  server.close();
  console.log('\nall cloud checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ ' + (e.stack || e.message)); process.exit(1); });
