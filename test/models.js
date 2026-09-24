'use strict';

// Flash is the default model and Flash-Lite the fallback. These checks cover
// how the switch happens: a per-day quota moves on at once, a per-minute one
// is waited out, and a model found out of quota is not retried every chunk.

const assert = require('assert');

const GOOD = (text) => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } }
);
const QUOTA = (quotaId, retry) => new Response(JSON.stringify({ error: {
  code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId, quotaValue: '250' }] },
    ...(retry ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }] : []),
  ],
} }), { status: 429 });

const URL_FLASH = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';
const BODY = { method: 'POST', body: JSON.stringify({ contents: [] }) };

function fresh(stub) {
  delete require.cache[require.resolve('../src/gemini-fetch')];
  const calls = [];
  const fetchStub = async (u, o) => { calls.push(/models\/([^:]+):/.exec(String(u))[1]); return stub(String(u), calls.length); };
  const state = require('../src/gemini-fetch').install({ fetch: fetchStub, log: () => {}, fastRetries: true });
  return { calls, state };
}

async function main() {
  // ---- 1. the defaults ----------------------------------------------------
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK;
  delete require.cache[require.resolve('../src/translate')];
  const { MODEL } = require('../src/translate');
  assert.strictEqual(MODEL, 'gemini-flash-latest', 'Flash must be the default model');
  const { state } = fresh(() => GOOD('ok'));
  assert.deepStrictEqual(state.fallbacks, ['gemini-flash-lite-latest'], 'Flash-Lite must be the default fallback');
  console.log('✓ Flash by default, Flash-Lite as the fallback');

  // ---- 2. daily quota: switch at once, no waiting -------------------------
  {
    const { calls } = fresh((u) =>
      u.includes('gemini-flash-latest:')
        ? QUOTA('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '18s')
        : GOOD('from lite'));
    const t0 = Date.now();
    const res = await global.fetch(URL_FLASH, BODY);
    const ms = Date.now() - t0;
    assert.strictEqual(res.status, 200, 'the fallback must answer');
    assert.deepStrictEqual(calls, ['gemini-flash-latest', 'gemini-flash-lite-latest'],
      'one try on Flash, then straight to Flash-Lite');
    assert.ok(ms < 1000, `switching took ${ms}ms - it must not wait for a daily quota`);
    console.log('✓ a used-up daily quota moves to Flash-Lite after one try, with no waiting');

    // ---- 3. and stays there: the next chunk does not rediscover it -------
    calls.length = 0;
    await global.fetch(URL_FLASH, BODY);
    assert.deepStrictEqual(calls, ['gemini-flash-lite-latest'],
      'Flash must be skipped for the next chunks, not hit again');
    console.log('✓ the next request skips Flash for the rest of the hour');
  }

  // ---- 4. a model with no free quota at all behaves the same --------------
  {
    const { calls } = fresh((u) => {
      if (!u.includes('gemini-flash-latest:')) return GOOD('lite');
      return new Response(JSON.stringify({ error: { code: 429,
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinute', quotaValue: '0' }] }] } }), { status: 429 });
    });
    await global.fetch(URL_FLASH, BODY);
    assert.deepStrictEqual(calls, ['gemini-flash-latest', 'gemini-flash-lite-latest'],
      'a quota of zero is never coming back by waiting');
    console.log('✓ a model with a zero free quota is skipped at once too');
  }

  // ---- 5. per-minute limit: wait and retry the SAME model -----------------
  {
    const { calls } = fresh((u, n) =>
      n === 1 ? QUOTA('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '2s') : GOOD('flash again'));
    const res = await global.fetch(URL_FLASH, BODY);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls, ['gemini-flash-latest', 'gemini-flash-latest'],
      'a per-minute limit is worth waiting for, on the same model');
    console.log('✓ a per-minute limit is waited out on Flash, not treated as the end of the day');
  }

  // ---- 6. GEMINI_FALLBACK="" means no fallback ----------------------------
  {
    process.env.GEMINI_FALLBACK = '';
    const { calls, state: s } = fresh(() => QUOTA('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
    assert.deepStrictEqual(s.fallbacks, [], 'an empty setting disables the fallback');
    const res = await global.fetch(URL_FLASH, BODY);
    assert.strictEqual(res.status, 429, 'with no fallback the quota error comes back');
    assert.deepStrictEqual(calls, ['gemini-flash-latest']);
    delete process.env.GEMINI_FALLBACK;
    console.log('✓ GEMINI_FALLBACK="" turns the fallback off');
  }

  // ---- 7. an explicit Flash-Lite setup does not fall back to itself -------
  {
    const liteUrl = URL_FLASH.replace('gemini-flash-latest', 'gemini-flash-lite-latest');
    const { calls } = fresh(() => QUOTA('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
    await global.fetch(liteUrl, BODY);
    assert.deepStrictEqual(calls, ['gemini-flash-lite-latest'],
      'the fallback is not tried twice when it is also the main model');
    console.log('✓ a deployment already on Flash-Lite does not loop onto itself');
  }

  // ---- 8. overload: two tries, then Flash-Lite, and Flash rests 5 minutes --
  // A real episode spent 37 of its 44 minutes waiting out 503s on Flash, one
  // full retry ladder per chunk, before each chunk moved to Flash-Lite anyway.
  {
    const BUSY = () => new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 });
    const { calls, state: s } = fresh((u) => (u.includes('gemini-flash-latest:') ? BUSY() : GOOD('lite')));
    const res = await global.fetch(URL_FLASH, BODY);
    assert.strictEqual(res.status, 200, 'Flash-Lite must answer');
    assert.deepStrictEqual(calls, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest'],
      'two tries on an overloaded Flash, not six');
    const rest = s.resting.get('gemini-flash-latest') - Date.now();
    assert.ok(rest > 4 * 60000 && rest <= 5 * 60000, `Flash should rest about 5 minutes, got ${Math.round(rest / 1000)}s`);

    calls.length = 0;
    await global.fetch(URL_FLASH, BODY);
    assert.deepStrictEqual(calls, ['gemini-flash-lite-latest'], 'the next chunk goes straight to Flash-Lite');
    console.log('✓ an overloaded Flash hands over after two tries and rests for five minutes');
  }

  // ---- 9. overload with nowhere else to go: the full ladder still applies --
  {
    process.env.GEMINI_FALLBACK = '';
    const { calls } = fresh((u, n) => (n < 4 ? new Response('{}', { status: 503 }) : GOOD('flash, eventually')));
    const res = await global.fetch(URL_FLASH, BODY);
    delete process.env.GEMINI_FALLBACK;
    assert.strictEqual(res.status, 200, 'with no fallback, waiting it out must still work');
    assert.strictEqual(calls.length, 4, 'three 503s, then the answer - no early give-up');
    console.log('✓ with no fallback, an overload is still waited out in full');
  }

  // ---- 10. a failure says which model it came from, in one line ---------
  // The log used to blame Flash, in a block of raw JSON, for a 503 that
  // Flash-Lite had returned.
  {
    const BUSY = () => new Response(JSON.stringify({ error: { code: 503,
      message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }, null, 2), { status: 503 });
    fresh(() => BUSY());
    const res = await global.fetch(URL_FLASH, BODY);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers.get('x-gemini-model'), 'gemini-flash-lite-latest',
      'the failure must name the model that actually failed');

    process.env.GEMINI_RETRIES = '2'; // one retry, so one "waiting" line is logged
    process.env.NAME_GLOSSARY = '0';
    delete require.cache[require.resolve('../src/translate')];
    const { translateCues } = require('../src/translate');
    const logs = [];
    const cues = [{ start: 0, end: 1000, lines: ['Hello there, how are you doing today?'] }];
    await translateCues(cues, 'k', (m) => logs.push(m), null, null, 'heb').catch(() => {});
    delete process.env.GEMINI_RETRIES;
    delete process.env.NAME_GLOSSARY;
    const fail = logs.find((m) => /503/.test(m)) || '';
    assert.ok(/gemini-flash-lite-latest 503: This model is currently experiencing high demand/.test(fail),
      `the log line must be short and name Flash-Lite, got: ${fail}`);
    assert.ok(!/[{}\n]/.test(fail), 'no raw JSON in the log');
    console.log('✓ a failure is logged in one line, naming the model that actually failed');
  }

  console.log('\nall model checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
