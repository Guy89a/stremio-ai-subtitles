'use strict';

// ---------- SRT / VTT parsing and serialization ----------

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function tcToMs(tc) {
  // supports 00:01:02,345 and 00:01:02.345 and 01:02.345
  const m = tc.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

function msToTc(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = Math.floor(ms % 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(min)}:${p(s)},${p(f, 3)}`;
}

/**
 * Parse an SRT or WebVTT string into cues.
 * @returns {{index:number,start:number,end:number,lines:string[]}[]}
 */
function parse(text) {
  let t = stripBom(String(text)).replace(/\r\n?/g, '\n');
  // Drop a WEBVTT header and NOTE/STYLE blocks if present
  t = t.replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?\n/, '');
  t = t.replace(/^(NOTE|STYLE|REGION)\b[\s\S]*?\n\n/gm, '');

  const blocks = t.split(/\n{2,}/);
  const cues = [];
  let n = 0;

  for (const block of blocks) {
    const raw = block.split('\n').filter((l) => l.trim() !== '');
    if (!raw.length) continue;

    let i = 0;
    // optional numeric counter line
    if (/^\d+$/.test(raw[0].trim()) && raw.length > 1 && raw[1].includes('-->')) i = 1;
    if (!raw[i] || !raw[i].includes('-->')) continue;

    const [a, bRest] = raw[i].split('-->');
    const b = bRest.trim().split(/\s+/)[0]; // drop VTT cue settings
    const start = tcToMs(a);
    const end = tcToMs(b);
    if (start === null || end === null) continue;

    const lines = raw.slice(i + 1);
    if (!lines.length) continue;

    cues.push({ index: ++n, start, end, lines });
  }
  return cues;
}

function serialize(cues) {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${msToTc(c.start)} --> ${msToTc(c.end)}\n${c.lines.join('\n')}`
      )
      .join('\n\n') + '\n'
  );
}

// ---------- text helpers ----------

// Text that carries no translatable dialogue (music notes, dashes, etc.)
function isNonVerbal(s) {
  const bare = s.replace(/[♪♫#*\-–—_.…\s]/g, '');
  return bare === '';
}

// Flatten a cue's lines to a single source string for translation.
function cueToSource(cue) {
  return cue.lines
    .join(' ')
    .replace(/<[^>]+>/g, '')      // strip html-ish tags
    .replace(/\{\\[^}]*\}/g, '')  // strip ASS override tags
    .replace(/\s+/g, ' ')
    .trim();
}

// Re-wrap Hebrew output to at most 2 lines of ~maxLen chars.
function wrap(text, maxLen = 42) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return [t];

  // keep dialogue dashes on their own lines
  if (/^-\s?/.test(t) && t.indexOf(' -', 1) > 0) {
    const cut = t.indexOf(' -', 1);
    return [t.slice(0, cut).trim(), t.slice(cut + 1).trim()];
  }

  const words = t.split(' ');
  let best = null;
  let acc = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i].length + (i ? 1 : 0);
    const diff = Math.abs(acc - (t.length - acc));
    if (best === null || diff < best.diff) best = { i, diff, acc };
  }
  if (!best) return [t];
  const first = words.slice(0, best.i + 1).join(' ');
  const second = words.slice(best.i + 1).join(' ');
  return [first, second];
}

module.exports = { parse, serialize, tcToMs, msToTc, isNonVerbal, cueToSource, wrap };
