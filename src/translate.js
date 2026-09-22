'use strict';

const { cueToSource, isNonVerbal, wrap, rtl, hasForeignScript, splitSdh } = require('./srt');

// GEMINI_MODEL may be a comma-separated list: the first that answers wins, and
// the rest act as fallbacks when a model is overloaded (503) or rate-limited.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-flash-lite-latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODEL = MODELS.join(' → ');
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRIES = parseInt(process.env.GEMINI_RETRIES || '6', 10);
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

// How many timed cues go into one request, and how many neighbouring cues
// are shown as read-only context on each side of the chunk.
const CHUNK = parseInt(process.env.CHUNK_SIZE || '120', 10);
const CONTEXT = parseInt(process.env.CONTEXT_CUES || '12', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

const SYSTEM = `You are a professional subtitle translator working from English into modern, natural Hebrew.

HOW TO WORK — this order matters:
1. First READ THE WHOLE PASSAGE you are given as one continuous piece of dialogue. Subtitle lines are cut by screen timing, not by sentence, so a single sentence is often split across several numbered lines and a line on its own is frequently meaningless or misleading.
2. Understand the passage as a whole: who is speaking, what the sentence actually means, idioms, running jokes, pronoun antecedents, callbacks to the CONTEXT lines.
3. Only THEN produce the Hebrew, and redistribute that Hebrew back across the SAME numbered lines, so that the Hebrew appearing on screen at line N matches what is being said during line N's moment.

RULES:
- Output exactly one entry for every numbered line in the TRANSLATE block — same numbers, none added, none skipped, none merged.
- NEVER translate a line in isolation when it is part of a longer sentence. Translate the sentence, then split the Hebrew across its lines at a natural point, following Hebrew word order — not English word order.
- Hebrew is shorter than English: prefer tight, spoken phrasing. Keep each line roughly the length of its English source so reading speed matches the picture.
- Natural spoken Hebrew, not literal word-for-word. Translate idioms to their Hebrew equivalent in meaning and register, never literally.
- Keep the register and tone of each speaker: slang stays slang, formal stays formal, rudeness stays rude.
- Keep a leading "- " dialogue dash when the source line has one (two speakers in one line keep both dashes).
- Keep ♪ around song/music lines; keep proper names, brands and numbers as-is unless a Hebrew form is standard.
- Sound descriptions such as [door creaks] have already been removed before you see the text; do not invent any.
- Do not add explanations, notes, transliterations or quotation marks that are not in the source.
- Never output English text except for names/brands that stay in Latin script.
- If a line has no translatable words (music notes, dashes only), return it unchanged.
- CONTEXT lines are for understanding only. Do not return them.

SECOND PERSON — Hebrew forces a choice English does not:
- English "you" carries no gender and no number. Hebrew does: אתה / את / אתם / אתן, and every verb, adjective and possessive agrees with it. You MUST decide, every single time.
- Work it out from the passage: who is speaking to whom, names used, how other characters refer to them, and the CONTEXT lines around the block. A crowd or a group is אתם, not אתה.
- Once you have decided a character's gender, keep it identical for the rest of the passage. A character who is את in one line and אתה three lines later is the most jarring mistake you can make.
- The same applies to first person plural, to "they", and to a narrator addressing the viewer.
- Only when the passage genuinely gives you nothing, choose the reading that fits the scene best and stay consistent with it - never alternate.

SCRIPT — Hebrew letters only:
- Every translated word must be in Hebrew script, except proper names and brands that stay in Latin letters, plus digits and punctuation.
- NEVER output Arabic, Persian, Cyrillic or any other script. Not a single word, not a single character. If a term feels foreign, write it in Hebrew letters instead.`;

const STRIP_SOUND = process.env.KEEP_SOUND_CUES !== '1';

// Added only when the source track actually names its speakers.
const SDH_RULES = `

SPEAKER NAMES ARE MARKED:
- A line beginning with <NAME> tells you who says it. This is metadata, NOT part of the dialogue - never translate it and never include it in your answer.
- Use it to follow the turn-taking. The person being addressed is normally whoever spoke the previous turn, which is what decides אתה vs את.
- Names are also your best evidence for a character's gender. Once a name tells you, apply it everywhere that character is spoken to or about.`;

const REF_LABEL = (process.env.REFERENCE_LANG || 'ref').toUpperCase();

// Added to the system prompt only when a reference track is actually present.
const REF_RULES = `

A SECOND TRANSLATION IS PROVIDED:
- Some lines carry a [${REF_LABEL}] line underneath: the same moment as translated by a professional into another language.
- Use it to settle what English leaves open - above all WHO IS BEING ADDRESSED and their gender and number, which that language marks and English does not. Its grammar is evidence; follow it.
- It also disambiguates pronouns, formality, and any line whose English is ambiguous on its own.
- Translate the ENGLISH line. The reference is evidence about meaning, never the text to translate. Where the two disagree on wording, the English wins; where they disagree on who is being addressed, the reference wins.
- Where the English line is missing or empty but the reference is not, the English track simply did not translate that moment. Translate it from the reference.`;

function buildPrompt(chunk, before, after) {
  const fmt = (arr) =>
    arr
      .map((c) => {
        const who = c.speaker ? `<${c.speaker}> ` : '';
        const head = `${c.n}| ${who}${c.text}`;
        return c.ref ? `${head}\n   [${REF_LABEL}] ${c.ref}` : head;
      })
      .join('\n');
  let p = '';
  if (before.length) p += `CONTEXT BEFORE (do not translate):\n${fmt(before)}\n\n`;
  p += `TRANSLATE (return exactly these ${chunk.length} numbered lines, in Hebrew):\n${fmt(chunk)}\n`;
  if (after.length) p += `\nCONTEXT AFTER (do not translate):\n${fmt(after)}\n`;
  return p;
}

async function callGemini(apiKey, prompt, { temperature = 0.3, retries = RETRIES, log, withRef = false, withSpk = false } = {}) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + (withRef ? REF_RULES : '') + (withSpk ? SDH_RULES : '') }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { n: { type: 'INTEGER' }, he: { type: 'STRING' } },
          required: ['n', 'he'],
        },
      },
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Google sometimes tells us exactly how long to wait; prefer that.
  const retryDelayMs = (txt) => {
    const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt || '');
    return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
  };

  let lastErr;
  // Walk the model list; each model gets the full retry budget before we
  // fall through to the next one.
  for (const model of MODELS) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          if (RETRYABLE.has(res.status)) {
            throw Object.assign(
              new Error(`gemini ${model} ${res.status}: ${txt.slice(0, 160)}`),
              { status: res.status, wait: retryDelayMs(txt) }
            );
          }
          // 400/401/403/404 will not improve by waiting — move to next model.
          throw Object.assign(
            new Error(`gemini ${model} ${res.status}: ${txt.slice(0, 240)}`),
            { nextModel: true }
          );
        }
        const json = await res.json();
        const text = (json.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || '')
          .join('');
        if (!text) throw new Error('empty response from gemini');
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        if (e.nextModel) break;
        if (attempt === retries - 1) break;
        // 2s, 5s, 11s, 23s, 47s … capped at 60s, plus jitter.
        const backoff = Math.min(60000, 2000 * 2 ** attempt + Math.random() * 1000);
        const waitMs = Math.max(e.wait || 0, backoff);
        log?.(`  ⏳ ${e.message.slice(0, 90)} — waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }
    if (MODELS.length > 1) log?.(`  ↪ giving up on ${model}, trying next model`);
  }
  throw lastErr;
}

async function translateChunk(apiKey, chunk, before, after, log) {
  const want = new Set(chunk.map((c) => c.n));
  const out = new Map();
  const withRef = chunk.some((c) => c.ref) || before.some((c) => c.ref) || after.some((c) => c.ref);
  const withSpk = chunk.some((c) => c.speaker) || before.some((c) => c.speaker);

  // Lines that came back with Arabic in them are held aside rather than
  // thrown away: we ask for them again, but if the second try is no better
  // we still prefer slightly-contaminated Hebrew over an English line.
  const quarantine = new Map();

  const absorb = (arr, strict) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const n = Number(item?.n);
      const he = typeof item?.he === 'string' ? item.he.trim() : '';
      if (!want.has(n) || !he || out.has(n)) continue;
      if (strict && hasForeignScript(he)) { quarantine.set(n, he); continue; }
      out.set(n, he);
    }
  };

  absorb(await callGemini(apiKey, buildPrompt(chunk, before, after), { log, withRef, withSpk }), true);

  // Retry whatever came back missing or in the wrong script, once.
  const missing = chunk.filter((c) => !out.has(c.n));
  if (missing.length) {
    const bad = quarantine.size;
    log(`  ↻ ${missing.length} lines to redo${bad ? ` (${bad} had non-Hebrew script)` : ''}`);
    const note = bad
      ? '\nThe previous attempt returned Arabic characters. Hebrew script only this time.\n'
      : '';
    absorb(
      await callGemini(
        apiKey,
        buildPrompt(missing, before.concat(chunk.slice(0, 6)), after) + note,
        { temperature: 0.1, log, withRef, withSpk }
      ),
      false // take what we get this time
    );
  }

  // Anything still unanswered falls back to the quarantined attempt.
  let salvaged = 0;
  for (const [n, he] of quarantine) {
    if (!out.has(n)) { out.set(n, he); salvaged++; }
  }
  if (salvaged) log(`  ~ ${salvaged} line(s) kept with a foreign word rather than left in English`);

  return out;
}

// A chunk can fail wholesale when one line inside it trips Gemini's content
// filter. Rather than abandoning all of it, split and retry: only the small
// stretch that actually trips the filter ends up staying in English.
const MIN_SPLIT = parseInt(process.env.MIN_SPLIT || '8', 10);

async function bisect(apiKey, chunk, before, after, log, label) {
  try {
    return await translateChunk(apiKey, chunk, before, after, log);
  } catch (e) {
    if (chunk.length <= MIN_SPLIT) {
      log(`  ! ${label}: ${chunk.length} lines could not be translated - left in English`);
      return new Map();
    }
    const mid = Math.ceil(chunk.length / 2);
    const a = chunk.slice(0, mid);
    const b = chunk.slice(mid);
    log(`  > ${label} failed (${e.message.slice(0, 50)}) - splitting ${chunk.length} into ${a.length}+${b.length}`);
    const ra = await bisect(apiKey, a, before, b.slice(0, CONTEXT).concat(after), log, label + '.1');
    const rb = await bisect(apiKey, b, before.concat(a.slice(-CONTEXT)), after, log, label + '.2');
    const out = new Map(ra);
    for (const [k, v] of rb) out.set(k, v);
    return out;
  }
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Translate parsed cues to Hebrew, keeping every original timing untouched.
 * @param {object[]} cues  from srt.parse()
 * @param {string} apiKey  Gemini API key
 * @param {function} [onLog]
 * @returns {Promise<object[]>} new cues with Hebrew lines
 */
async function translateCues(cues, apiKey, onLog, refs, speakers) {
  const log = onLog || (() => {});

  // Only cues with actual words go to the model. A cue whose English is empty
  // but whose reference track has text still counts - that is exactly the
  // foreign-dialogue case the English track skipped.
  const items = cues.map((c, i) => {
    const own = splitSdh(cueToSource(c), { stripSound: STRIP_SOUND });
    const ref = (refs && refs[i]) || '';
    return {
      n: i + 1,
      text: own.text,
      speaker: own.speaker || (speakers && speakers[i]) || '',
      ref,
      // A cue that was only a sound description has nothing left to show.
      drop: own.soundOnly && !ref,
    };
  });
  const dropped = items.filter((it) => it.drop).length;
  if (dropped) log(`${dropped} sound-only cue(s) removed`);
  const verbal = items.filter(
    (it) => !it.drop && ((it.text && !isNonVerbal(it.text)) || (it.ref && !isNonVerbal(it.ref)))
  );
  const named = verbal.filter((it) => it.speaker).length;
  if (named) log(`speaker names on ${named}/${verbal.length} lines`);
  const withRefCount = verbal.filter((it) => it.ref).length;
  if (withRefCount) log(`reference track covers ${withRefCount}/${verbal.length} lines`);

  const chunks = [];
  for (let i = 0; i < verbal.length; i += CHUNK) chunks.push(verbal.slice(i, i + CHUNK));
  log(`translating ${verbal.length} lines in ${chunks.length} chunk(s) with ${MODEL}`);

  const tasks = chunks.map((chunk, ci) => async () => {
    const startIdx = ci * CHUNK;
    const before = verbal.slice(Math.max(0, startIdx - CONTEXT), startIdx);
    const after = verbal.slice(startIdx + chunk.length, startIdx + chunk.length + CONTEXT);
    log(`  → chunk ${ci + 1}/${chunks.length} (lines ${chunk[0].n}–${chunk[chunk.length - 1].n})`);
    return bisect(apiKey, chunk, before, after, log, 'chunk ' + (ci + 1));
  });

  const maps = await pool(tasks, CONCURRENCY);
  const he = new Map();
  for (const m of maps) for (const [k, v] of m) he.set(k, v);

  const dropSet = new Set(items.filter((it) => it.drop).map((it) => it.n));
  let translated = 0;
  const result = cues.map((c, i) => {
    const n = i + 1;
    if (dropSet.has(n)) return { ...c, lines: c.lines.slice(), drop: true };
    const t = he.get(n);
    if (!t) return { ...c, lines: c.lines.slice() }; // non-verbal or failed → keep source
    translated++;
    return { ...c, lines: wrap(t).map(rtl) };
  });

  log(`done: ${translated}/${verbal.length} lines translated`);
  if (verbal.length && translated / verbal.length < 0.5) {
    throw new Error(`translation mostly failed (${translated}/${verbal.length})`);
  }
  return result;
}

module.exports = { translateCues, MODEL };
