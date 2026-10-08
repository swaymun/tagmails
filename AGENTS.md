# TagMails

Email-to-agent relay: a Cloudflare Worker (`services/`, `apps/mock-inbox/`, D1 + R2) hands mail to a Rust daemon on the owner's Mac (`crates/tagmails-daemon/`) that runs Codex or Claude Code through the Node adapters in `agent/`. Site lives in the private `site` submodule. Pilot is owner-only on `tagmails-relay-dev`.

## Checks

- `npm test` (Node, ~1 min; the full agent suite is slow only if a fake CLI hangs) and `cargo test -p tagmails-daemon`.
- Jev routing prompts are checked against the live API with `npm run eval:model-routing` and `node scripts/research-steer.mjs` (needs `TYPESAFE_API_KEY`, or `~/.config/wonder/jev.json`). Both cost fractions of a cent.
- After a change is committed locally, push it to `origin main` without asking. Pushes to `services/`, `apps/` or `wrangler.jsonc` also deploy the relay.
- Don't commit `calls.jsonl` (test noise) or the `site` submodule pointer unless asked.

## Deploying the relay

Pushing to `main` deploys automatically (`.github/workflows/deploy.yml`: tests, D1 migrations, `wrangler deploy --env dev`). It needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets. Manual fallback from the repo root:

```sh
npx wrangler d1 migrations apply tagmails-relay-dev --remote --env dev   # additive; apply before the Worker that reads the columns
npx wrangler deploy --env dev
```

Migrations go in `services/migrations/NNNN_name.sql`; the test fixture applies them all in order. SQLite `CHECK` constraints can't be altered in place, so prefer new nullable columns over new enum values.

## The Site

`site/` is the private `swaymun/tagmails-site` repo (static `dist/`), hosted as the Cloudflare Worker `tagmails-site` served publicly at `tagmails.com` and `www.tagmails.com`. Pushing to its `main` deploys via its own workflow, which needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets in that repo. Locally: `cd site && npx wrangler deploy`. The relay's `SITE_ORIGIN` secret (CORS and the footer hand-off link, set to `https://tagmails.com`) and the Google OAuth client's authorized JavaScript origins must both list the Site's origin. After committing in `site/`, push it, then commit the submodule pointer here.

## The Mac daemon

- Installed by Homebrew (`swaymun/tagmails`), run by launchd as `com.tagmails.daemon`; adapters live in the Cellar (`tagmails status` shows `Adapters`). `tagmails start` re-saves settings, so pass the flags again (pilot: `--access write --projects`).
- **Iterate on `agent/` without a release:** `scripts/sync-agent.sh` copies this checkout's adapters over the installed ones and restarts the service. `brew upgrade tagmails` undoes it.
- **Changes in `crates/`:** rebuild with `cargo build --release -p tagmails-daemon`, then run it directly once (`target/release/tagmails run --once`) or cut a release.
- **Release:** bump the version in both `agent/package.json` and `crates/tagmails-daemon/Cargo.toml`, run `node scripts/package-agent.mjs` (cross-builds with cargo-zigbuild; `brew install zig`), upload to the `swaymun/homebrew-tagmails` release, update `Formula/tagmails.rb`, then `brew upgrade tagmails && tagmails status`. A relay change that needs a newer daemon must degrade gracefully for older ones (e.g. extra response fields are ignored).
- Jobs run in parallel (default 3, `TAGMAILS_MAX_JOBS`), one per project folder: claims send `busyFolders` and the relay skips jobs routed there. Runners share `sessions.json` files, so write them only through `agent/session-store.mjs`.
- Owner `write` turns: Codex reads the whole Mac, writes the workspace, temp and the repo's git folder, and has network (so `git push`/`gh` work); Claude `auto` drops `--restricted` and runs like Claude Code. Participants keep the closed profiles. Codex's own state (`~/.codex`) stays read-only, so an app that runs a nested `codex` needs a workspace-local `CODEX_HOME`.
- A new project folder is routable only after a Codex project or Claude session exists there (`agent/project-inventory.mjs`); restart the service to republish sooner than the 15-minute refresh.
- Logs: `tagmails logs`; each job logs a `running <model> in <folder>` line and its result state. Reinstall the service: `tagmails uninstall && tagmails start ...`.

## Working method

- Define done as a check that can pass or fail, plus the evidence: test output, the stored row, the log line, or the real email in Gmail. Say whether a claim is measured, inferred or guessed. Never hand the owner a check you could run.
- Reproduce a defect on the surface where it happens (a real email to the pilot agent, or `npm run lab`) before fixing it, then fix the root cause. After two fixes sharing one premise fail, question the premise.
- When a question can be settled by running something (routing, timing, rendering in Gmail), try it and let the result decide. Ask only for product calls and actions this file doesn't authorize.
- Fix a repeated mistake at the strongest layer: one owner in the code, then a test whose failure names the fix. Add a rule here only for judgment calls.
- For repetitive audits or checks, write a rerunnable script under `scripts/` instead of working by hand.
- You own delegated work: read a subagent's diff and evidence yourself.
- For long or unattended runs, keep a short decision log under `.local/` and report the decisions that changed the outcome.

## Tests

- Before adding a test, name the contract and the regression it guards, and extend the existing owner (its fixture or table) when that covers it. Don't test copies of source strings or a mock's own behavior.
- Remove dead production paths together with their tests and docs.
- Live checks email only the owner's own agent address and touch only threads the check created.

## Delivery

- Commit verified, coherent changes and push. Stage only intended paths; never reset, stash or force-push over concurrent work.
- For browser or Mac UI checks prefer the Codex computer-use MCP (`cua_repl`); for Gmail, the Gmail connector.

## Conventions

- Emails: lead with the answer; plain call4.me-style pages, no decoration.
- Models: Codex `gpt-6-sol`/`gpt-6-luna`, Claude `claude-sonnet-5-5`; availability comes from the Mac's live catalog (`/api/device/models`). A model route needs one Jev choice per model, or probability splits and nothing clears the threshold.
- Follow-ups sent mid-run are classified by Jev (`services/steer-route.mjs`): steer joins the live turn (Codex `turn/steer`, Claude stream-json `priority: "next"`), queue waits, ack is dropped. Undelivered steers requeue.
