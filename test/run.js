'use strict';

// End-to-end check with a stubbed Gemini and a stubbed upstream subtitle addon.
// No network, no API key needed.

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hebsubs-'));

// ---- a small, entirely invented English subtitle file -----------------------
// Note the sentence deliberately split across cues 4-6: that split is the whole
// point of translating in context rather than line by line.
const SAMPLE = `1
00:00:01,000 --> 00:00:03,200
Morning. You're up early.

2
00:00:03,400 --> 00:00:05,900
- Couldn't sleep.
- Again?

3
00:00:06,000 --> 00:00:07,500
♪

4
00:00:07,800 --> 00:00:10,000
The thing about the new valve is

5
00:00:10,100 --> 00:00:12,400
that it only leaks when nobody

6
00:00:12,500 --> 00:00:14,000
is looking at it.

7
00:00:14,500 --> 00:00:16,000
[door creaks]

8
00:00:16,200 --> 00:00:18,800
Then stop looking away.
`;

function fakeGeminiFetch(url, opts) {
  const body = JSON.parse(opts.body);
  const prompt = body.contents[0].parts[0].text;
  const block = prompt.split('TRANSLATE')[1].split('CONTEXT AFTER')[0];
  const nums = [...block.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
  const arr = nums.map((n) => ({ n, he: `שורה מתורגמת מספר ${n} עם עוד קצת טקסט כדי לבדוק גלישה` }));
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(arr) }] } }],
    }),
  });
}

async function main() {
  const srt = require('../src/srt');

  // ---- 1. parsing ----------------------------------------------------------
  const cues = srt.parse(SAMPLE);
  assert.strictEqual(cues.length, 8, 'should parse 8 cues');
  assert.strictEqual(cues[0].start, 1000);
  assert.strictEqual(cues[3].end, 10000);
  assert.strictEqual(cues[1].lines.length, 2, 'two-speaker cue keeps both lines');
  console.log('✓ parses SRT into 8 cues with correct timings');

  // round-trip
  const round = srt.parse(srt.serialize(cues));
  assert.deepStrictEqual(
    round.map((c) => [c.start, c.end]),
    cues.map((c) => [c.start, c.end]),
    'serialize → parse must round-trip'
  );
  console.log('✓ serialize/parse round-trips without timing drift');

  // VTT input
  const vtt = srt.parse(
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:80%\nHello there\n\n00:00:03.000 --> 00:00:04.000\nSecond\n'
  );
  assert.strictEqual(vtt.length, 2, 'VTT should parse too');
  assert.strictEqual(vtt[0].lines[0], 'Hello there');
  console.log('✓ also parses WebVTT input');

  // non-verbal detection
  assert.ok(srt.isNonVerbal('♪'), '♪ is non-verbal');
  assert.ok(srt.isNonVerbal('- -'), 'dashes are non-verbal');
  assert.ok(!srt.isNonVerbal('[door creaks]'), 'a sound description is text, just not dialogue');
  console.log('✓ non-verbal cues detected');

  // wrapping
  const w = srt.wrap('א'.repeat(20) + ' ' + 'ב'.repeat(20) + ' ' + 'ג'.repeat(20));
  assert.strictEqual(w.length, 2, 'long lines wrap to 2 lines');
  assert.strictEqual(srt.wrap('קצר').length, 1, 'short lines stay on one line');
  console.log('✓ Hebrew output re-wraps to at most two lines');

  // ---- 2. translation pipeline (stubbed model) -----------------------------
  const realFetch = global.fetch;
  global.fetch = fakeGeminiFetch;
  process.env.CHUNK_SIZE = '3'; // force multiple chunks over the spoken cues
  const { translateCues } = require('../src/translate');

  const out = await translateCues(cues, 'test-key', () => {});
  global.fetch = realFetch;

  assert.strictEqual(out.length, cues.length, 'cue count must not change');
  for (let i = 0; i < cues.length; i++) {
    assert.strictEqual(out[i].start, cues[i].start, `cue ${i + 1} start moved`);
    assert.strictEqual(out[i].end, cues[i].end, `cue ${i + 1} end moved`);
  }
  console.log('✓ every timing is carried through untouched');

  assert.deepStrictEqual(out[2].lines, ['♪'], 'music cue text is not translated');
  assert.strictEqual(out[2].drop, true, 'a music-only cue is marked for removal');
  assert.strictEqual(out[6].drop, true, 'a sound-description cue is marked for removal');
  console.log('✓ music and sound-effect cues are marked for removal');

  const verbalIdx = [0, 1, 3, 4, 5, 7];   // 2 is music, 6 is a sound description
  for (const i of verbalIdx) {
    assert.ok(/[֐-׿]/.test(out[i].lines.join(' ')), `cue ${i + 1} not in Hebrew`);
  }
  console.log('✓ all 6 spoken cues came back in Hebrew, none dropped or merged');

  const text = srt.serialize(out);
  assert.strictEqual(srt.parse(text).length, 6, 'the two sound-only cues are gone from the file');
  assert.ok(!/door creaks/i.test(text), 'no sound description reaches the viewer');
  assert.ok(!text.includes('♪'), 'no bare music cue reaches the viewer');
  assert.ok(/^1\n00:00:01,000 --> 00:00:03,200\n/.test(text), 'renumbered from 1');
  console.log('✓ output is valid, renumbered SRT');

  // ---- 3. server routing with a stubbed upstream addon ---------------------
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/subtitles/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          subtitles: [
            { id: '1', url: `http://127.0.0.1:${upstream.address().port}/file.srt`, lang: 'eng' },
            { id: '2', url: 'http://example.invalid/heb.srt', lang: 'heb' },
          ],
        })
      );
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(SAMPLE);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  process.env.UPSTREAM_ADDONS = `http://127.0.0.1:${upstream.address().port}`;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.CACHE_DIR = TMP;
  process.env.PORT = '0';

  global.fetch = (url, opts) =>
    String(url).includes('generativelanguage')
      ? fakeGeminiFetch(url, opts)
      : realFetch(url, opts);

  const server = require('../src/server');
  await new Promise((r) => setTimeout(r, 300));
  const port = server.address ? server.address().port : null;
  const base = `http://127.0.0.1:${port}`;

  const man = await (await realFetch(`${base}/manifest.json`)).json();
  assert.deepStrictEqual(man.resources, ['subtitles']);
  assert.ok(man.types.includes('series') && man.types.includes('movie'));
  console.log('✓ manifest.json is a valid Stremio subtitles addon');

  const subs = await (await realFetch(`${base}/subtitles/series/tt1234567:1:4.json`)).json();
  assert.strictEqual(subs.subtitles.length, 1, 'only the English source is used');
  assert.strictEqual(subs.subtitles[0].lang, 'heb');
  console.log('✓ /subtitles returns one Hebrew entry, ignoring non-English sources');

  const srtRes = await realFetch(subs.subtitles[0].url);
  const srtBody = await srtRes.text();
  assert.ok(srtRes.ok, `.srt endpoint returned ${srtRes.status}`);
  const served = srt.parse(srtBody);
  assert.strictEqual(served.length, 6, 'served file drops the two sound-only cues');
  const kept = cues.filter((_, i) => ![2, 6].includes(i));
  assert.deepStrictEqual(
    served.map((c) => [c.start, c.end]),
    kept.map((c) => [c.start, c.end]),
    'every surviving cue keeps the timing of its English source'
  );
  assert.ok(/[֐-׿]/.test(srtBody), 'served file contains Hebrew');
  console.log('✓ served .srt matches the English timings cue for cue');

  // cache hit on the second request
  const again = await (await realFetch(subs.subtitles[0].url)).text();
  assert.strictEqual(again, srtBody, 'second request served from cache');
  assert.ok(fs.readdirSync(TMP).some((f) => f.endsWith('.srt')), 'cache file written');
  console.log('✓ result cached to disk and reused');

  upstream.close();
  server.close();
  console.log('\nall checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
