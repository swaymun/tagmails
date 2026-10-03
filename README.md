# TagMails

TagMails gives an existing local coding agent an email address. This repository currently contains the product plan and an **internal, synthetic Gmail-style test inbox**. By default it sends no email, invokes no model, changes no files on behalf of a message, and charges no money. An explicit one-job Codex read-only mode is available for local testing.

## Run the internal inbox

Requires Node.js 20.19 or newer and Rust for the optional worker.

```sh
npm ci
npm run lab
```

Open `http://127.0.0.1:4177`. The lab binds only to localhost. Its synthetic messages and queue persist in `.local/mock-inbox.json`; the **Reset synthetic inbox** control restores the example set.

The TagMails landing page prototype is at `http://127.0.0.1:4177/landing/`. It describes the proposed product, links to the synthetic inbox, and includes a copyable setup prompt preview. Signup, installation, payments, and real delivery are not connected.

The initial inbox includes examples for a decision catch-up, synthetic metrics, call preparation, a failed task, an approval pause, a queued bug report, and a shared thread. Open **Internal test controls** to connect or disconnect the mock daemon, process queued mail, import a raw `.eml` file, load more examples, revoke a participant for a selected thread, or approve a paused task. Compose and reply work like email. Model routing accepts a `Model: Claude`, `Model: Codex`, or `Model: Luna` line in the message body.

When the owner includes another address in To, Cc, or Bcc, that address can reply to the agent in the same thread. Only the owner can add participants. Bcc recipients stay out of visible reply headers, and an agent reply to a Bcc participant does not automatically reveal them to the owner. This local lab simulates sender identity; production must verify inbound mail provenance before trusting the From address. Gmail emoji reactions to an agent reply are recorded on that message and never queued as new tasks. The buttons below agent replies simulate those reactions in the lab.

Use **Import sample email with image** to test raw MIME parsing and an image preview. A custom `.eml` must include `agent@wonder.test` in To, Cc, or Bcc and have a valid `Message-ID`. Imported sender identity is simulated; the lab does not verify that the file came from Gmail. The parser converts HTML-only mail to text, limits mail and attachment sizes, and keeps attachment bytes in the local state file. The Rust mock worker fetches each attachment and reports its byte count without interpreting the image. Resend's verified event can confirm delivery to the agent, including when the agent itself was Bcc. It cannot reveal other Gmail Bcc guests hidden from the agent's copy; production cannot grant those guests from this event alone.

Outgoing replies are built as multipart plain-text and HTML MIME with `Message-ID`, `In-Reply-To`, `References`, and visible `Cc` headers. The thread view renders the HTML decoded from those generated MIME bytes and offers a raw MIME view. Every result states that it is synthetic. The local trace pages show mock job events.

To process queued mail with the local Rust prototype, keep the inbox server running in one terminal and run this in another:

```sh
cargo run -p tagmails-daemon
```

The worker polls the localhost lab, claims one queued task at a time, and returns a structured synthetic result. Use `cargo run -p tagmails-daemon -- --once` to process at most one task. The built-in **Process next email** button is also available for UI testing without Rust.

### Opt-in local Codex read-only run

With the lab running, send a synthetic message in the inbox and copy its queued `job-...` ID from **Internal test controls**. Choose a local scratch workspace and run one job with a signed-in Codex CLI:

```sh
TAGMAILS_RUNTIME=codex-readonly \
TAGMAILS_WORKSPACE=/absolute/path/to/scratch-workspace \
TAGMAILS_JOB_ID=job-123 \
cargo run -p tagmails-daemon -- --once
```

The adapter accepts Luna and GPT-6.1 Sol routes, uses Codex's read-only sandbox, saves the Codex session ID per email thread in ignored `.local/codex-sessions.json`, and resumes it for later selected jobs on that thread. It saves completed job results before returning them to the lab, so a retry can reuse the result. It renews the lab claim during a long turn and stops the CLI after three minutes. The lab labels these replies as local Codex runs. The selected job ID and `--once` are required because this synthetic localhost inbox has no authenticated sender or production provider verification.

This mode cannot inspect attachments or change project files. It is a Codex CLI prototype; the planned app-server integration, runtime approval flow, and production workspace boundary are still outstanding. Do not point this prototype at a private workspace you would not want the locally signed-in Codex CLI to read.

```sh
npm test
```

The tests cover durable offline mail, a six-message owner/participant/agent thread across a restart, per-turn model selection, duplicate IDs, To/Cc/Bcc access and Bcc privacy, revocation, Gmail reaction MIME, approval and failure states, HTML escaping, header injection, interrupted job recovery, claim renewal and selected-job claiming, a fake Codex CLI create/resume cycle, raw MIME, attachments, import limits, and a signed Resend event with retrieved raw email.

## Current scope

The lab uses deterministic mock runners by default. The opt-in Codex CLI adapter completed an isolated new and resumed Luna turn, then a three-turn synthetic inbox thread through the Rust worker. A Resend intake module verifies webhook signatures, fetches provider-matched raw MIME, checks DMARC, and refuses to infer hidden Bcc guests; it is not connected to an account or public endpoint. Claude CLI resumed work stopped at its budget gate before replying; details are in [PLAN.md](PLAN.md). A production Codex app-server adapter, Claude adapter, production Rust daemon, hosted relay, Google sign-in, payment ledger, real delivery, and artifact storage remain. TagMails is the selected public brand; `tagmails.com` has not been purchased or verified for use.
