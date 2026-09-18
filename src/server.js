'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const srt = require('./srt');
const secret = require('./secret');
const { translateCues, MODEL } = require('./translate');
const { findEnglishSubtitles, downloadSubtitle, UPSTREAMS } = require('./sources');

const PORT = parseInt(process.env.PORT || '7788', 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache');
const MAX_SOURCES = parseInt(process.env.MAX_SOURCES || '2', 10);
const ENV_KEY = process.env.GEMINI_API_KEY || '';

fs.mkdirSync(CACHE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- job runner

const jobs = new Map(); // cacheKey -> Promise<string>

function cacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}
const cachePath = (key) => path.join(CACHE_DIR, `${key}.srt`);

function readCache(key) {
  try {
    const p = cachePath(key);
    const body = fs.readFileSync(p, 'utf8');
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

async function buildHebrew(key, sourceUrl, apiKey) {
  const cached = readCache(key);
  if (cached) return cached;
  if (jobs.has(key)) return jobs.get(key);

  const job = (async () => {
    log(`[${key}] downloading ${sourceUrl.slice(0, 90)}`);
    const text = await downloadSubtitle(sourceUrl);
    const cues = srt.parse(text);
    if (!cues.length) throw new Error('could not parse the source subtitle file');
    log(`[${key}] parsed ${cues.length} cues`);

    const translated = await translateCues(cues, apiKey, (m) => log(`[${key}] ${m}`));

    // Timings are carried straight through — only the text changed.
    for (let i = 0; i < cues.length; i++) {
      if (translated[i].start !== cues[i].start || translated[i].end !== cues[i].end) {
        throw new Error('internal: timing drift detected');
      }
    }

    const out = '﻿' + srt.serialize(translated);
    fs.writeFileSync(cachePath(key), out, 'utf8');
    log(`[${key}] cached ${cues.length} cues`);
    return out;
  })();

  jobs.set(key, job);
  job.catch((e) => log(`[${key}] failed: ${e.message}`)).finally(() => {
    setTimeout(() => jobs.delete(key), 2000);
  });
  return job;
}

// ---------------------------------------------------------------- addon meta

function configurePage(base) {
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>הגדרת כתוביות עברית</title>
<style>
:root{--bg:#fbfaf8;--fg:#23201d;--muted:#6b645d;--line:#e5e0d8;--accent:#7c4a2d;--card:#fff;--code:#f3efe9;--warn:#fdf6e7;--warnline:#e0c98a}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1b1917;--fg:#ece7e1;--muted:#a49c93;--line:#35302b;--accent:#d99a6e;--card:#232020;--code:#2a2523;--warn:#2e2717;--warnline:#6b5a2e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif;line-height:1.7}
.wrap{max-width:660px;margin:0 auto;padding:44px 16px 72px}
h1{font-size:1.8rem;margin:0 0 .25em}
.sub{color:var(--muted);margin:0 0 2em}
h2{font-size:1.1rem;margin:2em 0 .5em}
label{display:block;font-weight:600;margin:0 0 .4em}
input{width:100%;padding:12px 14px;font-size:1rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);direction:ltr;text-align:left}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{margin-top:14px;padding:12px 22px;font-size:1rem;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:1.2em 0}
.warn{background:var(--warn);border:1px solid var(--warnline);border-radius:8px;padding:14px 18px;margin:1.2em 0}
code,.out{background:var(--code);border-radius:6px;font-family:Consolas,monospace;direction:ltr;display:block;padding:12px 14px;word-break:break-all;font-size:.9rem;text-align:left}
.err{color:#b3261e;margin-top:.8em}
@media(prefers-color-scheme:dark){.err{color:#f2b8b5}}
ol{padding-inline-start:1.3em}li{margin:.4em 0}
a{color:var(--accent)}
.hide{display:none}
.muted{color:var(--muted);font-size:.93rem}
</style></head><body><div class="wrap">

<h1>כתוביות עברית לסטרמיו</h1>
<p class="sub">תרגום כתוביות אנגלית לעברית, עם התזמון המקורי. כל אחד משתמש במפתח שלו.</p>

<h2>1. מפתח Gemini</h2>
<p>צרו מפתח חינמי ב־<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> והדביקו אותו כאן.</p>
<label for="k">מפתח ה־API שלכם</label>
<input id="k" type="password" autocomplete="off" spellcheck="false" placeholder="AQ... או AIza...">
<button id="go">צור לי כתובת התקנה</button>
<div id="err" class="err"></div>

<div id="result" class="hide">
  <h2>2. הכתובת שלכם</h2>
  <div class="out" id="url"></div>
  <button id="copy">העתק</button>
  <div class="card">
    <strong>איך מתקינים</strong>
    <ol>
      <li>פתחו את <strong>Stremio</strong> ← <strong>Addons</strong></li>
      <li>הדביקו את הכתובת בשדה החיפוש למעלה</li>
      <li>לחצו <strong>Install</strong></li>
    </ol>
    <p class="muted">פתחו פרק, חכו דקות ספורות בפעם הראשונה, ובחרו <strong>Hebrew</strong> בתפריט הכתוביות.</p>
  </div>
  <div class="warn">
    <strong>שמרו על הכתובת הזו כמו על סיסמה.</strong>
    המפתח בתוכה מוצפן ואי אפשר לחלץ אותו ממנה, אבל מי שמחזיק בכתובת יכול לתרגם על חשבון המכסה שלכם.
    אם היא דלפה — מחקו את המפתח ב־AI Studio וצרו כתובת חדשה כאן.
  </div>
</div>

<h2>רוצים בידוד מלא?</h2>
<p>
השרת הזה מפענח את המפתח שלכם בזמן הבקשה כדי לפנות לגוגל — כלומר אתם סומכים על מי שמפעיל אותו.
מי שמעדיף שהמפתח לא יעבור דרך אף שרת של אף אחד יכול לפרוס עותק משלו בחינם תוך שתי דקות,
ואז המפתח יושב בהגדרות השרת שלו ולא מופיע בשום כתובת.
</p>

<script>
var k=document.getElementById('k'),go=document.getElementById('go'),err=document.getElementById('err'),
    res=document.getElementById('result'),out=document.getElementById('url'),copy=document.getElementById('copy');
go.onclick=function(){
  var key=k.value.trim(); err.textContent='';
  if(key.length<20){err.textContent='המפתח נראה קצר מדי.';return;}
  go.disabled=true; go.textContent='בודק מול גוגל...';
  fetch('/api/url',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:key})})
   .then(function(r){return r.json()})
   .then(function(d){
     go.disabled=false; go.textContent='צור לי כתובת התקנה';
     if(d.error){err.textContent=d.error;return;}
     out.textContent=d.url; res.className=''; k.value='';
     res.scrollIntoView({behavior:'smooth',block:'start'});
   })
   .catch(function(){go.disabled=false;go.textContent='צור לי כתובת התקנה';err.textContent='משהו השתבש. נסו שוב.';});
};
k.addEventListener('keydown',function(e){if(e.key==='Enter')go.click();});
copy.onclick=function(){
  navigator.clipboard.writeText(out.textContent).then(function(){
    copy.textContent='הועתק'; setTimeout(function(){copy.textContent='העתק'},1600);
  });
};
</script>
</div></body></html>`;
}

function manifest(configured) {
  return {
    id: 'community.hebrew.ai.subtitles',
    version: '1.0.0',
    name: 'כתוביות עברית (AI)',
    description:
      'מתרגם כתוביות אנגלית לעברית עם מודל שפה — קורא את הדיאלוג כרצף שלם ומחזיר אותו לשורות בתזמון המקורי.',
    logo: 'https://dl.strem.io/addon-logo.png',
    resources: ['subtitles'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['tt', 'kitsu'],
    behaviorHints: {
      // Only a public deployment (one with a SECRET and no key of its own)
      // needs the configure step; a private one already has its key.
      configurable: secret.enabled() && !ENV_KEY,
      configurationRequired: secret.enabled() && !ENV_KEY && !configured,
    },
  };
}

// ---------------------------------------------------------------- http server

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    ...headers,
  });
  res.end(body);
}
const sendJson = (res, obj, cache = 'public, max-age=300') =>
  send(res, 200, JSON.stringify(obj), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
  });

function publicBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

// Config can ride in the URL so one deployment can serve several people, each
// with their own Gemini key. Preferred form is an encrypted token (see
// secret.js); plain base64url JSON stays supported for local use where there
// is no SECRET and nothing to hide from.
function decodeConfig(segment) {
  const sealed = secret.open(segment);
  if (sealed) return sealed;
  if (secret.enabled()) return null; // on a public server, only sealed tokens count
  try {
    const cfg = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof cfg === 'object' && cfg ? cfg : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rate limit

// A stolen install URL should be worth very little. Each config gets its own
// daily budget of episodes; the cache means re-watching costs nothing.
const RATE_PER_DAY = parseInt(process.env.RATE_LIMIT_PER_DAY || '40', 10);
const buckets = new Map(); // fingerprint -> { day, episodes:Set }

function withinRate(token, episodeKey) {
  if (!token || RATE_PER_DAY <= 0) return true;
  const day = Math.floor(Date.now() / 86400000);
  const fp = secret.fingerprint(token);
  let b = buckets.get(fp);
  if (!b || b.day !== day) {
    b = { day, episodes: new Set() };
    buckets.set(fp, b);
  }
  if (b.episodes.has(episodeKey)) return true; // already counted
  if (b.episodes.size >= RATE_PER_DAY) return false;
  b.episodes.add(episodeKey);
  return true;
}

async function handleSubtitles(req, res, { type, id, extra, apiKey, token }) {
  if (!apiKey) return sendJson(res, { subtitles: [] }, 'no-store');

  const sources = (await findEnglishSubtitles(type, id, extra)).slice(0, MAX_SOURCES);
  log(`subtitles ${type}/${id} → ${sources.length} english source(s)`);
  if (!sources.length) return sendJson(res, { subtitles: [] }, 'no-store');

  const base = publicBase(req);
  const subtitles = [];
  for (const [i, s] of sources.entries()) {
    const key = cacheKey(s.url);
    if (!readCache(key) && !withinRate(token, key)) {
      log(`rate limit reached for ${secret.fingerprint(token)} - skipping`);
      break;
    }
    // Warm the cache now so the file is usually ready the moment it is picked.
    buildHebrew(key, s.url, apiKey).catch(() => {});
    // The key itself never travels here: on a public server `token` is the
    // sealed blob, and on a local one the key already lives in the env.
    const carry = token ? `&c=${encodeURIComponent(token)}` : '';
    subtitles.push({
      id: `he-ai-${key}`,
      url: `${base}/sub/${key}.srt?src=${encodeURIComponent(s.url)}${carry}`,
      lang: i === 0 ? 'heb' : `heb-${i + 1}`,
    });
  }

  sendJson(res, { subtitles }, 'no-store');
}

async function handleSrt(req, res, url) {
  const key = path.basename(url.pathname).replace(/\.srt$/i, '');
  const src = url.searchParams.get('src');
  const carried = url.searchParams.get('c');
  const cfg = carried ? decodeConfig(carried) : null;
  const apiKey = (cfg && cfg.key) || ENV_KEY;

  const headers = {
    'content-type': 'application/x-subrip; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  };

  const cached = readCache(key);
  if (cached) return send(res, 200, cached, headers);
  if (!src || !apiKey) return send(res, 404, 'not found');

  try {
    const body = await buildHebrew(key, src, apiKey);
    send(res, 200, body, headers);
  } catch (e) {
    log('srt error:', e.message);
    send(res, 502, `translation failed: ${e.message}`, { 'content-type': 'text/plain' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // optional leading config segment
  const RESERVED = ['manifest.json', 'subtitles', 'sub', 'health', 'configure', 'api', ''];
  let apiKey = ENV_KEY;
  let token = null;
  if (parts.length && !RESERVED.includes(parts[0])) {
    const cfg = decodeConfig(parts[0]);
    if (cfg && cfg.key) {
      apiKey = cfg.key;
      token = parts[0];
    }
    parts.shift();
  }

  try {
    if (!parts.length) {
      const base = publicBase(req);
      // A public deployment has no key of its own - send people to configure.
      if (secret.enabled() && !ENV_KEY) {
        return send(res, 200, configurePage(base), {
          'content-type': 'text/html; charset=utf-8',
        });
      }
      return send(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>כתוביות עברית (AI)</title>
<body style="font-family:system-ui;max-width:620px;margin:3rem auto;padding:0 1rem;direction:rtl">
<h1>כתוביות עברית (AI)</h1>
<p>השרת פעיל. כדי להתקין בסטרמיו, הדביקו את הכתובת הזו בשורת החיפוש של Addons:</p>
<p><code style="background:#eee;padding:.5rem;display:block;direction:ltr">${base}/manifest.json</code></p>
<p>מנוע תרגום: <b>${MODEL}</b> · מקורות אנגלית: ${UPSTREAMS.length} · מפתח API: ${
          ENV_KEY ? 'מוגדר ✅' : 'חסר ❌'
        }</p></body>`,
        { 'content-type': 'text/html; charset=utf-8' }
      );
    }

    if (parts[0] === 'health') return sendJson(res, { ok: true, model: MODEL, key: !!apiKey });
    if (parts[0] === 'manifest.json') return sendJson(res, manifest(!!token || !!ENV_KEY));

    if (parts[0] === 'sub') return handleSrt(req, res, url);

    if (parts[0] === 'subtitles') {
      // /subtitles/:type/:id.json  or  /subtitles/:type/:id/:extra.json
      const type = parts[1];
      const rest = parts.slice(2).join('/').replace(/\.json$/i, '');
      const segs = rest.split('/');
      const id = decodeURIComponent(segs[0] || '');
      const extra = segs.length > 1 ? segs.slice(1).join('/') : '';
      if (!type || !id) return sendJson(res, { subtitles: [] }, 'no-store');
      return handleSubtitles(req, res, { type, id, extra, apiKey, token });
    }

    // Turn a pasted key into a personal install URL. The key is used to build
    // the token and is never written to disk or to the log.
    if (parts[0] === 'api' && parts[1] === 'url' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return sendJson(res, { error: 'too large' }, 'no-store');
      }
      let key = '';
      try { key = String(JSON.parse(body).key || '').trim(); } catch { /* handled below */ }
      if (key.length < 20) return sendJson(res, { error: 'That does not look like an API key.' }, 'no-store');
      if (!secret.enabled()) {
        return sendJson(res, { error: 'This server has no SECRET set, so it cannot issue links.' }, 'no-store');
      }
      // Check it against Google before handing back a link that cannot work.
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': key },
        });
        if (!r.ok) return sendJson(res, { error: 'Google rejected that key.' }, 'no-store');
      } catch {
        return sendJson(res, { error: 'Could not reach Google to check the key.' }, 'no-store');
      }
      return sendJson(res, { url: `${publicBase(req)}/${secret.seal({ key })}/manifest.json` }, 'no-store');
    }

    if (parts[0] === 'configure') {
      return send(res, 200, configurePage(publicBase(req)), {
        'content-type': 'text/html; charset=utf-8',
      });
    }

    send(res, 404, 'not found');
  } catch (e) {
    log('error:', e.stack || e.message);
    send(res, 500, 'internal error');
  }
});

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

module.exports = server;

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  if (process.env.QUIET) return;
  console.log('');
  console.log('  כתוביות עברית (AI) — Stremio addon');
  console.log('  ----------------------------------');
  console.log(`  מודל:        ${MODEL}`);
  console.log(`  מפתח Gemini: ${ENV_KEY ? 'מוגדר' : '*** חסר — הגדר GEMINI_API_KEY ***'}`);
  console.log('');
  console.log('  התקן בסטרמיו עם הכתובת:');
  console.log(`      http://${ip}:${PORT}/manifest.json     ← לאנדרואיד / Android TV`);
  console.log(`      http://127.0.0.1:${PORT}/manifest.json  ← לאותו מחשב`);
  console.log('');
});
