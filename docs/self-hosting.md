# Self-hosting

A relay is one Cloudflare Worker with D1, R2, a Durable Object and a one-minute cron, plus Google sign-in and a mail provider (Resend, or Cloudflare Email Routing and Sending). Test billing and the website are not needed and stay off.

Step-by-step setup, every secret, checks and common failures: [setup-for-agents.md](setup-for-agents.md). It works for a person too.

What to know before relying on it:

- This configuration has local tests (duplicate mail, account isolation, participant authorization, the no-Site run link) but has not been run end to end in a fresh Cloudflare account. Keep the first deployment to your own Gmail and a disposable workspace.
- Sign-in accepts personal `@gmail.com` accounts only. With `PUBLIC_SIGNUP_ENABLED` unset, only `PILOT_OWNER_EMAIL` can sign in.
- Without `SITE_ORIGIN`, reply links go to the Worker's own owner-only `/runs/<job-id>` page.
- Without a `STORAGE_KEY`, raw mail and results sit in R2 in plaintext. On the Resend path, Resend also keeps message bodies; see [email-privacy.md](email-privacy.md).
- A send with an uncertain outcome is held, never retried automatically. Check the provider's records before resending.
- Provider costs (Cloudflare, Resend, model usage on your own Codex or Claude plan) are yours.
