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

  console.log('\nall model checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
