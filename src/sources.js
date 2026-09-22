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

async function fetchJson(url, ms = 15000) {
  const ctl = AbortController ? new AbortController() : null;
  const t = ctl && setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl?.signal,
      headers: { 'user-agent': 'stremio-hebrew-subs/1.0' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Ask every configured upstream addon once and return everything they offer. */
async function fetchAll(type, id, extra) {
  const suffix = extra ? `/${extra}` : '';
  const lists = await Promise.all(
    UPSTREAMS.map((base) =>
      fetchJson(`${base}/subtitles/${type}/${encodeURIComponent(id)}${suffix}.json`)
    )
  );

  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const s of list?.subtitles || []) {
      const url = s.url || s.SubDownloadLink;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        id: String(s.id || seen.size),
        url,
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
async function downloadSubtitle(url, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'stremio-hebrew-subs/1.0', 'accept-encoding': 'identity' },
    });
    if (!res.ok) throw new Error(`source responded ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());

    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf);
    else if (buf[0] === 0x78) {
      try {
        buf = await inflate(buf);
      } catch {
        /* not zlib after all */
      }
    }
    return decode(buf);
  } finally {
    clearTimeout(t);
  }
}

module.exports = { findEnglishSubtitles, fetchAll, pickLang, downloadSubtitle, UPSTREAMS };
