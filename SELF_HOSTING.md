# Self-hosting starter

This is an **unverified deployment guide** for the current TagMails relay source. It uses one Cloudflare Worker, D1, R2, Google sign-in, and Resend. It leaves test billing and the separate ChatGPT Site disabled. The Worker itself serves `/account` and an owner-only `/runs/<job-id>` receipt. No production deployment or full live email loop has been verified with this configuration yet.

## What you need

- Node.js 20.19+, a Cloudflare account with Workers, D1, and R2, and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/commands/) installed by `npm ci`.
- A domain you control for both Resend receiving and sending. The Resend-provided `.resend.app` domain is useful for receiving tests, but plan a verified sending domain before expecting normal replies. Configure Resend to receive mail for the exact domain in `AGENT_DOMAIN`.
- A Google Cloud project with a Google Identity Services **Web application** client. Add the Worker's exact HTTPS origin (scheme and host, no path) to Authorized JavaScript origins. Google sign-in here requests identity, not Gmail or Drive access. If the OAuth app is in testing mode, add the Gmail account you will use as a test user. [Google setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
- A local Mac with the TagMails Rust daemon and a signed-in Codex or Claude Code CLI for actual tasks.

## Create the relay

From this checkout:

```sh
npm ci
cp wrangler.selfhost.example.jsonc wrangler.selfhost.jsonc
npx wrangler login
npx wrangler d1 create tagmails-selfhost
npx wrangler r2 bucket create tagmails-selfhost-mail
```

Wrangler prints the new D1 database UUID. Replace the all-zero `database_id` in the ignored `wrangler.selfhost.jsonc` with it **before deployment**. If you change the Worker, D1, or R2 names, keep the config and commands consistent. Pick the Worker's final `workers.dev` origin from your Cloudflare account before configuring Google or Resend. `PUBLIC_ORIGIN` must be that exact origin, since scheduled outbound sends have no incoming request URL to derive it from.

Apply the schema to **your new database**, then make a local `.env.selfhost` file (already git-ignored):

```sh
npx wrangler d1 migrations apply tagmails-selfhost --remote --config wrangler.selfhost.jsonc
```

```dotenv
RESEND_API_KEY=re_your_resend_key
RESEND_WEBHOOK_SECRET=replace_after_webhook_creation
GOOGLE_CLIENT_ID=your_web_client_id.apps.googleusercontent.com
AGENT_DOMAIN=mail.example.com
PUBLIC_ORIGIN=https://tagmails-selfhost.your-subdomain.workers.dev
```

The temporary webhook value is only for the first deploy. Do not send mail to the relay yet. Deploy the Worker and upload these five values as encrypted Worker secrets:

```sh
npx wrangler deploy --config wrangler.selfhost.jsonc --secrets-file .env.selfhost
```

In Resend, create a webhook for `https://tagmails-selfhost.your-subdomain.workers.dev/webhooks/resend` with `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, and `email.suppressed` events. The signed sent event can reconcile a reply whose send response was lost; delivery events update the owner receipt for each reported recipient. Copy that webhook's signing secret into `.env.selfhost`, replacing the temporary value, and deploy the same command again. Confirm the deployed URL matches `PUBLIC_ORIGIN` and your Google OAuth origin. Do not send a real test message until the actual signing secret is deployed. [Resend inbound setup](https://resend.com/features/inbound) · [Resend sent events](https://resend.com/changelog/message-id-for-sent-emails) · [Resend recipient events](https://resend.com/changelog/webhook-event-visibility) · [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

Do not set `BILLING_TEST_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_TEST_FROM`, or `SITE_ORIGIN` for this path. Without test billing, the relay does not reserve test credits; without `SITE_ORIGIN`, owner-addressed replies link to the Worker's authenticated receipt. This does **not** remove provider costs or create a paid customer service.

## Check before live mail

Open `<PUBLIC_ORIGIN>/account` and sign in using the Gmail account listed as an OAuth test user. Check that it shows an agent address under `AGENT_DOMAIN`. Create a one-time pairing code on that page. On your Mac, pair a **disposable** workspace, keeping the device token outside it:

```sh
mkdir -p "$HOME/.config/tagmails"
chmod 700 "$HOME/.config/tagmails"
TAGMAILS_RELAY_URL=https://tagmails-selfhost.your-subdomain.workers.dev \
TAGMAILS_DEVICE_TOKEN_FILE="$HOME/.config/tagmails/device-token" \
cargo run -p tagmails-daemon -- --pair 'tm_pair_CODE_FROM_ACCOUNT_PAGE'
```

Use the actual one-time code from the account page and your exact relay origin. Start the daemon in read-only mode using the [relay command in README.md](README.md#local-relay-proof), or preview its macOS LaunchAgent first. The token file is created with owner-only access; do not place it in the agent workspace.

Only after the Worker, webhook, domain, and paired daemon are ready, send one small message from that Gmail address to its generated agent address. Confirm a signed webhook reached the Worker, one job was claimed and completed, one reply was accepted by Resend, and the reply's `/runs/<job-id>` link opens only for the owner. Check the Resend dashboard and Worker logs if any step fails. If a send has an uncertain outcome, do not repeat it until provider acceptance has been checked; the relay will not retry it automatically. A successful local bundle or synthetic test alone does not prove delivery.

The current source has local tests for duplicate mail, account isolation, participant authorization, and the no-Site receipt URL. This guide has not been exercised in a fresh Cloudflare account. Keep the first deployment private to your own test Gmail and disposable workspace until the live loop and recovery behavior are checked.
