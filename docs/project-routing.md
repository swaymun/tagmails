# Project routing

A new email thread runs in one of the paired machine's project folders, in a private scratch folder, or after a "which project?" reply. Replies stay in the thread's folder. Code: `agent/project-inventory.mjs` (what the machine shares), `services/project-route.mjs` (the decision).

## How a folder is chosen

1. **Explicit path.** If the sender writes "work in /path" (or "project at: ~/path", "cd …"), the relay picks the deepest published folder containing it, or asks when none does. No model call. Quoted lines and quoted strings are ignored, so a forwarded "work in …" can't redirect the agent.
2. **Jev.** Otherwise one Jev call chooses a folder ID, `ad_hoc` (scratch) or `ask`, using the frozen "v3" decision rules from the October 4 synthetic benchmark plus the local evidence below. A choice is accepted at probability ≥ 0.80 with a lead of ≥ 0.20; anything else asks.
3. **Guards.** The agent only runs in a folder it published itself (checked locally), and a pinned `--workspace` always wins.

## What the machine shares

| Field | Source | Sent with |
| --- | --- | --- |
| name, aliases, path, branch | Codex `project/list`, Claude session folders, git | always |
| README excerpt (900 chars) | README/AGENTS/CLAUDE.md or package.json | always |
| repository name, top-level entries (30) | `git remote`, directory listing | always |
| `recentRequests`: first line (160 chars) of the last 3 sessions | Codex `thread/list`, Claude session files; emails, keys and the home path are redacted | `--routing-context full` (default) |
| `lastActiveDaysAgo` | session timestamps | always |

`tagmails start --routing-context files` keeps session history on the machine.

## October 5 context study

132 real requests: the first message of Codex and Claude sessions from the owner's history, each labeled with the folder it actually ran in. Each request only saw context from before it was written, never its own session. 14 candidate folders. Data and scripts: `.local/routing-context-study-2026-10-05/` (private).

| Context given to Jev | Correct folder | Wrong folder | Scratch | Asked |
| --- | ---: | ---: | ---: | ---: |
| Names and paths only | 36 | 0 | 35 | 61 |
| + README excerpt (previous production) | 39 | 0 | 30 | 63 |
| + top-level files and repository | 41 | 0 | 28 | 63 |
| Recent session requests only | 57 | 0 | 20 | 55 |
| README + files + recent requests | 69 | 0 | 15 | 48 |
| Same, threshold 0.80 + path guard (**shipped**) | **73** | **0** | 16 | 43 |

- Recent session requests are by far the strongest signal; README excerpts add little once they're present.
- Nothing produced a wrong folder on this set. The remaining "asks" are mostly requests that only make sense inside the folder ("fix the lag on the chat page"); for those, a question is the right answer from email.
- On the frozen synthetic test (142 cases built to catch wrong folders) the shipped setup scores 140/142 with no wrong folders (v3 alone: 139/142). Without the path guard, the new evidence rule let one "work in an unknown path" case through, which is why the guard exists.
- Live Jev cost for the study: about $0.26 at $0.042 per million input tokens.

Limits: one person's history, 14 folders, coding prompts rather than emails, and a sample weighted toward folders with many sessions. Rerun `evaluate.mjs` with new history before changing the rules or threshold.
