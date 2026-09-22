'use strict';

// Stub addons run on 127.0.0.1; the server refuses private addresses otherwise.
process.env.ALLOW_PRIVATE_SOURCES = '1';
// Reference-track alignment, and the rule that a foreign word beats English.
const assert = require('assert');
const srt = require('../src/srt');

async function main() {
  // ---- alignment ---------------------------------------------------------
  const en = srt.parse(
    '1\n00:00:01,000 --> 00:00:04,000\nI told you to wait\n\n' +
    '2\n00:00:05,000 --> 00:00:08,000\nAnd yet here I am\n\n' +
    '3\n00:00:20,000 --> 00:00:22,000\nSit down'
  );
  // the other track splits and shifts, as real tracks do
  const es = srt.parse(
    '1\n00:00:01,300 --> 00:00:02,500\nTe dije\n\n' +
    '2\n00:00:02,600 --> 00:00:03,900\nque esperaras\n\n' +
    '3\n00:00:05,100 --> 00:00:07,800\nY aqui estoy\n\n' +
    '4\n00:00:40,000 --> 00:00:42,000\nNadie dijo nada de eso'
  );

  const { ref, orphans } = srt.alignByTime(en, es);
  assert.strictEqual(ref.length, en.length, 'one reference slot per cue');
  assert.strictEqual(ref[0], 'Te dije que esperaras', 'both overlapping cues are joined in order');
  assert.strictEqual(ref[1], 'Y aqui estoy', 'a shifted cue still matches');
  assert.strictEqual(ref[2], '', 'a cue with no counterpart stays empty');
  console.log('✓ a second track aligns onto the English cues by time');

  assert.strictEqual(orphans.length, 1, 'reference lines with no English cue are reported');
  assert.strictEqual(srt.cueToSource(orphans[0]), 'Nadie dijo nada de eso');
  console.log('✓ reference lines the English track never covered are counted');

  assert.deepStrictEqual(srt.alignByTime(en, []).ref, ['', '', ''], 'an empty track is harmless');
  assert.deepStrictEqual(srt.alignByTime(en, null).ref, ['', '', ''], 'a missing track is harmless');
  console.log('✓ no reference track changes nothing');



  // ---- folding skipped foreign dialogue back in -------------------------
  const en2 = srt.parse(
    '1\n00:00:01,000 --> 00:00:03,000\nHello\n\n' +
    '2\n00:00:10,000 --> 00:00:12,000\nGoodbye'
  );
  const es2 = srt.parse(
    '1\n00:00:01,200 --> 00:00:02,800\nHola\n\n' +
    '2\n00:00:05,000 --> 00:00:07,000\nQue haces aqui\n\n' +
    '3\n00:00:10,100 --> 00:00:11,900\nAdios'
  );
  const al = srt.alignByTime(en2, es2);
  assert.strictEqual(al.orphans.length, 1, 'the untranslated moment is spotted');

  const merged = srt.mergeOrphans(en2, al.ref, al.orphans);
  assert.strictEqual(merged.cues.length, 3, 'the missing line joins the cue list');
  assert.deepStrictEqual(
    merged.cues.map((c) => c.start), [1000, 5000, 10000],
    'and lands in the right place in time'
  );
  assert.strictEqual(merged.cues[1].lines.join(''), '', 'it carries no English');
  assert.strictEqual(merged.refs[1], 'Que haces aqui', 'only the reference text');
  assert.strictEqual(merged.cues[1].fromRef, true, 'and is marked as coming from the reference');
  assert.deepStrictEqual(
    merged.cues.map((c) => c.index), [1, 2, 3], 'the list is renumbered'
  );
  // the original cues must keep their own timings untouched
  assert.strictEqual(merged.cues[0].end, 3000);
  assert.strictEqual(merged.cues[2].end, 12000);
  console.log('✓ dialogue the English track skipped is folded back in, in time order');

  // ---- SDH: who is speaking, and what the viewer should never see --------
  const speakerCases = [
    ['[MARIA] You were right.', 'MARIA', 'You were right.', false],
    ['JOHN: Get in the car.', 'JOHN', 'Get in the car.', false],
    ['MRS. DAVIS: Sit down.', 'MRS. DAVIS', 'Sit down.', false],
    ['[ENGINE REVS] Get down!', '', 'Get down!', false],
    ['[SIRENS WAILING] Run!', '', 'Run!', false],
    ['[door creaks]', '', '', true],
    ['(BIRDS CHIRPING)', '', '', true],
    ['[CAR HORN BLARES]', '', '', true],
    ['She left (whispering) before dawn.', '', 'She left before dawn.', false],
    ['Just a normal line.', '', 'Just a normal line.', false],
  ];
  for (const [raw, speaker, text, soundOnly] of speakerCases) {
    const r = srt.splitSdh(raw);
    assert.strictEqual(r.speaker, speaker, `speaker for ${JSON.stringify(raw)}`);
    assert.strictEqual(r.text, text, `text for ${JSON.stringify(raw)}`);
    assert.strictEqual(r.soundOnly, soundOnly, `soundOnly for ${JSON.stringify(raw)}`);
  }
  console.log('✓ speaker labels are read, sound descriptions are not mistaken for names');

  const sdhTrack = srt.parse(
    '1\n00:00:01,000 --> 00:00:02,000\n[MARIA] Hello\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\nJOHN: Hi there\n\n' +
    '3\n00:00:05,000 --> 00:00:06,000\nplain line'
  );
  const plainTrack = srt.parse(
    '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nHi there'
  );
  assert.ok(srt.sdhScore(sdhTrack) > 0.5, 'an SDH track scores high');
  assert.strictEqual(srt.sdhScore(plainTrack), 0, 'a plain track scores zero');
  console.log('✓ an SDH track can be told apart from a plain one');

  // a sound-only cue must never reach the file
  const withSound = srt.parse(
    '1\n00:00:01,000 --> 00:00:02,000\nReal dialogue\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n[BIRDS RUSTLING]\n\n' +
    '3\n00:00:05,000 --> 00:00:06,000\nMore dialogue'
  );
  const marked = withSound.map((c, i) => (i === 1 ? { ...c, drop: true } : c));
  const file = srt.serialize(marked);
  assert.strictEqual(srt.parse(file).length, 2, 'the sound cue is gone');
  assert.ok(!/RUSTLING/i.test(file), 'and its text with it');
  assert.ok(/^1\n/.test(file) && /\n2\n/.test(file), 'what remains is renumbered');
  console.log('✓ sound-only cues are removed from the finished file and it renumbers');

  // ---- a foreign word is better than an English line ----------------------
  process.env.CHUNK_SIZE = '4';
  process.env.CONCURRENCY = '1';
  process.env.GEMINI_RETRIES = '1';

  global.fetch = async (u, o) => {
    const prompt = JSON.parse(o.body).contents[0].parts[0].text;
    const nums = [...prompt.split('TRANSLATE')[1].split('CONTEXT AFTER')[0].matchAll(/^(\d+)\|/gm)]
      .map((m) => Number(m[1]));
    // line 2 comes back with Arabic every single time
    const reply = nums.map((n) => ({
      n,
      he: n === 2 ? 'הוא אמר مرحبا ואז יצא' : 'שורה ' + n + '.',
    }));
    return { ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) };
  };

  const { translateCues } = require('../src/translate');
  const cues = srt.parse(
    Array.from({ length: 4 }, (_, i) =>
      `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\nEnglish line ${i + 1}`).join('\n\n')
  );
  const out = await translateCues(cues, 'k', () => {});

  const line2 = out[1].lines.join(' ');
  assert.ok(!/English line/.test(line2), 'the line must NOT be left in English');
  assert.ok(/[֐-׿]/.test(line2), 'the Hebrew is kept');
  assert.ok(srt.hasForeignScript(line2), 'and yes - the stray word rides along, by choice');
  console.log('✓ after a failed retry the Hebrew is kept, foreign word and all');

  console.log('\nall reference checks passed');
  process.exit(0);
}
main().catch((e) => { console.error('\n✗ ' + (e.stack || e.message)); process.exit(1); });
