<p><img src="assets/brand/wordmark.svg" alt="tagmails." height="48"></p>

Email your coding agent. Send a task to your TagMails address, Codex or Claude Code runs it on your own machine in the right project folder, and the answer comes back in the same thread.

Status: owner-only pilot on the `tagmails-relay-dev` Worker. The hosted service is not open for signup; you can [run your own relay](docs/self-hosting.md).

## Quickstart

1. Install the agent on a Mac or Linux machine that has a signed-in `codex` or `claude` CLI and Node.js 20+:

   ```sh
   brew install swaymun/tagmails/tagmails
   # or, without Homebrew (verifies SHA-256 sums):
   curl -fsSL https://tagmails.com/install.sh | sh
   ```

2. Sign in on your relay's `/account` page, create a pairing code, and start the service:

   ```sh
   tagmails pair tm_pair_… --relay https://your-relay.example
   tagmails start --access read        # launchd on macOS, systemd user unit on Linux
   tagmails status
   ```

3. From the Gmail account you signed in with, email your agent address. Reply in the thread to continue the same session.

Other commands: `tagmails logs`, `tagmails stop`, `tagmails open <thread-id>` (resume a thread's session locally), `tagmails uninstall`. Run `tagmails --help` for all flags.

## How it works

```
Gmail ─► Cloudflare Email Routing (or Resend webhook) ─► relay Worker (D1, R2, Durable Object)
                                                           │ routes model and project folder
                                                           ▼
                                  tagmails daemon on your machine (WebSocket push, signed claims)
                                                           │ runs codex app-server or claude CLI
                                                           ▼
                                  relay outbox ─► reply in the same Gmail thread
```

- `crates/tagmails-daemon`: the `tagmails` binary. Pairs, claims jobs, picks the folder, runs the adapters, uploads results.
- `agent/`: Node adapters that drive Codex and Claude Code and enforce the local permission mode.
- `services/`: the Worker. Inbound mail, Google sign-in, pairing, the job queue and leases, routing, outbox, run pages.
- `apps/mock-inbox`: a local Gmail-like lab for the whole loop without real mail. Its `mail.mjs` and `markdown.mjs` render the relay's emails.
- `site/`: private submodule for the website. Not needed to self-host.

## Permissions

| Flag | Effect |
| --- | --- |
| `--access read` (default) | Agent can read the workspace, no edits. |
| `--access write` | Edits inside the chosen folder. Authorized participants can request edits too. |
| `--access full` | No sandbox. Only runs emails from the account owner. |
| `--projects` (default) / `--workspace PATH` | Pick from recent Codex/Claude project folders per thread, or pin one folder. |
| `--claude-permission manual\|accept-edits\|auto\|bypass` | Claude Code permission mode. `bypass` is owner-only. |
| `--max-access`, `--max-claude-permission` | Ceiling for permissions chosen on the website. Defaults to `write` and `auto`. Full access and `bypass` are reachable only after you allow them on the machine (`--max-access full`, or `--access full` / `--claude-permission bypass`). |

Owner emails get the owner's own tool setup (MCP servers, connectors, skills). Participant emails run with none of it. Config is in `~/.config/tagmails/`, data in `~/Library/Application Support/TagMails` or `~/.local/share/tagmails`.

## Security model

- A sender is the owner only if the mail passes DMARC (Resend path) or a DKIM signature from the From domain that covers From, the whole body, and a To or Cc that names the agent (Cloudflare path; Bcc to the agent is not accepted there). Anyone else must be a participant the owner put on that thread, and only on that thread.
- The device token never leaves the machine; the relay stores its SHA-256. Each claim is HMAC-signed with it and the daemon rejects unsigned or altered claims.
- The daemon only runs in folders it published itself or in a per-thread chat folder. Attachments are staged as fixed file names and labeled untrusted.
- Follow-ups sent mid-run join the live turn only when they come from the same sender as the running email.
- With `STORAGE_KEY` set, stored mail, results and files are sealed with AES-256-GCM.
- Email content is untrusted input to the agent. Read access is the default for a reason; see [docs/email-privacy.md](docs/email-privacy.md) for what the relay keeps.

## Development

```sh
npm ci
npm test                                  # Worker, adapters, lab (node --test, ~15 s)
cargo test -p tagmails-daemon
npm run lab                               # local inbox at http://127.0.0.1:4177
cargo run -p tagmails-daemon -- --once    # mock agent takes one lab job
```

`AGENTS.md` covers deploys, releases and conventions. Pushes to `main` that touch `services/`, `apps/` or `wrangler.jsonc` deploy the dev relay.

## Docs

- [docs/setup-for-agents.md](docs/setup-for-agents.md): unattended relay setup for a coding agent, with a copyable prompt
- [docs/self-hosting.md](docs/self-hosting.md): run your own relay
- [docs/runbook.md](docs/runbook.md): the live pilot, checks and stop conditions
- [docs/project-routing.md](docs/project-routing.md), [docs/email-format.md](docs/email-format.md), [docs/email-privacy.md](docs/email-privacy.md), [docs/launch-gates.md](docs/launch-gates.md), [docs/pricing.md](docs/pricing.md), [docs/provider-paths.md](docs/provider-paths.md)

## License

MIT. See [LICENSE](LICENSE).
