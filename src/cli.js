#!/usr/bin/env node
'use strict';

// Standalone use:  node src/cli.js input.srt [output.he.srt]
// Handy for testing the translation quality without touching Stremio.

const fs = require('fs');
const path = require('path');
const srt = require('./srt');
const { translateCues, MODEL } = require('./translate');

async function main() {
  const [input, outputArg] = process.argv.slice(2);
  if (!input) {
    console.error('usage: node src/cli.js <input.srt> [output.srt]');
    process.exit(1);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('missing GEMINI_API_KEY');
    process.exit(1);
  }

  const output =
    outputArg ||
    path.join(
      path.dirname(input),
      path.basename(input).replace(/(\.[a-z]{2,5})?\.srt$/i, '') + '.he.srt'
    );

  const cues = srt.parse(fs.readFileSync(input, 'utf8'));
  console.log(`parsed ${cues.length} cues from ${input} · model ${MODEL}`);

  const translated = await translateCues(cues, apiKey, (m) => console.log(m));
  fs.writeFileSync(output, '﻿' + srt.serialize(translated), 'utf8');
  console.log(`wrote ${output}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
