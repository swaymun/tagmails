#!/usr/bin/env node
// Stand-in for a future `tagmails project` command, used by routing-model-compare.mjs --lookup.
//   node routing-compare-projects-tool.mjs <catalog.json> list|show <id>
import fs from 'node:fs';
const [file, command, id] = process.argv.slice(2);
const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
if (command === 'list') {
  for (const p of projects) console.log(`${p.id}  ${p.name}  ${p.path}  ${p.description.slice(0, 160)}`);
} else if (command === 'show' && projects.some((p) => p.id === id)) {
  console.log(JSON.stringify(projects.find((p) => p.id === id), null, 2));
} else { console.error('usage: list | show <p_id>'); process.exit(2); }
