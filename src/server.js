'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const srt = require('./srt');
const secret = require('./secret');
const { translateCues, MODEL } = require('./translate');
const { fetchAll, pickLang, downloadSubtitle, UPSTREAMS } = require('./sources');

const PORT = parseInt(process.env.PORT || '7788', 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache');
const MAX_SOURCES = parseInt(process.env.MAX_SOURCES || '2', 10);
const ENV_KEY = process.env.GEMINI_API_KEY || '';

// Optional: a second subtitle track in a language that marks gender and number,
// shown to the model alongside the English as evidence. Empty = off.
const REF_LANG = (process.env.REFERENCE_LANG || '').toLowerCase().trim();
// Fold in dialogue the English track skipped entirely (characters speaking
// another language). Only possible when a reference track is configured.
const FILL_GAPS = process.env.FILL_FOREIGN_GAPS !== '0';
const REF_ALIASES = {
  spa: ['spa', 'es', 'spanish'], por: ['por', 'pt', 'portuguese'],
  fre: ['fre', 'fra', 'fr', 'french'], ita: ['ita', 'it', 'italian'],
  rus: ['rus', 'ru', 'russian'], ger: ['ger', 'deu', 'de', 'german'],
  pol: ['pol', 'pl', 'polish'],
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- job runner

const jobs = new Map(); // cacheKey -> Promise<string>

function cacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}
const cachePath = (key) => path.join(CACHE_DIR, `${key}.srt`);

// Every .srt link this server hands out is signed. Without that, /sub is an
// open door: anyone could name any address as the source, have the server
// fetch it and translate it on the operator's Gemini quota, and plant the
// result under a cache name a real viewer would later ask for.
const SIGN_KEY =
  (process.env.SECRET || '').length >= 16
    ? crypto.createHash('sha256').update('url-signing|' + process.env.SECRET).digest()
    : crypto.randomBytes(32); // no SECRET: links last as long as this process

const sign = (src, ref) =>
  crypto.createHmac('sha256', SIGN_KEY).update(`${src}|${ref || ''}`).digest('base64url').slice(0, 22);

function signOk(src, ref, sig) {
  const want = Buffer.from(sign(src, ref));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// One instance on the free plan has 512 MB and one CPU. A translation holds a
// whole parsed episode in memory and can sit in backoff for minutes, so the
// number that may run at once is capped rather than left to the caller.
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '3', 10);

function readCache(key) {
  try {
    const p = cachePath(key);
    const body = fs.readFileSync(p, 'utf8');
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

// Try the other English candidates until one turns out to be an SDH track
// (the kind that names its speakers). Subtitle files are tiny, so a couple of
// extra downloads cost nothing next to what we learn from them.
async function findSpeakers(cues, altUrls, log) {
  for (const u of (altUrls || []).slice(0, 3)) {
    try {
      const alt = srt.parse(await downloadSubtitle(u));
      const score = srt.sdhScore(alt);
      if (score < 0.02) continue;
      const { ref } = srt.alignByTime(cues, alt);
      const speakers = ref.map((t) => srt.splitSdh(t, { stripSound: false }).speaker);
      const named = speakers.filter(Boolean).length;
      log(`SDH track found (${Math.round(score * 100)}% labelled) - ${named} lines attributed`);
      return speakers;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

async function buildHebrew(key, sourceUrl, apiKey, refUrl, altUrls) {
  const cached = readCache(key);
  if (cached) return cached;
  if (jobs.has(key)) return jobs.get(key);
  if (jobs.size >= MAX_JOBS) throw new Error('busy - too many translations in flight');

  const job = (async () => {
    log(`[${key}] downloading ${sourceUrl.slice(0, 90)}`);
    const text = await downloadSubtitle(sourceUrl);
    const cues = srt.parse(text);
    if (!cues.length) throw new Error('could not parse the source subtitle file');
    log(`[${key}] parsed ${cues.length} cues`);

    // Optional second language, used as evidence about meaning - and, where
    // the English track skipped a line entirely, as the source for it.
    let refs;
    let work = cues;
    if (refUrl) {
      try {
        const refCues = srt.parse(await downloadSubtitle(refUrl));
        const aligned = srt.alignByTime(cues, refCues);
        refs = aligned.ref;
        log(`[${key}] ${REF_LANG} reference: ${refCues.length} cues, ${aligned.orphans.length} with no English counterpart`);
        if (FILL_GAPS && aligned.orphans.length) {
          const merged = srt.mergeOrphans(cues, aligned.ref, aligned.orphans);
          work = merged.cues;
          refs = merged.refs;
          log(`[${key}] filled in ${aligned.orphans.length} line(s) the English track skipped`);
        }
      } catch (e) {
        log(`[${key}] reference track unavailable (${e.message}) - continuing without it`);
      }
    }

    // Speaker names: from this track if it is already SDH, otherwise from a
    // sibling English track that is.
    let speakers;
    const own = srt.sdhScore(work);
    if (own >= 0.02) {
      log(`[${key}] source already names speakers (${Math.round(own * 100)}%)`);
    } else if (altUrls && altUrls.length) {
      speakers = await findSpeakers(work, altUrls, (m) => log(`[${key}] ${m}`));
    }

    const translated = await translateCues(
      work, apiKey, (m) => log(`[${key}] ${m}`), refs, speakers
    );

    // Every cue keeps the timing it arrived with — English or reference.
    for (let i = 0; i < work.length; i++) {
      if (translated[i].start !== work[i].start || translated[i].end !== work[i].end) {
        throw new Error('internal: timing drift detected');
      }
    }

    const out = '﻿' + srt.serialize(translated);
    fs.writeFileSync(cachePath(key), out, 'utf8');
    log(`[${key}] cached ${work.length} cues`);
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
    version: '1.5.1',
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

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Both of these headers are set by whatever sits in front of us, and a caller
// can send them too. Anything that is not host-shaped is discarded rather than
// echoed back into a URL or a page.
function publicBase(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  const host = /^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(raw) ? raw : 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    ? 'https'
    : 'http';
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
// A ceiling for the whole deployment, so no combination of callers can empty
// the operator's Gemini quota in an afternoon.
const GLOBAL_PER_DAY = parseInt(process.env.RATE_LIMIT_TOTAL || String(RATE_PER_DAY * 5), 10);
const buckets = new Map(); // caller id -> { day, episodes:Set }
let global_ = { day: -1, episodes: new Set() };

// Who is asking. A sealed token identifies a person; without one the best we
// have is the address. The earlier version only counted token holders, which
// meant a deployment with its own key counted nobody at all.
function callerId(req, token) {
  if (token) return 'k:' + secret.fingerprint(token);
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return 'ip:' + (fwd || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function withinRate(id, episodeKey) {
  if (RATE_PER_DAY <= 0) return true;
  const day = Math.floor(Date.now() / 86400000);

  if (global_.day !== day) {
    global_ = { day, episodes: new Set() };
    buckets.clear(); // yesterday's callers are not worth remembering
  }

  let b = buckets.get(id);
  if (!b || b.day !== day) {
    b = { day, episodes: new Set() };
    buckets.set(id, b);
  }
  if (b.episodes.has(episodeKey)) return true; // already counted today

  if (b.episodes.size >= RATE_PER_DAY) return false;
  if (global_.episodes.size >= GLOBAL_PER_DAY && !global_.episodes.has(episodeKey)) return false;

  b.episodes.add(episodeKey);
  global_.episodes.add(episodeKey);
  return true;
}

async function handleSubtitles(req, res, { type, id, extra, apiKey, token }) {
  if (!apiKey) return sendJson(res, { subtitles: [] }, 'no-store');

  const all = await fetchAll(type, id, extra);
  const english = pickLang(all, ['eng', 'en']);
  const sources = english.slice(0, MAX_SOURCES);
  const refUrl = REF_LANG
    ? (pickLang(all, REF_ALIASES[REF_LANG] || [REF_LANG])[0] || {}).url
    : undefined;
  log(`subtitles ${type}/${id} → ${sources.length} english source(s)${refUrl ? `, ${REF_LANG} reference found` : ''}`);
  if (!sources.length) return sendJson(res, { subtitles: [] }, 'no-store');

  const base = publicBase(req);
  const who = callerId(req, token);
  const subtitles = [];
  for (const [i, s] of sources.entries()) {
    const key = cacheKey(s.url + '|' + (refUrl || ''));
    if (!readCache(key) && !withinRate(who, key)) {
      log(`rate limit reached for ${who} - skipping`);
      break;
    }
    // Warm the cache now so the file is usually ready the moment it is picked.
    buildHebrew(key, s.url, apiKey, refUrl, english.filter((o) => o.url !== s.url).map((o) => o.url)).catch(() => {});
    // The key itself never travels here: on a public server `token` is the
    // sealed blob, and on a local one the key already lives in the env.
    const carry = token ? `&c=${encodeURIComponent(token)}` : '';
    subtitles.push({
      // Same language code for every candidate. A distinct code such as
      // "heb-2" makes the player list a second, separate Hebrew entry;
      // sharing "heb" keeps them together under one Hebrew heading, the way
      // an upstream addon offering several English tracks behaves.
      id: `he-ai-${i + 1}-${key}`,
      url:
        `${base}/sub/${key}.srt?src=${encodeURIComponent(s.url)}` +
        (refUrl ? `&ref=${encodeURIComponent(refUrl)}` : '') +
        `&s=${sign(s.url, refUrl)}${carry}`,
      lang: 'heb',
    });
  }

  sendJson(res, { subtitles }, 'no-store');
}

async function handleSrt(req, res, url) {
  const key = path.basename(url.pathname).replace(/\.srt$/i, '');
  const src = url.searchParams.get('src');
  const ref = url.searchParams.get('ref') || undefined;
  const carried = url.searchParams.get('c');
  const cfg = carried ? decodeConfig(carried) : null;
  const apiKey = (cfg && cfg.key) || ENV_KEY;

  const headers = {
    'content-type': 'application/x-subrip; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  };

  // Something already translated and vetted is safe to serve as-is.
  const cached = readCache(key);
  if (cached) return send(res, 200, cached, headers);
  if (!src || !apiKey) return send(res, 404, 'not found');

  // Two checks, and both have to pass before anything is fetched.
  //  - the signature proves this server issued the link, so the source cannot
  //    be swapped for an address of the caller's choosing;
  //  - the name must be the one this source hashes to, so nothing can be
  //    stored under a name that belongs to a different episode.
  if (!signOk(src, ref, url.searchParams.get('s'))) return send(res, 404, 'not found');
  if (key !== cacheKey(`${src}|${ref || ''}`)) return send(res, 404, 'not found');

  const who = callerId(req, carried || null);
  if (!withinRate(who, key)) {
    return send(res, 429, 'daily limit reached', { 'content-type': 'text/plain' });
  }

  try {
    const body = await buildHebrew(key, src, apiKey, ref);
    send(res, 200, body, headers);
  } catch (e) {
    // The detail goes to the log, not to the caller: distinct messages told an
    // outsider the difference between a closed port and a refused request.
    log('srt error:', e.message);
    send(res, 502, 'translation failed', { 'content-type': 'text/plain' });
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
  if (parts.length && !RESERVED.includes(parts[0].toLowerCase())) {
    const cfg = decodeConfig(parts[0]);
    if (cfg && cfg.key) {
      apiKey = cfg.key;
      token = parts[0];
      parts.shift();
    } else {
      // An unreadable first segment is not a route prefix. Consuming it anyway
      // gave every endpoint unlimited aliases.
      return send(res, 404, 'not found');
    }
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
<p><code style="background:#eee;padding:.5rem;display:block;direction:ltr">${escapeHtml(base)}/manifest.json</code></p>
<p>מנוע תרגום: <b>${escapeHtml(MODEL)}</b> · מקורות אנגלית: ${UPSTREAMS.length} · מפתח API: ${
          ENV_KEY ? 'מוגדר ✅' : 'חסר ❌'
        }</p></body>`,
        { 'content-type': 'text/html; charset=utf-8' }
      );
    }

    if (parts[0] === 'health') return sendJson(res, { ok: true, model: MODEL, key: !!apiKey });
    if (parts[0] === 'manifest.json') return sendJson(res, manifest(!!token || !!ENV_KEY));

    // Awaited, not just returned: an un-awaited rejection here escapes the
    // catch below and, on current Node, takes the whole process down.
    if (parts[0] === 'sub') return await handleSrt(req, res, url);

    if (parts[0] === 'subtitles') {
      // /subtitles/:type/:id.json  or  /subtitles/:type/:id/:extra.json
      const type = parts[1];
      const rest = parts.slice(2).join('/').replace(/\.json$/i, '');
      const segs = rest.split('/');
      const id = decodeURIComponent(segs[0] || '');
      const extra = segs.length > 1 ? segs.slice(1).join('/') : '';
      if (!type || !id) return sendJson(res, { subtitles: [] }, 'no-store');
      return await handleSubtitles(req, res, { type, id, extra, apiKey, token });
    }

    // Turn a pasted key into a personal install URL. The key is used to build
    // the token and is never written to disk or to the log.
    if (parts[0] === 'api' && parts[1] === 'url' && req.method === 'POST') {
      // A deployment with its own key is not a sign-up service. Leaving this
      // open meant hosting a key-entry form nobody asked for, and a free
      // "is this Google key valid?" oracle running from this server's address.
      if (ENV_KEY) return send(res, 404, 'not found');
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
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': key },
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        if (!r.ok) return sendJson(res, { error: 'Google rejected that key.' }, 'no-store');
      } catch {
        return sendJson(res, { error: 'Could not reach Google to check the key.' }, 'no-store');
      }
      return sendJson(res, { url: `${publicBase(req)}/${secret.seal({ key })}/manifest.json` }, 'no-store');
    }

    if (parts[0] === 'configure') {
      if (ENV_KEY) return send(res, 404, 'not found');
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

// A subtitle addon is not worth taking the process down for. Anything that
// slips past a handler is logged and the service keeps answering - otherwise
// one malformed reply from an upstream addon becomes a restart loop.
process.on('unhandledRejection', (e) => log('unhandled rejection:', (e && e.stack) || e));
process.on('uncaughtException', (e) => log('uncaught exception:', (e && e.stack) || e));

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
