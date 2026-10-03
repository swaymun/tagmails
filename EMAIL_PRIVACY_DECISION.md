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
