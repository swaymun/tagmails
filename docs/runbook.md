# Pilot runbook

Owner-only development pilot: the owner's Gmail, the `tagmails-relay-dev` Worker, and the owner's Mac. Not a public launch.

## What is live

- **Relay**: `https://tagmails-relay-dev.saimun-shahee.workers.dev` (Worker `tagmails-relay-dev`, D1 `tagmails-relay-dev`, R2 `tagmails-relay-mail-dev`, Durable Object `DevicePush`). Config is the `dev` env in `wrangler.jsonc`.
- **Site**: Cloudflare Worker `tagmails-site` at `https://tagmails-site.saimun-shahee.workers.dev`, private behind Cloudflare Access (owner only). Source is the `site` submodule (`swaymun/tagmails-site`); the relay's `SITE_ORIGIN` points at it. `tagmails.com` is not yet pointed at it.
- **Mail**: agent addresses on `tagmails.com`. Inbound arrives through Cloudflare Email Routing at the Worker's `email()` handler and is trusted only on a DKIM signature from the sender's domain; replies and status reactions go out through the Email Sending binding. The Resend webhook route stays for self-hosted relays.
- **Routing**: Jev (`TYPESAFE_API_KEY`) picks model, effort and speed from plain language, the project folder for new threads, and whether a mid-run follow-up steers the live turn. Replies inherit model and folder.
- **Billing**: `BILLING_LIVE` is set; a charge needs a live Stripe key and webhook secret as well. See [pricing.md](pricing.md).

## Deploy

`AGENTS.md` has the details. In short:

- Relay: push to `main`. `.github/workflows/deploy.yml` runs `npm test`, applies D1 migrations, and deploys `--env dev`. Migrations are additive and land before the Worker that reads them.
- Site: push the `site` submodule's `main`; its own workflow deploys the `tagmails-site` Worker. Then commit the submodule pointer here.
- Agent: cut a Homebrew release (`node scripts/package-agent.mjs`), then on the Mac `brew upgrade tagmails && tagmails status`. For `agent/`-only changes, `scripts/sync-agent.sh`.

After a relay deploy, send one owner Gmail task and confirm: 👀 reaction, the reply in the same thread, the run page, and `tagmails status` showing the computer checked in.

## Next checks

1. Website cutover: point `tagmails.com` / `www` at the `tagmails-site` Worker, add both origins to the Google OAuth client, and update `SITE_ORIGIN` and `SITE_ALLOWED_ORIGINS`. Keep every mail DNS record untouched and record the old values for rollback.
2. Project routing in production: a few emails that name a project, one that doesn't, and one standalone question. Check the chosen folder in the footer, and that an unclear email runs in a chat folder its replies keep.
3. Steering: a same-sender follow-up joins the run; a participant's follow-up queues as its own job.
4. Clean install from the Homebrew tap and from `install.sh` on a second Mac and a Linux box.
5. Before any customer: settle what plaintext mail the relay keeps. See [email-privacy.md](email-privacy.md) and [launch-gates.md](launch-gates.md).

## Stop conditions

Stop and keep the job and provider IDs if a reply goes to the wrong recipient, a send is duplicated, two computers claim one thread, an agent runs in a folder it didn't publish, a run claims an unverified file change, a participant gets access without an owner grant, a participant's text reaches an owner turn, or a signed event can't be matched to its provider record. Don't retry an uncertain send until the provider's records show whether it was accepted.
