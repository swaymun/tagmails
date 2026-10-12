# Email privacy gate for customer beta

The current Resend account is for the owner's development mail only. Do not invite
customers to send TagMails requests through it. The development Worker permits
Google sign-in only for `PILOT_OWNER_EMAIL` unless `PUBLIC_SIGNUP_ENABLED=true` is
deliberately configured. The production configuration has no public signup flag.

## What the TagMails operator can and cannot see

This applies to mail for a computer on TagMails 0.2.24 or later. At `tagmails
pair` (or the first `tagmails start` of an older pairing) the computer creates an
X25519 key in its config folder (`device-key`, mode 0600) and registers only the
public half. The relay seals what it stores to that key
(`agent/device-seal.mjs`: ephemeral X25519, HKDF-SHA256, AES-256-GCM, with a
purpose label bound into each blob). Only the computer can open it.

**Sealed to your computer.** The operator, or anyone with the Cloudflare
account, `STORAGE_KEY` and the D1/R2 data, can't read these:

- The email: subject, body and attachments. The raw MIME is not stored; a
  parsed copy and one object per attachment are sealed instead.
- Thread subjects.
- The agent's result: answer, summary, details, checks, transcript and usage.
- Files the agent attaches. They travel with the completion request and are
  never stored.
- A reply that has to wait for an earlier one in its thread. It is held sealed
  to the computer, which opens it and hands it back when its turn comes. The
  computer opens only such replies (a separate label), only for the job they
  name, and only within 7 days of sealing. So the relay can't use it to read
  other stored mail.
- Earlier requests the relay answered itself, and follow-ups sent during a
  run, as they are passed to the computer.

Each sealed request names its job, thread and Message-ID, and the SHA-256 of
each attachment. The computer opens a claim only if the request is that
job's own, and never reopens a job or follow-up it already ran
(`done-jobs` in its data folder). Otherwise someone with write access to R2
could put old sealed mail into a new job and read it back in the run's
transcript.

**Read in memory, never stored.**

- Each incoming email, to check DKIM, the sender and the recipients, choose a
  model and project, and seal it.
- Nothing for routing: since 0.2.27 the model, project and follow-up choices are
  made on the paired computer (`agent/local-router.mjs`) by the owner's own Claude
  Haiku or Codex Luna, which see the email and the owner's project list under the
  owner's own subscription terms. The relay settles only an explicit `Model:` line,
  the thread's model and folder, and a written work-in path.
- The agent's result and files during the completion request, to render and
  send the reply. The relay's own replies are rendered the same way at intake.
- The reply itself then passes through the mail provider (Cloudflare Email
  Sending; see the provider notes below).

**Readable metadata.** The operator can read:

- Sender, recipient, participant and agent addresses.
- Message-IDs and References, kept for reply threading.
- Timestamps, job states, attempts, delivery status and billing records.
- The selected model and effort, and the chosen project folder (name and path).
- The run's outcome, runtime and Codex/Claude session id. These power the
  status pages and "Open in Codex/Claude" links.
- Each computer's model list and project list (folder names and paths).
  Routing needs these while the computer is offline.
- Replies the relay writes itself: the "which project?" and model questions,
  and "this thread's computer was revoked".
- Outbound reply metadata: from, to, cc, and a salted SHA-256 of the subject
  (to match provider events).

The website and run pages show status and metadata only for sealed runs. The
content stays on the computer, in the Codex or Claude session.

**Limits.**

- The relay processes plaintext. Whoever controls the Worker's code can change
  it to log or keep mail that arrives afterwards. Sealing protects what is
  stored, not mail in flight. Only sender-side encryption or a user-owned
  mailbox would change that.
- The private key sits next to the device token. Codex owner write turns are
  denied both files by Codex's OS sandbox. Claude runs get Claude Code deny
  rules for both files: they block the Read and Edit tools and the shell
  commands Claude Code recognises as file reads (`cat`, `head`, `grep`...), but
  not a program that opens the file itself (`python3 -c "open(...)"`, `node`).
  Owner `auto` turns run without Claude Code's OS sandbox, which would close
  that gap but breaks keychain-backed tools such as `gh`, so there the auto
  classifier is the remaining guard (in testing it refused even a plain `cat`
  of `device-key` as credential exploration). Participant runs have no Bash.
- Several computers on one account: mail is sealed to the computer its thread
  is routed to, and only that computer runs it. Re-pairing creates a new key.
  Queued mail sealed to a key that no paired computer still holds fails after
  15 minutes without a reply; the run page shows the failure.
- No relay-key fallback (`SEALED_STORAGE_REQUIRED`, on in production since
  2026-10-12). When no paired computer has a key (none paired yet, or all
  revoked), an email is read in memory, answered with "no computer is
  connected, send it again", and not stored; only its metadata is kept.
  Computers older than 0.2.24 get no work (`/api/device/claim` answers 426).
  Relay-key data stored before the cut-off was purged
  (`scripts/purge-relay-key-data.mjs`).

## Why the gate exists

Resend's team dashboard displays received email bodies and attachments. Resend
retains email and log data for 30 days on Free, Pro, and Scale plans. The
TagMails relay separately keeps content in R2 and D1, sealed to the
computer's key (above). The relay's own replies ("which project?" and the
like) stay sealed with the Worker's `STORAGE_KEY`, which the operator controls. Scheduled cleanup (`services/inbound-retention.mjs`) applies
one rule per kind of content:

- **Raw inbound mail** (MIME and attachments) is deleted 7 days after its job
  finished, whether or not a reply was sent: steers, relay answers, refused
  and failed jobs, and blocked or uncertain replies are all covered. It is
  kept while its job is queued or running, while a steer is waiting to reach
  the run, and while its reply is still being built. A sealed copy of the
  request kept for a "which project?" answer is cleared at the same time.
- **Run results** (answer, summary, transcript) are deleted 30 days after the
  job finished. The run page and thread list then show the run without an
  answer.
- **Run output files** expire 7 days after upload.
- **Outbound reply bodies** are removed once the send settles; replies with an
  uncertain send outcome keep theirs for recovery. Replies for sealed mail keep
  no body at all, except a reply held sealed while it waits its turn.

D1 has no job finish time, so a settled reply's last update stands in for it,
and the job's arrival time when there is no settled reply. Results stored by
an earlier run of a job whose lease was replaced are not tracked in D1 and are
not yet deleted. D1 keeps metadata indefinitely for threading and billing:
thread subjects (sealed), sender and recipient addresses, message IDs,
timestamps, models and project folders. For relay-key mail these properties
do not meet a promise that the TagMails operator cannot browse customer
messages; sealed mail is covered above. A shorter TagMails R2 retention period does
not shorten Resend's copy.

Sources: [Resend inbound visibility](https://resend.com/blog/inbound-emails),
[Resend data retention](https://resend.com/security/gdpr).

## Customer architecture to validate before opening signup

1. Replace Resend for customer inbound mail. Amazon SES is the lead candidate
   for an authenticated intake trial: its Lambda receive event supplies SES-issued
   DKIM, DMARC, spam, and virus verdicts plus the envelope recipients. Its S3
   action stores raw MIME, so the account administrator can still access mail
   until content is encrypted to a device-held key and the plaintext staging
   copy is removed. Confirm the dashboard, logs, and actual retention with test
   mail. Cloudflare Email Routing remains a candidate only if a live Email
   Worker trial proves that the handler receives a trustworthy authentication
   verdict. Its documented handler exposes sender, headers, and raw mail, but
   does not document a structured authentication result. Do not authorize a
   task from a claimed From address or an untrusted header alone.
2. Replace Resend for customer outbound mail. Cloudflare Email Sending is one
   candidate, with **Email preview disabled** on the sending domain; its default
   is enabled and otherwise exposes sent HTML, text, attachments, and raw MIME
   for about seven days. Confirm delivery, reply threading, bounce handling,
   Gmail reactions, and provider access before migration.
3. Done for computers on 0.2.24+: stored mail and results are sealed to a key
   held only by the paired computer (see the first section). Routing moved to the device in 0.2.27. Still open:
   relay-key storage for mail was retired on 2026-10-12.
4. Recheck all vendor dashboards, logs, backups, and administrator access with
   real test messages. Publish a precise privacy statement before customer
   signup. A service that controls ordinary SMTP intake can still inspect
   future plaintext mail by changing its receiving code; a claim of absolute
   technical inability would require sender-side encryption or a user-owned
   mailbox path.

Provider references: [SES Lambda receive event](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda.html),
[SES verdict fields](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html),
[SES S3 action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html),
[Email Worker receive API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
[catch-all routing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[email preview setting](https://developers.cloudflare.com/email-service/observability/logs/).

## Migration constraints checked October 3, 2026

- SES needs an AWS account, a receiving Region, a verified receiving domain,
  receipt rules, and an MX change. A Lambda action supplies authentication
  metadata but not the message body; an S3 action can provide the raw MIME for
  the bridge. The default S3 action limit is 40 MB. Design and test the
  authenticated SES-to-relay handoff, S3 access controls, plaintext deletion,
  and device-held encryption before accepting customer mail. SES verdicts need
  an explicit authorization policy; `DMARC GRAY` does not by itself establish
  alignment, and a sender address in MIME is never proof of account ownership.
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
  arbitrary recipients is limited to **5 MiB total**, so replies attach at
  most 3.5 MB of files and TagMails hosts nothing larger. The 25 MiB outbound exception applies only to
  verified destination addresses and is not a customer promise.
- Sending to arbitrary recipients requires Workers Paid. The current included
  allowance is 3,000 sends per month, then $0.35 per 1,000. This is a provider
  cost assumption for pricing review, not a confirmed TagMails bill. Email
  Routing itself is available on Workers Free and Paid.
- Disabling outbound preview removes its body preview, but Cloudflare's email
  activity and analytics still expose metadata such as sender, recipient,
  subject, message ID, and authentication/delivery status. The relay's own R2
  plaintext remains a separate privacy gap.
- The current Cloudflare account has no Email Routing zone for TagMails. The
  domain remains partially verified at Resend despite a publicly resolving
  `rsend` CNAME. A Resend verification restart briefly returned to Pending,
  then to Partially Verified with that record still pending. Do not assume
  either provider is ready from DNS lookup alone.

Before switching the live MX, verify the candidate on a separate owned test
address or domain. Test trusted authentication verdicts, spoofed From headers,
To/Cc/Bcc and alias routing, duplicate delivery, reactions, attachments at the
provider limit, and a delayed or failed invocation. Then prove outbound
threading, uncertain-send recovery, delivery/bounce state, and Gmail rendering.
Reinspect provider dashboards using the same test messages. Keep the owner-only
Resend development route until those checks pass.

Sources: [Cloudflare setup and DNS requirement](https://developers.cloudflare.com/email-service/get-started/route-emails/),
[routing rules and catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[email size limits](https://developers.cloudflare.com/email-service/platform/limits/),
[pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
[activity log and preview](https://developers.cloudflare.com/email-service/observability/logs/),
[SES receiving metadata](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html),
[SES S3 storage](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html).
