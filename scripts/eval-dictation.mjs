// Live Jev check that dictated model names route correctly and that the same
// words in ordinary text don't. Costs a fraction of a cent.
//   node scripts/eval-dictation.mjs
import fs from 'node:fs';
import { routeModel } from '../services/jev-route.mjs';

const apiKey = process.env.TYPESAFE_API_KEY ||
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/wonder/jev.json`, 'utf8')).api_key;
const m = (id, name, efforts = ['low', 'medium', 'high', 'xhigh', 'max'], speeds = ['standard']) => ({ id, name, efforts, speeds });
// A catalog like the pilot Mac's: several versions per family.
const catalog = [
  m('gpt-6-astra', 'GPT-6-Astra', undefined, ['standard', 'fast']), m('gpt-6-sol', 'GPT-6-Sol', undefined, ['standard', 'fast']),
  m('gpt-6-luna', 'GPT-6-Luna', undefined, ['standard', 'fast']), m('gpt-5.6-sol', 'GPT-5.6-Sol', undefined, ['standard', 'fast']),
  m('gpt-5.6-terra', 'GPT-5.6-Terra', undefined, ['standard', 'fast']), m('gpt-5.6-luna', 'GPT-5.6-Luna', undefined, ['standard', 'fast']),
  m('claude-opus-5-5', 'Opus 5.5'), m('claude-fable-5-1', 'Fable 5.1'), m('claude-sonnet-5-5', 'Sonnet 5.5'),
  m('claude-haiku-4-5-20251001', 'Haiku 4.5', ['medium']), m('claude-sonnet-4-6', 'Sonnet 4.6'), m('claude-opus-4-8', 'Opus 4.8'),
];
const D = 'claude-opus-5-5';
const cases = [
  ['use seoul for this and fix the readme', 'gpt-6-sol'], ['use soul high on this bug', 'gpt-6-sol'],
  ['run this with son it please', 'claude-sonnet-5-5'], ['use son it 4.6 for the review', 'claude-sonnet-4-6'],
  ['use high cool for a quick summary', 'claude-haiku-4-5-20251001'], ['use hi coo on this', 'claude-haiku-4-5-20251001'],
  ['use loon uh low fast', 'gpt-6-luna'], ['use lunar for a first pass', 'gpt-6-luna'],
  ['use astro for this refactor', 'gpt-6-astra'], ['use code x to check the bug', 'gpt-6-sol'],
  ['use oh pus max for the plan', 'claude-opus-5-5'], ['use tera to write tests', 'gpt-5.6-terra'],
  ['use fabel to draft the story', 'claude-fable-5-1'], ['use cloud sonnet for this', 'claude-sonnet-5-5'],
  // The same words outside a model request keep the default.
  ['find hotels in Seoul for my trip', D], ['that sounds cool, summarize the notes', D],
  ['put the files in the cloud folder and list them', D], ['write a sonnet about autumn', D],
  ['write a haiku about rain', D], ['the astro site build is slow, look into it', D],
];
let passed = 0;
for (const [body, want] of cases) {
  const route = await routeModel(body, D, { apiKey, availableModels: catalog, pilotCodexModel: 'gpt-6-sol' });
  const got = route.error ? 'error' : route.id;
  if (got === want) passed += 1;
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${JSON.stringify(body)} => ${got}${got === want ? '' : ` (expected ${want})`}`);
}
console.log(`${passed}/${cases.length} passed`);
if (passed !== cases.length) process.exitCode = 1;
