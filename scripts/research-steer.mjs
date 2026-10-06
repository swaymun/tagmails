// Synthetic steer-vs-queue study. Hard-capped at CAP dollars of Jev input.
import fs from 'node:fs';
import { routeFollowUp, STEER_PROMPTS } from '../services/steer-route.mjs';

const CAP = Number(process.env.CAP ?? 0.15), RATE = 0.042 / 1e6;
const apiKey = process.env.TYPESAFE_API_KEY || JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/wonder/jev.json`, 'utf8')).api_key;
const R = {
  japan: 'send me the japan travel guide as a .docx, 7 days, Tokyo and Kyoto',
  bug: 'Find why the login test fails on CI and fix it',
  report: 'Summarize the Q3 sales spreadsheet into three bullets',
  refactor: 'Refactor the billing module to use the new Stripe client',
  deploy: 'Deploy the relay worker to dev',
};
const cases = [
  ['japan', 'make it 10 days instead', 'steer'], ['japan', 'also include Osaka', 'steer'],
  ['japan', 'actually skip Kyoto, we are going to Hokkaido', 'steer'], ['japan', 'how far along are you?', 'steer'],
  ['japan', 'use luna for this', 'steer'], ['japan', 'we are vegetarian, keep that in mind for food', 'steer'],
  ['japan', 'keep it under 5 pages', 'steer'], ['japan', 'stop, never mind', 'steer'],
  ['japan', 'when you are done, also write the Korea guide', 'queue'],
  ['japan', 'separate question: what is the capital of Peru?', 'queue'],
  ['japan', 'after that, email the summary to my wife', 'queue'],
  ['japan', 'can you also check my calendar for next Friday?', 'queue'],
  ['bug', 'it is the timezone test, start there', 'steer'], ['bug', "don't touch the CI config", 'steer'],
  ['bug', 'also check whether staging has the same failure', 'steer'], ['bug', 'wait, ignore the flaky one', 'steer'],
  ['bug', 'once fixed, open a PR', 'queue'], ['bug', 'unrelated: rename the README title to TagMails', 'queue'],
  ['bug', 'new task: write release notes for 0.3', 'queue'], ['bug', 'afterwards bump the version number', 'queue'],
  ['report', 'only use the EMEA tab', 'steer'], ['report', 'make it five bullets', 'steer'],
  ['report', 'sorry, I attached the wrong file, use the new one', 'steer'],
  ['report', 'then draft an email to the team about it', 'queue'], ['report', 'different thing: translate my CV into French', 'queue'],
  ['refactor', 'keep the old client as a fallback', 'steer'], ['refactor', 'add tests as you go', 'steer'],
  ['refactor', 'thanks, looks good so far', 'ack'], ['refactor', 'next, do the same for the invoices module', 'queue'],
  ['refactor', 'can you look at why the site build is slow?', 'queue'],
  ['deploy', 'wait, use the staging env not dev', 'steer'], ['deploy', 'abort the deploy', 'steer'],
  ['deploy', 'once it is live, run the smoke tests', 'queue'], ['deploy', 'and what is the current balance?', 'queue'],
  ['japan', 'Sounds good.\n\nOn Mon, Oct 5, Saimun wrote:\n> make it 10 days', 'ack'],
  ['bug', 'ok\n> also check staging', 'ack'],
  ['report', 'Please also include a chart of revenue by region in the same summary', 'steer'],
  ['report', 'Also: what are the best CRM tools for a 5 person team?', 'queue'],
  ['refactor', 'use the v2 API, not v1', 'steer'], ['deploy', 'after deploying, write a changelog entry', 'queue'],
];
let spent = 0, tokens = 0;
const onUsage = (u) => { const t = u?.input_tokens ?? 0; tokens += t; spent += t * RATE; };
for (const prompt of Object.keys(STEER_PROMPTS)) {
  let ok = 0; const wrong = [];
  for (const [r, text, want] of cases) {
    if (spent > CAP) { console.log(`CAP reached at $${spent.toFixed(5)}`); process.exit(0); }
    const got = await routeFollowUp(R[r], text, { apiKey, prompt, onUsage });
    if (got === want) ok++; else wrong.push(`${want}->${got}: ${text.split('\n')[0]}`);
  }
  console.log(`${prompt}: ${ok}/${cases.length}`); wrong.forEach((w) => console.log('  ', w));
}
console.log(`${tokens} input tokens, $${spent.toFixed(5)} (cap $${CAP})`);
