<p><img src="assets/brand/wordmark.svg" alt="tagmails." height="48"></p>

Email your coding agent: TagMails hands each email to Codex or Claude Code on your own Mac or Linux machine, in the right project folder, and replies in the same Gmail thread.

## Quick start

1. Sign in with Google at [tagmails.com](https://tagmails.com) and add a balance (you pay per email).
2. Click **Copy setup prompt** and paste it into Codex or Claude Code on the Mac or Linux machine that should do the work. It installs `tagmails`, pairs the machine, starts it, and saves where your large files should go.
3. Email your agent address from that Gmail account. Reply in the thread to continue.

By hand instead: `brew install swaymun/tagmails/tagmails` (or `curl -fsSL https://tagmails.com/install.sh | sh`, Node.js 20+), then `tagmails pair tm_pair_…` and `tagmails start --projects`.

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
- With `STORAGE_KEY` set, stored mail and results are sealed with AES-256-GCM. See [docs/email-privacy.md](docs/email-privacy.md).

## Development

```sh
npm ci && npm test                       # Worker, adapters, lab
cargo test -p tagmails-daemon
npm run lab                              # local inbox at http://127.0.0.1:4177
cargo run -p tagmails-daemon -- --once   # mock agent takes one lab job
```

[AGENTS.md](AGENTS.md) covers deploys, releases and conventions. MIT [license](LICENSE).
