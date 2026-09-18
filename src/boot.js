'use strict';
var ORIG = global.fetch;
var FB = (process.env.GEMINI_FALLBACK || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var TRIES = parseInt(process.env.GEMINI_RETRIES || '6', 10);
var RETRYABLE = [408, 429, 500, 502, 503, 504];
var CATS = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'];
var LEVELS = ['OFF', 'BLOCK_NONE', 'BLOCK_ONLY_HIGH', null];
var lvl = 0;
var noThink = process.env.GEMINI_NOTHINK !== '0';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function tweak(body) {
  try {
    var o = JSON.parse(body);
    if (LEVELS[lvl]) {
      o.safetySettings = CATS.map(function (c) { return { category: c, threshold: LEVELS[lvl] }; });
    } else { delete o.safetySettings; }
    if (noThink) {
      o.generationConfig = o.generationConfig || {};
      o.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    return JSON.stringify(o);
  } catch (e) { return body; }
}
function clean(json) {
  var c = json && json.candidates && json.candidates[0];
  if (c && c.content && Array.isArray(c.content.parts)) {
    c.content.parts = c.content.parts.filter(function (p) { return !p.thought; });
  }
  return json;
}
function textOf(json) {
  var c = json && json.candidates && json.candidates[0];
  var parts = (c && c.content && c.content.parts) || [];
  return parts.map(function (p) { return p.text || ''; }).join('');
}

global.fetch = async function (url, opts) {
  var u = String(url);
  if (u.indexOf('generativelanguage.googleapis.com') < 0) return ORIG(url, opts);
  var targets = [u];
  FB.forEach(function (m) { targets.push(u.replace(/models\/[^:]+:/, 'models/' + m + ':')); });
  var last = null;
  for (var t = 0; t < targets.length; t++) {
    for (var a = 0; a < TRIES; a++) {
      var sent = opts || {};
      if (sent.body) sent = Object.assign({}, sent, { body: tweak(sent.body) });
      var res = await ORIG(targets[t], sent);

      if (res.ok) {
        var json = await res.clone().json().catch(function () { return null; });
        if (json) {
          clean(json);
          if (!textOf(json)) {
            var c = json.candidates && json.candidates[0];
            var pf = json.promptFeedback || {};
            console.log('   empty answer (finish=' + ((c && c.finishReason) || '-') + ' block=' + (pf.blockReason || '-') + ' safety=' + LEVELS[lvl]);
          }
          return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return res;
      }

      var txt = await res.clone().text().catch(function () { return ''; });
      if (res.status === 400 && noThink && /think/i.test(txt)) {
        console.log('   model rejects thinkingConfig - retrying without it');
        noThink = false; continue;
      }
      if (res.status === 400 && lvl < LEVELS.length - 1) {
        lvl++;
        console.log('   safety setting rejected - falling back to ' + (LEVELS[lvl] || 'model default'));
        continue;
      }
      if (res.status === 400 && noThink) {
        console.log('   400 - retrying without thinkingConfig');
        noThink = false; continue;
      }
      last = res;
      if (RETRYABLE.indexOf(res.status) < 0) break;
      var m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt);
      var hinted = m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
      var wait = Math.max(hinted, Math.min(60000, 2000 * Math.pow(2, a) + Math.random() * 1000));
      if (a < TRIES - 1) {
        console.log('   gemini ' + res.status + ' - waiting ' + Math.round(wait / 1000) + 's (try ' + (a + 1) + '/' + TRIES + ')');
        await sleep(wait);
      } else {
        console.log('   gemini ' + res.status + ' - out of retries for this model');
      }
    }
    if (t < targets.length - 1) console.log('   switching to fallback model');
  }
  return last;
};

require('./server.js');
