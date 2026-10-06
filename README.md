# TagMails

Email your coding agent. TagMails gives Codex (and later Claude Code) on your own computer an email address: you send a task from Gmail, the agent runs locally in the right project folder, and the answer comes back in the same thread. Reply to continue the same session.

Status: private owner-only pilot. See [docs/runbook.md](docs/runbook.md) for what is live and [docs/launch-gates.md](docs/launch-gates.md) for what must be true before anyone else can sign up.

## How it works

```
Gmail ──► Resend inbound ──► relay (Cloudflare Worker, D1, R2)
                               │  Jev routes model/effort/speed and the project folder
                               ▼
                 tagmails agent on your computer (polls, signed claims)
                               │  runs Codex app-server or Claude CLI in that folder
                               ▼
                relay ──► Resend outbound ──► reply in the same Gmail thread
```

- **Agent** (`crates/tagmails-daemon`, binary `tagmails`): pairs with the relay, runs as a launchd agent (macOS) or systemd user service (Linux), publishes the machine's model list and recent Codex/Claude project folders, claims jobs, and runs the Node adapters in `agent/`. It only runs in folders it published itself, or, when no project fits, a chat folder (`~/Documents/Codex/<date>/<subject>` for Codex, `~/.tagmails/chats/…` otherwise) that the thread keeps.
- **Relay** (`services/`): Resend webhooks, Google sign-in, pairing, the job queue, routing (`jev-route.mjs` for model, `project-route.mjs` for folder), the outbox, status reactions, test credits, and run artifacts.
- **Site** (`site/`, a submodule): the landing page, `/setup`, and `/run`. Plain HTML/CSS/JS, no build step.
- **Lab** (`apps/mock-inbox`): a local Gmail-like inbox for testing the whole loop without real mail. `mail.mjs` and `markdown.mjs` there are the email renderers the relay uses.

## Using the agent

```sh
brew install swaymun/tagmails/tagmails          # or: curl -fsSL https://tagmails.com/install.sh | sh
tagmails pair tm_pair_…                          # code from https://tagmails.com/setup
tagmails start --access read --projects          # or --workspace /path, --access write|full
tagmails status
```

`tagmails logs`, `tagmails stop`, `tagmails open <thread-id>` (resume an email thread's session in Codex/Claude), and `tagmails uninstall` cover the rest. Config lives in `~/.config/tagmails/`, data in `~/Library/Application Support/TagMails` (macOS) or `~/.local/share/tagmails` (Linux).

## Development

```sh
npm ci
npm test                                  # relay, adapters, lab and site tests (node --test)
cargo test -p tagmails-daemon             # agent CLI, claims, routing, service files
npm run lab                               # local inbox at http://127.0.0.1:4177
cargo run -p tagmails-daemon -- --once    # mock agent processing one lab job
npm run eval:email                        # render every reply state and check the MIME
npm run eval:model-routing                # Jev model-routing cases (needs a TypeSafe key)
```

Project routing is documented in [docs/project-routing.md](docs/project-routing.md). Rerun its studies before changing the prompt, fields or threshold.

## Releasing the agent

```sh
node scripts/package-agent.mjs            # needs zig + cargo-zigbuild and the four rustup targets
```

This builds `tagmails-<version>-<target>.tar.gz` for macOS and Linux on arm64 and x86_64, a source tarball, `install.sh`, `SHA256SUMS`, and `Formula/tagmails.rb`. Upload the archives to a `v<version>` release on `swaymun/homebrew-tagmails` and commit the formula there. Copy `packaging/install.sh` into `site/dist/` when it changes. Bump the version in both `agent/package.json` and `crates/tagmails-daemon/Cargo.toml`.

## Deploying

See [docs/runbook.md](docs/runbook.md). In short: apply D1 migrations, deploy the Worker with `wrangler deploy --env dev`, then publish `site/dist`.

## Docs

- [docs/runbook.md](docs/runbook.md): live pilot state, deploy steps, checks, stop conditions
- [docs/launch-gates.md](docs/launch-gates.md): what must be proven before customers
- [docs/email-privacy.md](docs/email-privacy.md): why customer mail can't go through the current Resend setup
- [docs/provider-paths.md](docs/provider-paths.md): OpenAI/Anthropic terms questions for a paid beta
- [docs/pricing.md](docs/pricing.md): pricing model inputs
- [docs/email-format.md](docs/email-format.md): reply email and status reaction contract
- [docs/project-routing.md](docs/project-routing.md): how a folder is chosen, what the machine shares, and the context study
- [docs/self-hosting.md](docs/self-hosting.md): run your own relay

Licensed MIT.
