'use strict';

const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);

// Upstream Stremio subtitle addons to pull the English subtitles from.
// Any addon that speaks the Stremio subtitles protocol works here.
const UPSTREAMS = (process.env.UPSTREAM_ADDONS ||
  'https://opensubtitles-v3.strem.io')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const ENGLISH = new Set(['eng', 'en', 'english', 'en-us', 'en-gb', 'eng-us']);

function isEnglish(lang) {
  if (!lang) return false;
  const l = String(lang).toLowerCase().trim();
  return ENGLISH.has(l) || l.startsWith('english');
}

// Nothing we fetch is big. Caps stop a hostile or broken source from being
// read into memory until the instance dies.
const MAX_JSON = parseInt(process.env.MAX_JSON_BYTES || '4000000', 10);
const MAX_SUB = parseInt(process.env.MAX_SUBTITLE_BYTES || '2000000', 10);

/** Read a response body, aborting as soon as it goes past `limit` bytes. */
async function readCapped(res, limit) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error('source is too large');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) {
      try { await res.body.cancel(); } catch { /* already closed */ }
      throw new Error('source is too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Only ordinary web addresses, and never one that points back at the machine
// we are running on or at a private network behind it.
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.|.*\.local$|.*\.internal$)/i;

// The test suites run stub addons on 127.0.0.1 and need to reach them.
// Nothing else should ever turn this on.
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_SOURCES === '1';

function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('not a valid address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http and https sources are allowed');
  }
  if (!ALLOW_PRIVATE && PRIVATE_HOST.test(u.hostname)) {
    throw new Error('address is not reachable');
  }
  return u.toString();
}

async function fetchJson(url, ms = 15000) {
  const ctl = AbortController ? new AbortController() : null;
  const t = ctl && setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl?.signal,
      headers: { 'user-agent': 'stremio-hebrew-subs/1.0' },
    });
    if (!res.ok) return null;
    return JSON.parse((await readCapped(res, MAX_JSON)).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

// Upstream addons are third parties. Treat every field as hostile.
function sanitizeList(list) {
  const subs = list && list.subtitles;
  if (!Array.isArray(subs)) return [];
  return subs.filter((s) => s && typeof s === 'object' && !Array.isArray(s));
}

/** Ask every configured upstream addon once and return everything they offer. */
const seg = (s) => encodeURIComponent(String(s));

async function fetchAll(type, id, extra) {
  // Every segment is encoded: an unencoded one lets a caller walk the upstream
  // host's path with "..".
  const suffix = extra
    ? '/' + String(extra).split('/').filter(Boolean).map(seg).join('/')
    : '';
  const lists = await Promise.all(
    UPSTREAMS.map((base) => fetchJson(`${base}/subtitles/${seg(type)}/${seg(id)}${suffix}.json`))
  );

  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const s of sanitizeList(list)) {
      const url = s.url || s.SubDownloadLink;
      if (typeof url !== 'string' || !url || seen.has(url)) continue;
      // A hostile upstream could hand back file:// or an intranet address.
      let safe;
      try { safe = assertSafeUrl(url); } catch { continue; }
      seen.add(url);
      out.push({
        id: String(s.id || seen.size),
        url: safe,
        lang: String(s.lang || s.SubLanguageID || '').toLowerCase().trim(),
      });
    }
  }
  return out;
}

/** Keep only the entries whose language matches any of `codes`. */
function pickLang(all, codes) {
  const want = codes.map((c) => c.toLowerCase());
  return (all || []).filter((s) =>
    want.some((c) => s.lang === c || s.lang.startsWith(c + '-') || s.lang.startsWith(c))
  );
}

async function findEnglishSubtitles(type, id, extra) {
  return (await fetchAll(type, id, extra)).filter((s) => isEnglish(s.lang));
}

function decode(buf) {
  // Most subs are UTF-8; a stubborn minority are Windows-1255/1252.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Download a subtitle file, transparently handling gzip/deflate bodies.
 */
// Checking only the first address is not enough: a redirect is an address the
// source picks for us, so every hop gets the same test.
async function fetchFollowing(url, signal, maxHops = 5) {
  let next = assertSafeUrl(url);
  for (let i = 0; i <= maxHops; i++) {
    const res = await fetch(next, {
      signal,
      redirect: 'manual',
      headers: { 'user-agent': 'stremio-hebrew-subs/1.0', 'accept-encoding': 'identity' },
    });
    if (res.status < 300 || res.status > 399 || !res.headers.get('location')) return res;
    next = assertSafeUrl(new URL(res.headers.get('location'), next).toString());
  }
  throw new Error('too many redirects');
}

async function downloadSubtitle(url, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchFollowing(url, ctl.signal);
    if (!res.ok) throw new Error(`source responded ${res.status}`);
    let buf = await readCapped(res, MAX_SUB);

    // maxOutputLength is the whole point here: a 60 KB gzip can expand to
    // gigabytes, and on a 512 MB instance that is the end of the process.
    const limit = { maxOutputLength: MAX_SUB };
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf, limit);
    else if (buf[0] === 0x78) {
      try {
        buf = await inflate(buf, limit);
      } catch {
        /* not zlib after all */
      }
    }
    if (buf.length > MAX_SUB) throw new Error('source is too large');
    return decode(buf);
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  findEnglishSubtitles, fetchAll, pickLang, downloadSubtitle, assertSafeUrl, UPSTREAMS,
};
