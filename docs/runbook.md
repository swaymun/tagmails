# Pilot runbook

Owner-only development pilot: the owner's Gmail, a dedicated Resend development account, the `tagmails-relay-dev` Worker, and the owner's Mac. Not a public launch.

## What is live

- **Relay**: `https://tagmails-relay-dev.saimun-shahee.workers.dev` (Worker `tagmails-relay-dev`, D1 `tagmails-relay-dev`, R2 `tagmails-relay-mail-dev`). Google sign-in is limited to `PILOT_OWNER_EMAIL`; `PUBLIC_SIGNUP_ENABLED` is unset.
- **Site**: `https://tagmails.saimun-h-shahee.chatgpt.site` (source `site/dist`, repo `swaymun/tagmails-site`). Custom domains `tagmails.com` / `www` are added but pending; the apex still points at GoDaddy's site builder.
- **Mail**: the agent receives at its Resend-provided `.resend.app` address and replies to the owner from `onboarding@resend.dev` with Reply-To set to the agent. Resend reports `tagmails.com` partially verified (DKIM, `send` CNAME and inbound MX verified; `rsend` CNAME pending). Gmail reactions can't attach to test-sender replies.
- **Routing**: Jev (`TYPESAFE_API_KEY`) picks model, effort and speed from plain language, and the project folder for new threads when the computer publishes projects. Replies inherit both.
- **Billing**: Stripe test mode only; five test cents per accepted task email.
- **Proven October 3–4**: owner Gmail → relay → paired Mac (Codex GPT-6 Sol/Luna) → threaded Gmail reply with private run link, including same-thread follow-ups, natural-language model requests, the Mac's live model catalog, full-access owner turns, and small file attachments.

## Deploy

Deploys run through the Codex CLI. From the repo root:

1. `npm test && cargo test -p tagmails-daemon`
2. Relay: `npx wrangler d1 migrations apply tagmails-relay-dev --remote --env dev`, then `npx wrangler deploy --env dev`. Migrations are additive; apply them before the Worker that reads the new columns.
3. Site: publish `site/dist` to the TagMails Site, then commit and push the `site` submodule and the parent repo.
4. Agent: `node scripts/package-agent.mjs`, upload the archives to the `swaymun/homebrew-tagmails` release, update its `Formula/tagmails.rb`, and copy `packaging/install.sh` to `site/dist/install.sh`.
5. On the pilot Mac: `brew upgrade tagmails && tagmails start`, then `tagmails status`.

After a deploy, send one owner Gmail task and confirm: 👀 reaction (when enabled), the reply in the same thread, the run page, and `tagmails status` showing the computer checked in.

## Next checks

1. When Resend verifies sending, give the owner account an opaque `@tagmails.com` address (keep the `.resend.app` one as an alias), drop `RESEND_TEST_FROM`, and test: a new thread, a reply, an unauthorized sender, and Gmail reactions. Enable `STATUS_REACTIONS_ENABLED` only for that trial and disable it if Gmail shows fallback emails.
2. Website cutover: add `https://tagmails.com` and `https://www.tagmails.com` to the Google OAuth client, switch the apex A records to `162.159.143.30` / `172.66.3.26` and `www` to `custom-domains.chatgpt.site.`, keep every mail record untouched, then update `SITE_ORIGIN` and the relay CORS list. Record the old values for rollback.
3. Project routing in production: send a few emails that name a project, one that doesn't, and one standalone question; check the chosen folder in the footer, and that "which project?" replies resume correctly.
4. Publish the Homebrew tap and try a clean install on a second Mac and a Linux box.
5. Before any customer: replace Resend for customer mail and stop keeping plaintext customer mail in R2. See [email-privacy.md](email-privacy.md).

## Stop conditions

Stop and keep the job and provider IDs if a reply goes to the wrong recipient, a send is duplicated, two computers claim one thread, an agent runs in a folder it didn't publish, a run claims an unverified file change, a participant gets access without an owner grant, or a signed event can't be matched to its provider record. Don't retry an uncertain send until Resend's records show whether it was accepted.
