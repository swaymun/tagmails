# Email privacy

What the Tagmails relay can and can't see, and how long it keeps things. This covers computers on Tagmails 0.2.24 or later; older ones get no work.

## Stored mail is sealed to your computer

At `tagmails pair` (or the first `tagmails start` of an older pairing) your computer creates an X25519 key in its config folder (`device-key`, mode 0600) and sends the relay only the public half. The relay seals what it stores about your mail to that key (`agent/device-seal.mjs`: ephemeral X25519, HKDF-SHA256, AES-256-GCM, with a purpose label bound into each blob). Only your computer can open it.

The operator, or anyone holding the Cloudflare account, the Worker's `STORAGE_KEY` and the D1/R2 data, can't read:

- The email: subject, body and attachments. The raw MIME is not stored; a parsed copy and one object per attachment are sealed instead.
- Thread subjects. These are kept with the thread and don't expire.
- The agent's result: answer, summary, details, checks, transcript and usage.
- Files the agent attaches. They travel with the completion request and are not stored, except inside a sealed reply that is waiting its turn (next item).
- A reply that has to wait for an earlier one in its thread. It is held sealed to the computer, which opens it and hands it back when its turn comes, only for the job it names and only within 7 days.
- Earlier requests the relay answered itself, and follow-ups sent during a run, as they are passed to the computer.

Each sealed request names its job, thread and Message-ID, the SHA-256 of each attachment, and when it was sealed. The computer opens a claim only if the request is that job's own, refuses requests sealed more than 30 days ago, and remembers every job and follow-up it ran for 31 days, so someone with write access to storage can't replay old sealed mail into a new job, or re-queue an old one, to read it back. Requests sealed before seal times existed open only until November 15, 2026. A request the computer only answered ("which project?") rides along with the sender's reply; one an agent already ran never does.

When no paired computer has a key (none paired yet, or all revoked), an email is read in memory, answered with "no computer is connected, send it again", and not stored.

## Read in memory, never stored

- Each incoming email, to check its DKIM signature, the sender and the recipients, and to seal it.
- The agent's result and files during the completion request, to render and send the reply. The reply then passes through the mail provider (Cloudflare Email Sending on the hosted service).

Choosing the model, the project folder and whether a mid-run follow-up joins the run happens on your computer (`agent/local-router.mjs`), with your own Claude or Codex subscription. The relay settles only what the email says outright: a `Model:` line, the thread's existing model and folder, or a written "work in /path".

## What the operator can read

- Sender, recipient, participant and agent addresses.
- Message-IDs and References, kept for reply threading.
- Timestamps, job states, attempts, delivery status and billing records.
- The selected model and effort, and the chosen project folder (name and path).
- The run's outcome, runtime and Codex/Claude session id, for status pages and "Open in Codex/Claude" links.
- Your computer's model list and project list. The project list holds only each folder's name and path, enough to settle a written "work in /path" and to name projects when asking which one. From Tagmails 0.2.30, README excerpts, top-level entries and session history stay on your computer, where the folder is chosen; an older computer still sends them, and the relay drops them without storing them. It is encrypted with the relay's own `STORAGE_KEY`, which the operator holds. `--workspace PATH` publishes no list at all.
- Replies the relay writes itself ("which project?", model questions, "this thread's computer was revoked"), also under `STORAGE_KEY`.
- Outbound reply metadata: from, to, cc, and a salted SHA-256 of the subject.

The website and run pages show status and metadata only. The content stays on your computer, in the Codex or Claude session.

## Retention

Scheduled cleanup (`services/inbound-retention.mjs`):

- **Inbound mail** (sealed message and attachments): deleted 7 days after its job finished. Kept while the job is queued or running, or its reply is still being built.
- **Run results** (sealed answer, summary, transcript): deleted 30 days after the job finished.
- **Outbound reply bodies**: removed once the send settles. Replies with an uncertain outcome keep theirs for recovery.

Metadata (addresses, Message-IDs, timestamps, models, project folders, billing) is kept for threading and billing.

## Limits

- The relay processes plaintext in memory. Whoever controls the Worker's code could change it to log or keep mail that arrives afterwards. Sealing protects what is stored, not mail in flight; only sender-side encryption or a mailbox you own would change that. A self-hosted relay puts that control with you.
- The private key sits next to the device token. Codex runs are denied both files by Codex's sandbox. Claude runs get Claude Code deny rules for both, which block its file tools and the shell commands it recognises as reads, but not a program that opens the file itself; on owner `auto` turns Claude Code's own safety classifier is the remaining guard. Participant runs have no shell.
- With several computers on one account, mail is sealed to the computer its thread is routed to, and only that computer runs it. Re-pairing creates a new key; queued mail sealed to a key no paired computer holds fails after 15 minutes.
- A self-hosted relay without `STORAGE_KEY` keeps its own replies and the project list in plaintext.
