# Project routing

A new email thread runs in one of your computer's project folders or, when none clearly fits, in a chat folder: `~/Documents/Codex/<date>/<subject>` for Codex (where the Codex app keeps chats without a project) and `~/.tagmails/chats/<date>/<subject>` for Claude Code or when that folder is missing. Replies stay in the thread's folder. Code: `agent/project-inventory.mjs` (what the computer lists), `agent/local-router.mjs` (the choice), `services/project-route.mjs` (what the relay settles itself).

## How a folder is chosen

1. **An explicit path.** If the email says "work in /path" (or "project at ~/path", "cd …"), the relay picks the deepest listed folder containing it, or replies asking which project when none does. Quoted lines and quoted strings are ignored, so a forwarded "work in …" can't redirect the agent.
2. **Your computer.** Otherwise the computer that claims the email decides, with Claude Haiku for Claude Code users or GPT-6 Luna for Codex users (the other CLI if one is missing or fails), on your own subscription. It answers a folder, a chat folder, or "ask", and reports the choice to the relay. If it can't decide, the email runs in a chat folder; it never gets stuck. If another email is already running in that folder, this one waits its turn.
3. **Guards.** The agent only runs in a folder the computer listed itself, and a pinned `tagmails start --workspace PATH` always wins.

A new project folder becomes routable once a Codex project or Claude Code session exists there. The list refreshes every 15 minutes, or on a service restart.

## What the computer lists

| Field | Source | When |
| --- | --- | --- |
| name, aliases, path, branch | Codex projects, Claude Code session folders, git | always |
| README excerpt (900 characters) | README, AGENTS.md, CLAUDE.md or package.json | always |
| repository name, top-level entries (30) | `git remote`, the folder listing | always |
| the first line (160 characters) of your last 3 sessions there | Codex and Claude Code session history; emails, keys and your home path are redacted | `--routing-context full` (the default) |
| days since last active | session timestamps | always |

The list stays on the computer, which reads it to choose. The relay gets only each project's name and path, encrypted with the relay's own key, to settle an explicit path and name projects in "which project?" (see [email-privacy.md](email-privacy.md#what-the-operator-can-read)). `tagmails start --routing-context files` leaves session history out of the choice; `--workspace PATH` lists nothing.
