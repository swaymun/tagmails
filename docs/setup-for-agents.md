# Relay setup for a coding agent

Everything needed to stand up a TagMails relay unattended, in order, with a check after each step. The human has to do three things an agent can't: create the Google OAuth client, create the Resend account and webhook, and log in to Cloudflare. Ask for those values up front.

This path uses Resend for mail, matching `wrangler.selfhost.example.jsonc`. The pilot relay instead uses Cloudflare Email Routing and Email Sending; see [Cloudflare mail](#cloudflare-mail-instead-of-resend).

## Prerequisites

- Node.js 20.19+ and npm. `npm ci` installs Wrangler 4.
- A Cloudflare account with Workers, D1, R2 and Durable Objects (all on the free plan), and `npx wrangler login` done, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exported.
- A domain for agent addresses, verified in Resend for receiving and sending.
- A Google Cloud **Web application** OAuth client. Authorized JavaScript origin: the Worker's exact origin, e.g. `https://tagmails-selfhost.<subdomain>.workers.dev`. If the app is in testing mode, add the owner Gmail as a test user. Sign-in requests identity only, no Gmail scopes.
- The owner's personal Gmail address. Only `@gmail.com` accounts can sign in.
- For running tasks: a Mac or Linux machine with the `tagmails` agent and a signed-in `codex` or `claude` CLI.

## Cloudflare resources

| Resource | Binding | Name in the example config | Without it |
| --- | --- | --- | --- |
| Worker | | `tagmails-selfhost` (`services/relay-worker.mjs`) | |
| D1 database | `DB` | `tagmails-selfhost` | Every route fails. |
| R2 bucket | `MAIL` | `tagmails-selfhost-mail` | Raw mail, results and files can't be stored. |
| Durable Object | `DEVICE_PUSH` (class `DevicePush`, migration `v1-device-push`) | | Daemons fall back to polling every 15 s. |
| Cron trigger | | `* * * * *` | Replies never send, clarifications never complete, cleanup stops. |

## Secrets and variables

Required. Put them in `.env.selfhost` (git-ignored) and upload with `--secrets-file`.

| Name | Value | Where it comes from | Without it |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | `re_…` | Resend → API keys (sending + receiving access) | Webhook intake returns 500; replies can't send. |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` | Resend → Webhooks, after creating the webhook (step 6) | Webhook intake returns 500. |
| `GOOGLE_CLIENT_ID` | `….apps.googleusercontent.com` | Google Cloud → Credentials | `/api/auth/config` returns 503; nobody can sign in. |
| `AGENT_DOMAIN` | `mail.example.com` | Your Resend domain | Sign-in returns 503. New accounts get `u-…@AGENT_DOMAIN`. |
| `PUBLIC_ORIGIN` | `https://tagmails-selfhost.<subdomain>.workers.dev` | The deployed Worker URL, no path | Replies have no run link (cron sends have no request URL to derive it). |
| `PILOT_OWNER_EMAIL` | `you@gmail.com` | The owner | Sign-in returns 403 "signup is closed" unless `PUBLIC_SIGNUP_ENABLED=true`. |

Recommended:

| Name | Value | Effect |
| --- | --- | --- |
| `STORAGE_KEY` | `openssl rand -base64 32` | Seals R2 objects and D1 subjects with AES-256-GCM. Set it before the first mail and never change or remove it: sealed data can't be read without the same key. |
| `TYPESAFE_API_KEY` | TypeSafe key | Jev routing: natural-language model/effort/speed, project folder choice, and mid-run steering. Without it, `Model:` lines and account defaults still work, threads run in a chat folder, and follow-ups queue. |

Optional, leave unset unless you need them: `ADDRESS_DOMAIN` (lets users pick `name@domain`), `CLAUDE_ROUTE_ENABLED=true` (otherwise Claude model requests get a clarification), `STATUS_REACTIONS_ENABLED=true` (Gmail 👀/✅ reactions), `PUBLIC_SIGNUP_ENABLED=true` (any Gmail can sign up), `PILOT_CODEX_MODEL`, `MAIL_DELIVERY_READY` (account page wording only), `RESEND_TEST_FROM=onboarding@resend.dev` (owner-only replies before the sending domain verifies). Site only: `SITE_ORIGIN`, `SITE_ALLOWED_ORIGINS`, `GOOGLE_CLIENT_SECRET`, `SITE_PARTICIPANT_TRANSCRIPTS`. Billing: `BILLING_TEST_MODE`, `BILLING_LIVE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; without them no credits are reserved or charged.

## Steps

Run from the repo root. `$ORIGIN` is the Worker origin.

1. **Install and configure.**
   ```sh
   npm ci && npm test
   cp wrangler.selfhost.example.jsonc wrangler.selfhost.jsonc
   ```
   Check: tests pass.

2. **Create storage.**
   ```sh
   npx wrangler d1 create tagmails-selfhost
   npx wrangler r2 bucket create tagmails-selfhost-mail
   ```
   Put the printed D1 UUID into `database_id` in `wrangler.selfhost.jsonc`. Check: `npx wrangler d1 list` and `npx wrangler r2 bucket list` show both.

3. **Apply migrations.**
   ```sh
   npx wrangler d1 migrations apply tagmails-selfhost --remote --config wrangler.selfhost.jsonc
   ```
   Check: `npx wrangler d1 migrations list tagmails-selfhost --remote --config wrangler.selfhost.jsonc` shows nothing pending.

4. **Write `.env.selfhost`** with the required values. Use `RESEND_WEBHOOK_SECRET=whsec_placeholder` for now.

5. **Deploy.**
   ```sh
   npx wrangler deploy --config wrangler.selfhost.jsonc --secrets-file .env.selfhost
   ```
   Check: the printed URL equals `PUBLIC_ORIGIN` and the Google origin. Then:
   ```sh
   curl -s $ORIGIN/api/auth/config                 # {"clientId":"…"}
   curl -s -o /dev/null -w '%{http_code}\n' -X POST $ORIGIN/api/device/claim   # 401
   ```

6. **Create the Resend webhook** for `$ORIGIN/webhooks/resend` with events `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`. Put its signing secret in `.env.selfhost` and repeat step 5. Check: Resend's test delivery shows 200 (an ignored event returns `{"accepted":false}`).

7. **Sign in and pair.** Open `$ORIGIN/account`, sign in as `PILOT_OWNER_EMAIL`, create a pairing code. On the agent machine:
   ```sh
   tagmails pair 'tm_pair_…' --relay $ORIGIN
   tagmails start --access read --workspace ~/tagmails-scratch
   tagmails status
   ```
   Check: `status` shows the relay, paired, and the service running; the account page lists the device.

8. **First mail.** From the owner Gmail, send a one-line question to the agent address shown on the account page. Check: `npx wrangler tail --config wrangler.selfhost.jsonc` shows the webhook, `tagmails logs` shows a claim, and the reply arrives in the same thread within a couple of minutes with a `/runs/<id>` link that opens only for the owner.

## Common failures

| Symptom | Cause |
| --- | --- |
| "TagMails signup is closed during the private pilot" | `PILOT_OWNER_EMAIL` unset or a different address. |
| Google button says sign-in is unavailable | `GOOGLE_CLIENT_ID` or `AGENT_DOMAIN` missing, or `AGENT_DOMAIN` isn't a plain domain. |
| Google popup error `origin_mismatch` | The Worker origin isn't an authorized JavaScript origin. |
| Webhook returns 500 | Wrong `RESEND_WEBHOOK_SECRET`, or `RESEND_API_KEY` lacks receiving access. Logs say "Inbound mail intake failed". |
| Mail accepted, nothing claimed | No paired device, the daemon is stopped, or the sender is not the owner and not a thread participant (`{"accepted":false}`). |
| "Sender authentication did not pass DMARC or aligned DKIM" | The mail was forwarded or sent from an unauthenticated server. Send directly from Gmail. |
| Job claimed, reply never arrives | Cron trigger missing, or Resend can't send from `AGENT_DOMAIN`. A send with an uncertain outcome is held, not retried; check Resend before resending. |
| `Encrypted storage needs STORAGE_KEY` | The key was removed or changed after data was sealed. Restore the original value. |
| `tagmails pair` says the code expired | Codes last 10 minutes and work once. Create a new one. |

## Cloudflare mail instead of Resend

The pilot relay receives at the Worker's `email()` handler and sends through the Email Sending binding, so no third party holds message bodies. To do the same: put the domain on Cloudflare, enable Email Routing with a rule (or catch-all) that sends to the Worker, add `"send_email": [{ "name": "EMAIL" }]` to the config, and verify the domain for Email Sending. The relay then trusts a sender only on a DKIM signature from the From domain that covers From and the whole body. `RESEND_*` can be left unset; replies with an uncertain outcome are then held for manual review.

## Setup prompt

Copy this to a coding agent in a fresh checkout:

```text
Set up a self-hosted TagMails relay from this repo by following docs/setup-for-agents.md exactly.
Before you start, ask me for: the Cloudflare account to use, the Worker name (default
tagmails-selfhost), my agent mail domain, my Gmail address, the Google OAuth client ID, the
Resend API key, and whether to enable TYPESAFE_API_KEY. Generate STORAGE_KEY yourself with
`openssl rand -base64 32` and store it only in .env.selfhost. Never print secret values or
commit .env.selfhost or wrangler.selfhost.jsonc. Run each step's check and stop on the first
failure with the exact error. When you reach the Resend webhook step, give me the URL and event
list and wait for the signing secret. Finish by telling me the agent address and the
tagmails pair command to run, and do not send any email yourself.
```
