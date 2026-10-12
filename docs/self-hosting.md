# Self-hosting

A relay is one Cloudflare Worker (`services/relay-worker.mjs`) with a D1 database, an R2 bucket, a Durable Object and a one-minute cron, plus Google sign-in and a mail path. Billing and the tagmails.com website are not needed and stay off. Only the owner's Gmail can sign in.

Setting this up with a coding agent? Give it [setup-for-agents.md](setup-for-agents.md).

## What you need

- Node.js 22+ and this repo: `npm ci` installs Wrangler.
- A Cloudflare account, logged in with `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exported).
- A domain for agent addresses (`name@AGENT_DOMAIN`). Pick one mail path:
  - **Cloudflare (default):** the domain is a zone in your Cloudflare account and nothing else receives mail there, because Email Routing takes over its MX records. Replies go out through Cloudflare Email Sending, which needs the Workers Paid plan. Mail passes only through Cloudflare.
  - **Resend:** the domain is verified in Resend for receiving and sending. Works on the Workers free plan; Resend keeps message bodies.
- Your personal `@gmail.com` address. Sign-in accepts personal Gmail accounts only.
- A Google Cloud OAuth client of type **Web application**. You can create it after the first deploy, once you know the Worker URL. If its consent screen is in testing mode, add your Gmail as a test user. Sign-in asks for identity only, no Gmail scopes.
- A Mac or Linux machine with a signed-in `codex` or `claude` CLI and the `tagmails` agent.

## 1. Deploy

From the repo root:

```sh
npm ci
node scripts/self-host-setup.mjs
```

The script asks for the Worker name, mail path, agent domain, your Gmail and (optionally) the Google client ID, then:

1. writes `wrangler.selfhost.jsonc` from `wrangler.selfhost.example.jsonc` and `.env.selfhost` with the Worker's secrets (both git-ignored; secrets are never printed),
2. generates `STORAGE_KEY`,
3. creates the D1 database and R2 bucket if they don't exist,
4. applies `services/migrations`,
5. deploys with `--secrets-file .env.selfhost` and sets `PUBLIC_ORIGIN` to the Worker URL,
6. on the Cloudflare path, with your consent, enables Email Routing, routes the domain's catch-all to the Worker and enables Email Sending,
7. checks `/api/auth/config` and `/api/device/claim`, then prints what's left.

Rerun it any time: it keeps saved values, creates only what is missing, applies new migrations and redeploys. Every prompt can be answered with an environment variable of the same name (listed at the top of the script).

## 2. Finish sign-in and mail

The script prints these with your values filled in.

- **Google:** add the Worker origin (for example `https://tagmails-selfhost.<subdomain>.workers.dev`) as an authorized JavaScript origin of the OAuth client. If you skipped the client ID, rerun the script and paste it.
- **Cloudflare mail**, if you didn't let the script do it: in the dashboard, enable Email Routing on the domain, add a catch-all rule *Send to a Worker* pointing at your Worker, and enable Email Sending for the domain. The same thing from the CLI:
  ```sh
  npx wrangler email routing enable $AGENT_DOMAIN
  npx wrangler email routing rules update $AGENT_DOMAIN catch-all --action-type worker --action-value tagmails-selfhost --enabled
  npx wrangler email sending enable $AGENT_DOMAIN
  ```
  Then add any DNS records the dashboard asks for.
- **Resend mail:** create a webhook to `<origin>/webhooks/resend` for `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`. Rerun the script and paste its signing secret. Resend's test delivery should get a 200.

## 3. Pair a machine

1. Open `<origin>/account`, sign in with your Gmail and create a pairing code (valid 10 minutes, once).
2. On the machine:
   ```sh
   brew install swaymun/tagmails/tagmails      # or: curl -fsSL https://tagmails.com/install.sh | sh
   tagmails pair tm_pair_… --relay <origin>
   tagmails start --projects
   tagmails status
   ```
   Or run `tagmails pair --relay <origin>` with no code: it prints a `<origin>/connect` link to approve after signing in. `<origin>/skill.md` is the same setup as a skill for Codex or Claude Code ("Read <origin>/skill.md and set up Tagmails").
3. From your Gmail, email the agent address shown on the account page. `npx wrangler tail --config wrangler.selfhost.jsonc` shows the mail arrive, `tagmails logs` shows the claim, and the reply lands in the same thread with a `/runs/<id>` link only you can open.

## Configuration reference

Secrets live in `.env.selfhost`; the script uploads them on every deploy. You can also set one directly with `npx wrangler secret put NAME --config wrangler.selfhost.jsonc`.

| Name | Required | Value |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | `….apps.googleusercontent.com`. Without it sign-in returns 503. |
| `AGENT_DOMAIN` | yes | The mail domain. New accounts get `u-…@AGENT_DOMAIN`. |
| `PUBLIC_ORIGIN` | yes | The Worker origin, no path. Used for run links in replies. |
| `PILOT_OWNER_EMAIL` | yes | Your Gmail. Anyone else is refused at sign-in. |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend path only | API key with sending and receiving access; the webhook's signing secret. |
| `STORAGE_KEY` | recommended (the script sets it) | 32 random bytes, base64. Encrypts (AES-256-GCM) what the relay keeps under its own key: its own replies, held requests and your computer's project list. Mail and results for paired computers are sealed to the computer's key either way. Set it before the first mail and never change it. |

Variables (put them under `vars` in `wrangler.selfhost.jsonc`): `CLAUDE_ROUTE_ENABLED=true` (the script sets it; without it Claude model requests get a clarification), `STATUS_REACTIONS_ENABLED=true` (Gmail status reactions), `ADDRESS_DOMAIN` (lets you choose `name@domain`), `PILOT_CODEX_MODEL`, `RESEND_TEST_FROM=onboarding@resend.dev` (replies before your Resend domain verifies). The rest (`SITE_*`, `GOOGLE_CLIENT_SECRET`, `BILLING_*`, `STRIPE_*`, `PUBLIC_SIGNUP_ENABLED`) are for the hosted service; leave them unset.

Bindings the config defines: D1 `DB`, R2 `MAIL`, Durable Object `DEVICE_PUSH` (without it daemons poll every 15 s), cron `* * * * *` (sends replies and cleans up), rate limits `PUBLIC_RATE_LIMIT` and `AUTH_RATE_LIMIT` (`namespace_id` 1001 and 1002 must be unused in your account), and on the Cloudflare path `send_email` as `EMAIL`.

## Common failures

| Symptom | Cause |
| --- | --- |
| "This Tagmails relay accepts sign-in only from its owner" | You signed in with an address other than `PILOT_OWNER_EMAIL`. |
| Google button missing or sign-in fails | `GOOGLE_CLIENT_ID` is still `pending` (rerun the script with the real ID), or `AGENT_DOMAIN` isn't a plain domain. |
| Google popup error `origin_mismatch` | The Worker origin isn't an authorized JavaScript origin. |
| Deploy fails on a rate limit | `namespace_id` 1001 or 1002 is taken in your account. Change it in `wrangler.selfhost.jsonc`. |
| Resend webhook returns 500 | Wrong `RESEND_WEBHOOK_SECRET`, or the API key lacks receiving access. |
| Mail accepted, nothing claimed | No paired machine, the service is stopped, or the sender isn't you or a participant on that thread. |
| "Sender authentication did not pass DMARC or aligned DKIM" | The mail was forwarded or sent through another server. Send directly from Gmail, with the agent in To or Cc (not Bcc). |
| Job claimed, reply never arrives | Email Sending (or the Resend sending domain) isn't set up for `AGENT_DOMAIN`. A send with an uncertain outcome is held, never retried; check the provider before resending. |
| `Encrypted storage needs STORAGE_KEY` | The key was removed or changed after data was sealed. Restore the original value. |
| `tagmails pair` says the code expired | Codes last 10 minutes and work once. Create a new one. |

## Before relying on it

- This configuration is covered by local tests (duplicate mail, account isolation, participant authorization, run links without the website) but has not been run end to end in a fresh Cloudflare account. Start with your own Gmail and a disposable folder (`tagmails start --access read --claude-permission manual --workspace ~/tagmails-scratch`).
- Without `STORAGE_KEY`, the relay's own replies and your project list sit in R2 and D1 in plaintext; mail for paired computers is still sealed to their keys. See [email-privacy.md](email-privacy.md) for what the relay keeps.
- Provider costs (Cloudflare, Resend, your Codex or Claude plan) are yours.
