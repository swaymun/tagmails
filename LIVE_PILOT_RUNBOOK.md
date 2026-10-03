# TagMails private live email pilot

Internal working runbook. The test is limited to the owner's Gmail, the dedicated Resend development account, the development Worker, and a disposable selected workspace. It is not a public launch check.

## Readiness snapshot — October 3, 2026

- The owner's Gmail message reached the Resend-provided receiving inbox. A fresh dashboard check at 11:52 UTC showed no API keys or webhooks and no sent mail. Its Raw tab displays a JSON email record whose `authentication-results` header reports SPF, DKIM, and DMARC pass for this Gmail message. That dashboard view omits the API's `authentication` and `raw.download_url` fields, so it does not yet prove the relay can fetch and verify the original MIME. [Resend's received-email API](https://resend.com/docs/api-reference/emails/retrieve-received-email) documents those fields.
- The development Worker is deployed at `https://tagmails-relay-dev.saimun-shahee.workers.dev`. Its existing `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` bindings contain placeholders; a binding name alone does not establish a connected provider.
- A read-only remote D1 audit returned one active account and two completed fixture jobs, with **zero outbox rows and zero queued jobs**. Repeat this audit immediately before connecting a real key; the queue may change.
- Resend offers Full access and Sending access keys. The relay retrieves received mail, reads sent-message IDs, and sends replies, so it needs **Full access** in the dedicated development account. Sending access alone cannot retrieve inbound mail. [Resend key permissions](https://resend.com/changelog/new-api-key-permissions)

## Connection order

1. Recheck the development queue without reading message bodies:

   ```sh
   npx wrangler d1 execute tagmails-relay-dev --remote --json --command "SELECT 'outbox:' || state AS item, COUNT(*) AS n FROM outbox GROUP BY state UNION ALL SELECT 'jobs:' || state AS item, COUNT(*) AS n FROM jobs GROUP BY state UNION ALL SELECT 'accounts:active' AS item, COUNT(*) AS n FROM accounts WHERE active = 1"
   ```

   Inspect any queued, sending, uncertain, or accepted outbox row before enabling a provider key. Do not assume old fixtures are harmless.
2. After action-time confirmation for security-sensitive access, create one named **Full access** Resend development key. Put its value directly into the development Worker's `RESEND_API_KEY` secret without printing it, writing it to the repository, or placing it in command arguments.
3. Register `https://tagmails-relay-dev.saimun-shahee.workers.dev/webhooks/resend` in the same Resend account for exactly `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, and `email.suppressed`. Put its signing secret into the development Worker's `RESEND_WEBHOOK_SECRET` secret. Creation and secret propagation should be one supervised session; do not run live mail while only one side is configured. [Resend receiving webhooks](https://resend.com/docs/dashboard/receiving/create-receiving-webhook) · [signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
4. Pair a transient device to a disposable read-only workspace after approval for that local access. Keep the Rust daemon stopped until a fresh signed Gmail delivery has been checked.
5. Send a new task from the owner's Gmail with `Model: Luna` on its first line. Verify that the signed event created exactly one queued D1 job, matched the provider record and bounded raw MIME, and exposed actual Gmail `authentication` and raw-download URL fields. An invalid signature must not queue a job. Start the Rust daemon for one claim, then let the scheduled outbox send through `RESEND_TEST_FROM=onboarding@resend.dev`, which limits the development reply to the owner's Gmail.
6. In Gmail, inspect the delivered result's sender, `Reply-To`, thread placement, HTML/plain-text presentation, and private transcript link. Compare the transcript with the actual job result and the Resend sent and delivery states. Reply in the same thread for a second Luna turn and verify session continuity and `References` order.
7. Revoke the disposable device and stop the local daemon. Do not broaden to another recipient while the test sender is active. Its custom Reply-To also prevents testing Gmail's native emoji reactions. To test multiplayer delivery and reactions, first verify a sending domain and remove the owner-only test-sender restriction, then repeat with an owner-granted second owned Gmail address and an unauthorized sender control. React to the delivered agent message in Gmail and verify the signed reaction event is stored on that message without queuing a job or charging for a task. [Gmail reaction limits](https://support.google.com/mail/answer/14080429?co=GENIE.Platform%3DDesktop&hl=en)

## Stop conditions

Stop the pilot and preserve the job/provider IDs for diagnosis if a reply names the wrong recipient, a duplicate send appears, a run claims an unverified file change, a participant gains access without an owner grant, a signed event cannot be matched to its provider record, or the receipt calls provider acceptance inbox delivery. Do not retry an uncertain send until Resend's sent record and API logs settle whether it was accepted.

The browser's security-sensitive-access rule requires confirmation at the key and webhook creation step even when the broader project was authorized. No live credential or webhook was created while preparing this runbook.
