# Relay setup for a coding agent

Copy the prompt below to a coding agent in a fresh checkout of this repo. It follows [self-hosting.md](self-hosting.md) and runs `scripts/self-host-setup.mjs` without prompts by passing values as environment variables.

A person still has to do three things: log Wrangler in to Cloudflare, create the Google OAuth client, and (on the Resend path) create the Resend webhook. The agent asks for those at the right moment.

## Setup prompt

```text
Set up a self-hosted Tagmails relay from this repo by following docs/self-hosting.md.

1. Run `npm ci && npm test` and stop if tests fail. Check `npx wrangler whoami`; if it is not
   logged in, ask me to run `npx wrangler login` and wait.
2. Ask me for: the Worker name (default tagmails-selfhost), the mail path (cloudflare or resend),
   the agent mail domain, my Gmail address, whether you may enable Email Routing and Sending on
   that domain (it replaces the domain's MX records). On the
   Resend path, also ask for the Resend API key.
3. Run `node scripts/self-host-setup.mjs < /dev/null` with those values exported as WORKER_NAME,
   MAIL_PROVIDER, AGENT_DOMAIN, PILOT_OWNER_EMAIL, SETUP_MAIL_ROUTING=yes|no and
   RESEND_API_KEY. Pass secrets through the environment of that one command only.
4. Give me the Worker origin it prints and wait while I create a Google OAuth client (Web
   application) with that origin as an authorized JavaScript origin. Rerun the script with
   GOOGLE_CLIENT_ID set. On the Resend path, give me the webhook URL and event list the script
   prints, wait for the signing secret, and rerun with RESEND_WEBHOOK_SECRET set.
5. Rerun until every check the script prints says ok, and report any step under "Next" you could
   not do.

Never print secret values, never commit .env.selfhost or wrangler.selfhost.jsonc, never change
STORAGE_KEY once set, and do not send any email yourself. Stop on the first failure and show me
the exact error. Finish by telling me the account page URL and the `tagmails pair` and
`tagmails start --projects` commands to run on my machine.
```

## Notes for the agent

- The script is idempotent. Saved values in `.env.selfhost` win over prompts; an exported variable wins over a saved value. Placeholders (`GOOGLE_CLIENT_ID=pending`, `RESEND_WEBHOOK_SECRET=whsec_placeholder`) are replaced on the next run that supplies a real value.
- To change the mail path or Worker name after the first run, delete `wrangler.selfhost.jsonc` (not `.env.selfhost`) and rerun.
- Checks it runs: `GET /api/auth/config` returns 200 (503 means `GOOGLE_CLIENT_ID` or `AGENT_DOMAIN` is missing), and `POST /api/device/claim` without a device token returns 401.
- Symptoms and causes are in the [common failures](self-hosting.md#common-failures) table.
