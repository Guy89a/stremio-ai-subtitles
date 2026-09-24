'use strict';

// Stub addons run on 127.0.0.1; the server refuses private addresses otherwise.
process.env.ALLOW_PRIVATE_SOURCES = '1';

// "Billy the Kid" came back from a real episode as a name plus a translated
// word. These checks cover the fix: names are collected locally, settled once
// for the whole episode, and handed to every chunk.

const assert = require('assert');
const { extractNames } = require('../src/names');
const srt = require('../src/srt');
const langs = require('../src/languages');

const LINES = [
  'Maria, you left the door open again.',
  'Good evening. Are you Mrs. Alvarez?',
  'Detective Rowe. May I come in for a moment?',
  'Of course, officer. Please, sit down.',
  'Dr. Chen called again about the results.',
  'They say he is the next Billy the Kid.',
  'Billy the Kid never made it to thirty.',
  'And Billy? What about Billy the Kid?',
  'Maria went to New Orleans last spring.',
  'But Sarah told me otherwise.',
  'Then Sarah left. She always does.',
  'Sarah works for the Hudson Bay Company.',
  'Maria, listen to me. This is serious.',
];

async function main() {
  // ---- 1. the names that matter are found ------------------------------
  const names = extractNames(LINES).map((n) => n.name);
  for (const want of ['Billy the Kid', 'Maria', 'Sarah', 'Detective Rowe',
    'Dr. Chen', 'Mrs. Alvarez', 'New Orleans', 'Hudson Bay Company']) {
    assert.ok(names.includes(want), `missed the name "${want}"`);
  }
  console.log(`✓ found all ${names.length} names, titles and places included`);

  // ---- 2. an epithet stays attached to its name -------------------------
  // This is the whole point: if "Billy" were listed on its own, the glossary
  // would fix the first word and leave "the Kid" loose again.
  assert.ok(names.includes('Billy the Kid'), 'the epithet must stay attached');
  assert.ok(!names.includes('Billy'), '"Billy" alone must not shadow "Billy the Kid"');
  assert.ok(!names.includes('Rowe'), '"Rowe" is covered by "Detective Rowe"');
  console.log('✓ an epithet is kept as one name, and the bare name does not compete');

  // ---- 3. a capitalised sentence start is not a name --------------------
  for (const notName of ['And Billy', 'But Sarah', 'Then Sarah', 'Good evening', 'Of course']) {
    assert.ok(!names.includes(notName), `"${notName}" is a sentence start, not a name`);
  }
  console.log('✓ a word capitalised only because a sentence starts is ignored');

  // ---- 3b. commands at the start of a line are not names -----------------
  // A false entry here is not harmless: "Listen" fixed to one form would
  // force one gender onto every "listen" in the episode.
  {
    const traps = extractNames([
      'Listen, Maria. Listen to me.', 'Tell Maria I said so.', 'Call Dr. Chen now.',
      'Look, it is late.', 'Look at this, Maria.', 'Wait here.',
      'Wait for me, Detective Rowe.', 'Listen, I know.',
    ]).map((n) => n.name);
    for (const bad of ['Listen', 'Look', 'Wait', 'Tell Maria', 'Call Dr', 'Call']) {
      assert.ok(!traps.includes(bad), `"${bad}" was taken for a name`);
    }
    for (const good of ['Maria', 'Dr. Chen', 'Detective Rowe']) {
      assert.ok(traps.includes(good), `"${good}" was missed among the traps`);
    }
    console.log('✓ a command at the start of a line ("Listen", "Tell Maria") is not a name');
  }

  // ---- 3c. a name matched by two rules is counted once ------------------
  {
    const twice = extractNames(['It is Detective Rowe.', 'Detective Rowe again.', 'Hello, Detective Rowe.']);
    const rowe = twice.find((n) => n.name === 'Detective Rowe');
    assert.strictEqual(rowe && rowe.count, 3, 'each mention must count once, not once per rule');
    console.log('✓ a name that two rules both recognise is counted once per mention');
  }

  // ---- 4. a name mentioned once in passing is left out ------------------
  const once = extractNames(['I saw Kevin yesterday.', 'It rained all week.']);
  assert.ok(!once.map((n) => n.name).includes('Kevin'),
    'a single-word name seen once is not worth a glossary row');
  console.log('✓ a one-off single name does not clutter the list');

  // ---- 5. the prompt forbids splitting an epithet -----------------------
  const { systemPrompt } = require('../src/translate');
  for (const code of ['heb', 'spa', 'jpn']) {
    const p = systemPrompt(langs.get(code));
    assert.ok(/Billy the Kid/.test(p), `${code}: the prompt must name the trap`);
    assert.ok(/ONE name/.test(p), `${code}: and state the rule`);
  }
  console.log('✓ every language is told that a name with an epithet is one name');

  // ---- 6. end to end: the glossary reaches every chunk ------------------
  process.env.CHUNK_SIZE = '4';   // force several chunks over a short file
  process.env.GEMINI_API_KEY = 'test-key';

  const cues = srt.parse(
    LINES.map((l, i) => {
      const s = String(i + 1).padStart(2, '0');
      return `${i + 1}\n00:00:${s},000 --> 00:00:${s},900\n${l}`;
    }).join('\n\n')
  );

  const prompts = [];
  let glossaryAsked = 0;
  const realFetch = global.fetch;
  global.fetch = async (u, o) => {
    if (!String(u).includes('generativelanguage')) return realFetch(u, o);
    const prompt = JSON.parse(o.body).contents[0].parts[0].text;
    prompts.push(prompt);

    if (prompt.startsWith('These are the proper names')) {
      glossaryAsked++;
      const body = JSON.stringify({ candidates: [{ content: { parts: [{
        text: JSON.stringify([
          { en: 'Billy the Kid', t: 'בילי דה קיד' },
          { en: 'Maria', t: 'מריה' },
          { en: 'Sarah', t: 'שרה' },
          { en: 'Detective Rowe', t: 'הבלש רואו' },
        ]),
      }] } }] });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const block = prompt.split('TRANSLATE')[1].split(/CONTEXT AFTER|$/)[0];
    const nums = [...block.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
    const body = JSON.stringify({ candidates: [{ content: { parts: [{
      text: JSON.stringify(nums.map((n) => ({ n, he: `שורה ${n}` }))),
    }] } }] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  delete require.cache[require.resolve('../src/translate')];
  const { translateCues } = require('../src/translate');
  const out = await translateCues(cues, 'test-key', () => {}, null, null, 'heb');
  global.fetch = realFetch;

  assert.strictEqual(glossaryAsked, 1, 'the names are decided once, not per chunk');
  console.log('✓ the glossary costs exactly one request for the whole episode');

  const chunkPrompts = prompts.filter((p) => !p.startsWith('These are the proper names'));
  assert.ok(chunkPrompts.length >= 3, 'the file should have split into several chunks');
  for (const p of chunkPrompts) {
    assert.ok(/^NAMES — use these forms every time/m.test(p), 'a chunk went out without the names');
    assert.ok(p.includes('Billy the Kid = בילי דה קיד'), 'and without the settled form');
  }
  console.log(`✓ all ${chunkPrompts.length} chunks carried the same settled names`);

  assert.strictEqual(out.length, cues.length, 'no cue may be lost');
  for (let i = 0; i < cues.length; i++) {
    assert.strictEqual(out[i].start, cues[i].start, `cue ${i + 1} timing moved`);
  }
  console.log('✓ timings still untouched with the names pass in place');

  // ---- 7. it can be turned off, and a failure is not fatal --------------
  process.env.NAME_GLOSSARY = '0';
  delete require.cache[require.resolve('../src/translate')];
  const off = require('../src/translate');
  const seen = [];
  global.fetch = async (u, o) => {
    if (!String(u).includes('generativelanguage')) return realFetch(u, o);
    const prompt = JSON.parse(o.body).contents[0].parts[0].text;
    seen.push(prompt);
    const block = prompt.split('TRANSLATE')[1].split(/CONTEXT AFTER|$/)[0];
    const nums = [...block.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
    const body = JSON.stringify({ candidates: [{ content: { parts: [{
      text: JSON.stringify(nums.map((n) => ({ n, he: `שורה ${n}` }))),
    }] } }] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const out2 = await off.translateCues(cues, 'test-key', () => {}, null, null, 'heb');
  global.fetch = realFetch;
  delete process.env.NAME_GLOSSARY;

  assert.ok(!seen.some((p) => p.startsWith('These are the proper names')),
    'NAME_GLOSSARY=0 must skip the extra request entirely');
  assert.strictEqual(out2.length, cues.length, 'and translation still works without it');
  console.log('✓ NAME_GLOSSARY=0 skips the pass, and translation is unaffected');

  // ---- a settled form never carries the model's own quote marks ---------
  // Arabic came back as "بيلي ذا كيد" in a real run. The straight quote then
  // travelled into every chunk prompt, the model echoed it into its JSON
  // string without escaping it, and eight lines ended at that quote.
  const { unquote, looksTruncated } = require('../src/translate');
  const quoted = [
    ['"بيلي ذا كيد"', 'بيلي ذا كيد'],
    ['السيدة "ألفاريز"', 'السيدة ألفاريز'],
    ['«ماريا»', 'ماريا'],
    ['“Billy the Kid”', 'Billy the Kid'],
    ['「ロウ刑事」', 'ロウ刑事'],
    ["'Billy el Niño'", 'Billy el Niño'],
  ];
  for (const [raw, want] of quoted) {
    assert.strictEqual(unquote(raw), want, `unquote(${raw})`);
  }
  console.log('✓ quote marks are stripped off every settled name form');

  // A quote inside a word is spelling, not decoration: ד"ר is how Hebrew
  // writes "Dr.", and that run showed it surviving translation untouched.
  for (const keep of ['ד"ר צ\'ן', 'רו"ח לוי', "O'Brien"]) {
    assert.strictEqual(unquote(keep), keep, `unquote must leave ${keep} alone`);
  }
  assert.ok(!unquote('السيدة "ألفاريز"').includes('"'),
    'no straight quote may reach a chunk prompt');
  console.log('✓ a quote inside a word is left alone (ד"ר, O\'Brien)');

  // ---- a line cut short is caught and sent back -------------------------
  const ara = langs.get('ara');
  const jpn = langs.get('jpn');
  const cutShort = [
    ['Dr. Chen says the results are fine, Maria.', 'دكتور', ara],
    ['Maria, you can\'t keep putting this off.', 'يا', ara],
    ['Detective Rowe left his card on the table.', 'المحقق', ara],
  ];
  for (const [en, got, lg] of cutShort) {
    assert.ok(looksTruncated(en, got, lg), `should have caught "${got}" as cut short`);
  }
  // Whole translations from that same run, none of which may be flagged.
  const whole = [
    ['Dr. Chen called again about the results.', 'اتصلت دكتور تشن ثانيةً بشأن النتائج.', ara],
    ['That\'s easy for you to say.', 'קל לך להגיד.', langs.get('heb')],
    ['Detective Rowe left his card on the table.', 'El detective Rowe dejó su tarjeta en la mesa.', langs.get('spa')],
  ];
  for (const [en, got, lg] of whole) {
    assert.ok(!looksTruncated(en, got, lg), `a full translation was flagged: "${got}"`);
  }
  // Japanese is genuinely a third of the length; the bar has to move with it.
  assert.ok(!looksTruncated('It\'s a piece of cake, right?', '朝飯前だろ？', jpn),
    'dense scripts are short by nature, not truncated');
  assert.ok(!looksTruncated('Gentlemen, we\'re closing in ten minutes.', '皆さん 閉店は１０分後です', jpn));
  assert.ok(looksTruncated('Dr. Chen says the results are fine, Maria.', '検査', jpn),
    'but a Japanese line CAN be cut short too');
  // Short sources vary too much to judge, so they are never flagged.
  assert.ok(!looksTruncated('Sit down.', 'שב.', langs.get('heb')));
  console.log('✓ cut-short lines are caught, in dense scripts too, without false alarms');

  // ---- a shout is not a name -------------------------------------------
  // From a real western: "Hyah" was settled as a name, and every "Hyah!" came
  // out in Hebrew as a word meaning "was".
  {
    const western = [
      'Hyah!', 'Hyah! Hyah! Hyah!', 'Hee-yaw!', 'Hee-ya!', 'Whoa!',
      'Garrett!', 'Garrett is coming for you.', 'Tell Garrett I said so.',
    ];
    const got = extractNames(western).map((n) => n.name);
    for (const shout of ['Hyah', 'Hee', 'Whoa']) {
      assert.ok(!got.includes(shout), `"${shout}" is a shout, not a name`);
    }
    assert.ok(got.includes('Garrett'), 'a name that is also shouted is still a name');
    console.log('✓ a word only ever shouted ("Hyah!", "Hee-yaw!") is not a name; a shouted name still is');
  }

  // ---- a nickname made of ordinary words is translated --------------------
  // From a real episode: "the House" (a trading firm) came out as האוס, a
  // transliteration, where a subtitler would write הבית.
  {
    const { glossaryPrompt } = require('../src/names');
    const p = glossaryPrompt([{ name: 'House', count: 6, sample: 'with Mr. Murphy and the House.' }], langs.get('heb'));
    assert.ok(/the House[^\n]*TRANSLATED by meaning/.test(p), 'a common-word nickname must be translated');
    assert.ok(/White Oaks stays White Oaks/.test(p), 'a real place keeps its name');
    console.log('✓ nicknames made of ordinary words are translated; real places keep their names');
  }

  console.log('\nall name checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
