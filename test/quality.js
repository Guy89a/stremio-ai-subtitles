'use strict';

// The names pass adds one request per episode; it has its own suite
// (test/names.js). Off here so these checks stay about their own subject.
process.env.NAME_GLOSSARY = '0';

// Stub addons run on 127.0.0.1; the server refuses private addresses otherwise.
process.env.ALLOW_PRIVATE_SOURCES = '1';

// The three real-world defects found while watching:
//   1. sentence-final punctuation jumping to the start of the Hebrew line
//   2. second-person gender guessed wrong
//   3. Gemini slipping an Arabic word into Hebrew output

const assert = require('assert');
const srt = require('../src/srt');

const RLE = '‫';
const PDF = '‬';

async function main() {
  // ---- 1. direction marks ------------------------------------------------
  const line = 'בוקר טוב.';
  const marked = srt.rtl(line);
  assert.ok(marked.startsWith(RLE) && marked.endsWith(PDF), 'Hebrew line must be wrapped in an RTL run');
  assert.strictEqual(marked.slice(1, -1), line, 'the text itself must be untouched');
  console.log('✓ Hebrew lines are wrapped in an explicit right-to-left run');

  assert.strictEqual(srt.rtl('Hello there'), 'Hello there', 'pure Latin lines are left alone');
  assert.strictEqual(srt.rtl('♪'), '♪', 'music cues are left alone');
  assert.strictEqual(srt.rtl(''), '', 'empty stays empty');
  console.log('✓ non-Hebrew lines are not touched');

  assert.strictEqual(srt.rtl(srt.rtl(line)), marked, 'wrapping twice must not nest marks');
  console.log('✓ re-wrapping an already marked line is a no-op');

  // a line that STARTS with a neutral is the case that used to break
  const dashed = srt.rtl('- כן, בטח.');
  assert.ok(dashed.startsWith(RLE), 'a line starting with a dash still gets the mark');
  console.log('✓ lines starting with a dash or digit are covered too');

  // ---- 2. foreign script detection ---------------------------------------
  assert.ok(srt.hasForeignScript('הוא אמר مرحبا ואז הלך'), 'Arabic inside Hebrew must be detected');
  assert.ok(srt.hasForeignScript('ﻲ'), 'Arabic presentation forms must be detected');
  assert.ok(!srt.hasForeignScript('שלום עולם'), 'plain Hebrew is fine');
  assert.ok(!srt.hasForeignScript('Netflix, 2026 — בסדר?'), 'Latin, digits and punctuation are fine');
  console.log('✓ Arabic is detected, Hebrew and Latin are not flagged');

  // ---- 3. a contaminated answer must be re-asked, not shipped -------------
  process.env.CHUNK_SIZE = '4';
  process.env.CONCURRENCY = '1';
  process.env.GEMINI_RETRIES = '1';

  let call = 0;
  const prompts = [];
  global.fetch = async (url, opts) => {
    call++;
    const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    prompts.push(prompt);
    const nums = [...prompt.split('TRANSLATE')[1].split('CONTEXT AFTER')[0].matchAll(/^(\d+)\|/gm)]
      .map((m) => Number(m[1]));
    // First answer smuggles an Arabic word into line 2; the retry is clean.
    const reply = nums.map((n) => ({
      n,
      he: call === 1 && n === 2 ? 'הוא אמר مرحبا ואז יצא' : 'שורה ' + n + ' בעברית.',
    }));
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }),
    };
  };

  const { translateCues } = require('../src/translate');
  const text = Array.from({ length: 4 }, (_, i) =>
    `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\nEnglish line ${i + 1}`).join('\n\n');
  const cues = srt.parse(text);
  const out = await translateCues(cues, 'k', (m) => console.log('   ' + m));

  assert.strictEqual(out.length, 4, 'no cue may be lost');
  for (let i = 0; i < 4; i++) assert.strictEqual(out[i].start, cues[i].start, `cue ${i + 1} timing moved`);

  const joined = out.map((c) => c.lines.join(' ')).join('\n');
  assert.ok(!srt.hasForeignScript(joined), 'NO Arabic may survive into the finished subtitles');
  assert.ok(/[֐-׿]/.test(out[1].lines.join('')), 'line 2 must still end up translated');
  console.log('✓ a line that came back with Arabic is re-asked and lands clean');

  assert.ok(prompts.length >= 2, 'a retry should have been issued');
  assert.ok(/Arabic/i.test(prompts[prompts.length - 1]), 'the retry must say what went wrong');
  console.log('✓ the retry explicitly tells the model what it got wrong');

  // ---- 4. the finished file still parses -------------------------------
  const file = srt.serialize(out);
  const round = srt.parse(file);
  assert.strictEqual(round.length, 4, 'the marked file must still parse');
  assert.deepStrictEqual(
    round.map((c) => [c.start, c.end]),
    cues.map((c) => [c.start, c.end]),
    'timings survive the direction marks'
  );
  assert.ok(file.includes(RLE), 'the direction marks reach the file');
  console.log('✓ the finished SRT still parses and keeps every timing');

  // ---- 5. the prompt actually carries the gender instruction -------------
  const sys = JSON.parse(
    (await (async () => {
      let captured;
      global.fetch = async (u, o) => {
        captured = o.body;
        const reply = JSON.stringify([{ n: 1, he: 'איחרת.' }]);
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: reply }] } }] }) };
      };
      await translateCues(srt.parse('1\n00:00:01,000 --> 00:00:02,000\nYou are late'), 'k', () => {});
      return captured;
    })())
  ).systemInstruction.parts[0].text;

  assert.ok(/אתה \/ את \/ אתם/.test(sys), 'the prompt must spell out the Hebrew second-person forms');
  assert.ok(/keep it identical/i.test(sys), 'the prompt must demand consistency across the passage');
  assert.ok(/NEVER output Arabic/i.test(sys), 'the prompt must forbid Arabic outright');
  console.log('✓ the instructions sent to the model cover gender and script');

  console.log('\nall quality checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ ' + (e.stack || e.message)); process.exit(1); });
