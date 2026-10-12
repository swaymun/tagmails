<p><img src="assets/brand/wordmark.svg" alt="tagmails." height="48"></p>

Email your coding agent: TagMails hands each email to Codex or Claude Code on your own Mac or Linux machine, in the right project folder, and replies in the same Gmail thread.

## Quick start

1. Sign in with Google at [tagmails.com](https://tagmails.com) and add a balance (you pay per email).
2. Click **Copy setup prompt** and paste it into Codex or Claude Code on the Mac or Linux machine that should do the work. It installs `tagmails`, pairs the machine, starts it, and saves where your large files should go.
3. Email your agent address from that Gmail account. Reply in the thread to continue.

**Or connect via MCP**, without the website: add `https://tagmails.com/mcp` as a remote MCP server and sign in with Google when asked. In Claude Code: `claude mcp add --transport http tagmails https://tagmails.com/mcp`, then `/mcp` to sign in. In Codex: `codex mcp add tagmails --url https://tagmails.com/mcp`, then `codex mcp login tagmails`. In Claude or ChatGPT: **Add custom connector** with the same URL. Then ask your agent to "set up TagMails on this computer". See [docs/mcp.md](docs/mcp.md).

By hand instead: `brew install swaymun/tagmails/tagmails` (or `curl -fsSL https://tagmails.com/install.sh | sh`, Node.js 20.16+), then `tagmails pair tm_pair_…` and `tagmails start --projects`.

`tagmails status`, `logs`, `stop`, `open <thread-id>` and `uninstall` cover the rest; see `tagmails --help`.

**Self-host** on your own Cloudflare account: `npm ci && node scripts/self-host-setup.mjs`, then pair with `--relay <your-origin>`. See [docs/self-hosting.md](docs/self-hosting.md).

## How it works

```
Gmail ─► relay Worker (services/: D1, R2) ─► tagmails daemon (crates/) ─► Codex / Claude Code (agent/)
                                                                                     │
Gmail thread ◄──────────────── relay outbox ◄──────────── result ◄───────────────────┘
```

- The relay authenticates the sender, picks the model and project folder, and pushes the job to your paired machine.
- The daemon runs the agent in that folder and uploads the result; the relay replies in the thread with up to 3.5 MB of email-safe attachments. TagMails hosts nothing larger.
- `apps/mock-inbox` runs the whole loop locally without real mail.

## Permissions

Defaults are **TagMails recommended permissions**: Codex `write` with Codex's automatic reviewer deciding sandbox escalations, and Claude Code `auto`. They change only with `tagmails start` on the machine.

| Flag | Effect |
| --- | --- |
| `--access read` | Read the folder, no edits. |
| `--access write` (default) | Edit inside the chosen folder. |
| `--access full` | No sandbox; runs only verified owner emails. |
| `--claude-permission manual\|accept-edits\|auto\|bypass` | Claude Code mode, default `auto`; `bypass` is owner-only. |
| `--projects` (default) / `--workspace PATH` | Pick a recent project folder per thread, or pin one folder. |

`tagmails set` changes model defaults (`--model`, `--effort`, `--speed`) and your standing instructions (`--instructions`, for example where large files go) without a restart, and you can ask for it by email. Owner emails get your MCP servers, connectors and skills; participant emails get none.

Linux containers (Docker, RunPod) usually block Codex's sandbox; `tagmails start` warns and suggests a VM or `--access full`.

## Security model

- The owner is recognized only by DMARC (Resend) or an aligned DKIM signature covering From, body and a To/Cc naming the agent (Cloudflare). Other senders must be participants the owner added to that thread.
- The device token stays on the machine; the relay keeps its hash, and the daemon rejects claims not HMAC-signed with it.
- Agents run only in folders the daemon published or a per-thread chat folder. Attachments are labeled untrusted.
- Stored mail is sealed to your machine. `tagmails pair` (or the first `tagmails start` on an older pairing) creates an X25519 key in the config folder; the private half never leaves it. The relay seals everything it keeps about your mail (the message, attachments, subject, the agent's answer and transcript, any reply waiting to go out) to the public half, so the operator can't read it back. The relay still reads each email in memory to check the sender, route it and send the reply, and the routing step sends the subject and the first 4,000 characters to Jev. Addresses, Message-IDs, times, models and project folder names stay readable. Machines on a release before 0.2.24 keep the older relay-key (`STORAGE_KEY`) sealing, which the operator can open. Details: [docs/email-privacy.md](docs/email-privacy.md).

## Development

```sh
npm ci && npm test                       # Worker, adapters, lab
cargo test -p tagmails-daemon
npm run lab                              # local inbox at http://127.0.0.1:4177
cargo run -p tagmails-daemon -- --once   # mock agent takes one lab job
```

[AGENTS.md](AGENTS.md) covers deploys, releases and conventions. MIT [license](LICENSE).
