# Email privacy gate for customer beta

The current Resend account is for the owner's development mail only. Do not invite
customers to send TagMails requests through it. The development Worker permits
Google sign-in only for `PILOT_OWNER_EMAIL` unless `PUBLIC_SIGNUP_ENABLED=true` is
deliberately configured. The production configuration has no public signup flag.

## Why the gate exists

Resend's team dashboard displays received email bodies and attachments. Resend
retains email and log data for 30 days on Free, Pro, and Scale plans. The
TagMails relay separately keeps raw inbound MIME in R2 for up to seven days
after a run settles, and a Cloudflare account administrator can access that
storage. These properties do not meet a promise that the TagMails operator
cannot browse customer messages. A shorter TagMails R2 retention period does
not shorten Resend's copy.

Sources: [Resend inbound visibility](https://resend.com/blog/inbound-emails),
[Resend data retention](https://resend.com/security/gdpr).

## Customer architecture to validate before opening signup

1. Replace Resend for customer inbound mail. Cloudflare Email Routing can send
   a `*@tagmails.com` catch-all to an Email Worker without creating a browseable
   Resend inbox. Confirm its actual dashboard and API visibility with test mail.
2. Replace Resend for customer outbound mail. Cloudflare Email Sending is one
   candidate, with **Email preview disabled** on the sending domain; its default
   is enabled and otherwise exposes sent HTML, text, attachments, and raw MIME
   for about seven days. Confirm delivery, reply threading, bounce handling,
   Gmail reactions, and provider access before migration.
3. Stop storing plaintext customer MIME and results in operator-readable R2.
   Encrypt them to a key held only by the paired device, or use a user-owned
   mailbox and keep message content on that device. Move Jev classification to
   the device if the relay must not see task text. Confirm offline queueing,
   pairing recovery, and transcript access under that design.
4. Recheck all vendor dashboards, logs, backups, and administrator access with
   real test messages. Publish a precise privacy statement before customer
   signup. A service that controls ordinary SMTP intake can still inspect
   future plaintext mail by changing its receiving code; a claim of absolute
   technical inability would require sender-side encryption or a user-owned
   mailbox path.

Cloudflare references: [Email Worker receive API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
[catch-all routing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[email preview setting](https://developers.cloudflare.com/email-service/observability/logs/).

## Migration constraints checked October 3, 2026

- Cloudflare Email Service requires Cloudflare DNS. `tagmails.com` still uses
  GoDaddy nameservers, and its apex MX still points to Resend. Adding an Email
  Worker alone cannot receive mail for this domain. Prepare and compare the
  complete DNS zone before a nameserver and MX cutover; preserve the Site
  ownership/certificate TXT records, current web records, DKIM, DMARC, and any
  unrelated records. The website traffic cutover is a separate decision.
- Cloudflare's catch-all Worker route is available only at the apex. Its inbound
  limit is **25 MiB for the entire MIME message**. The current relay permits a
  38 MB raw message with up to 25 MB of decoded attachments, so those limits
  must be lowered together before migration. Cloudflare outbound mail to
  arbitrary recipients is limited to **5 MiB total**; larger agent files need
  expiring download links. The 25 MiB outbound exception applies only to
  verified destination addresses and is not a customer promise.
- Sending to arbitrary recipients requires Workers Paid. The current included
  allowance is 3,000 sends per month, then $0.35 per 1,000. This is a provider
  cost assumption for pricing review, not a confirmed TagMails bill. Email
  Routing itself is available on Workers Free and Paid.
- Disabling outbound preview removes its body preview, but Cloudflare's email
  activity and analytics still expose metadata such as sender, recipient,
  subject, message ID, and authentication/delivery status. The relay's own R2
  plaintext and the off-device Jev request remain separate privacy gaps.
- The current Cloudflare account has no Email Routing zone for TagMails. The
  domain remains partially verified at Resend despite a publicly resolving
  `rsend` CNAME. A Resend verification restart briefly returned to Pending,
  then to Partially Verified with that record still pending. Do not assume
  either provider is ready from DNS lookup alone.

Before switching the live MX, verify the Email Worker with test mail on a
Cloudflare-managed domain, including envelope/header sender alignment,
To/Cc/Bcc and alias routing, duplicate delivery, sender authentication,
reactions, attachments at the actual provider limit, and a delayed or failed
Worker invocation. Then prove outbound threading, uncertain-send recovery,
delivery/bounce state, and Gmail rendering with preview disabled. Reinspect
both provider dashboards using the same test messages. Keep the owner-only
Resend development route until those checks pass.

Sources: [Cloudflare setup and DNS requirement](https://developers.cloudflare.com/email-service/get-started/route-emails/),
[routing rules and catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[email size limits](https://developers.cloudflare.com/email-service/platform/limits/),
[pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
[activity log and preview](https://developers.cloudflare.com/email-service/observability/logs/).
