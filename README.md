# TagMails

TagMails gives an existing local coding agent an email address. This repository currently contains the product plan and an **internal, synthetic Gmail-style test inbox**. By default it sends no email, invokes no model, changes no files on behalf of a message, and charges no money. Explicit one-job Codex and Claude read-only modes are available for local testing.

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

### Opt-in local Claude read-only run

Use a signed-in Claude Code CLI and a scratch workspace. Queue an email with `Model: Claude`, copy its `job-...` ID, and run:

```sh
TAGMAILS_RUNTIME=claude-readonly \
TAGMAILS_WORKSPACE=/absolute/path/to/scratch-workspace \
TAGMAILS_JOB_ID=job-123 \
cargo run -p tagmails-daemon -- --once
```

This route pins Claude Sonnet 5.5 Medium, limits the CLI to Read/Glob/Grep in restricted mode, disables local customizations, and asks the CLI to stop at a $0.25 list-equivalent budget per turn. That CLI budget is a gate between model requests, not a guaranteed billing ceiling. The adapter omits inherited API keys, saves a Claude session ID per email thread in ignored `.local/claude-sessions.json`, renews its claim, and caches completed results for retry. A two-turn live scratch-thread test read a note, then recalled its codename and status from the resumed conversation without rereading the file. No real email was sent. Attachments, write approvals, production workspace isolation, and measured subscription/API billing remain to be built.

### Local relay proof

The Cloudflare Worker now accepts authenticated one-job claims from a paired device record, returns a signed task payload, renews leases, and stores one terminal result in R2. Completion atomically queues one outbound reply. A scheduled Worker can send that reply through Resend, retrieve its provider Message-ID, and save it for later threaded replies and Gmail reactions. A send with an uncertain provider outcome is held for reconciliation instead of automatically retried. These paths have local provider mocks only; no real email has been sent. The Rust daemon has an opt-in relay mode selected by `TAGMAILS_RELAY_URL`, with an absolute device token file and workspace. It verifies the payload signature before running the Codex or Claude adapter, and accepts HTTPS endpoints or an explicit localhost HTTP port. Use `--once` for one claim or `--watch` to poll every 30 seconds while idle and immediately after completed work. The adapters renew the 90-second claim while a turn runs.

```sh
TAGMAILS_RELAY_URL=https://your-relay.example \
TAGMAILS_DEVICE_TOKEN_FILE="$HOME/.config/tagmails/device-token" \
TAGMAILS_WORKSPACE=/absolute/path/to/selected-workspace \
cargo run -p tagmails-daemon -- --watch
```

The continuous loop was exercised against a local no-job relay. A macOS LaunchAgent installer is available, but it has only been checked in preview mode; no device has been left running at login. Workspace selection in account setup and a live queued agent turn through this mode are still pending.

For a paired device on macOS, build the daemon and preview the login agent before installing it. The installer checks the relay URL, existing absolute workspace, executable, and owner-only token file. It saves a user LaunchAgent with the selected workspace, current CLI `PATH`, and separate logs. The agent runs the read-only Codex or Claude adapters and watches for queued relay jobs. This prototype depends on the checkout and CLI paths remaining available after login.

```sh
cargo build --release -p tagmails-daemon
node scripts/install-macos-launchagent.mjs \
  --relay https://your-relay.example \
  --workspace /absolute/path/to/selected-workspace \
  --token-file "$HOME/.config/tagmails/device-token" \
  --print > /tmp/tagmails-launchagent-preview.plist
plutil -lint /tmp/tagmails-launchagent-preview.plist
```

Run the same `node scripts/install-macos-launchagent.mjs` command without `--print` or the output redirection to register and start it. The installer refuses to replace an existing TagMails LaunchAgent. To stop it, run `launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.tagmails.daemon.plist"`; remove that plist only if you want to disable launch at login. Revoking the paired device in the account page also prevents new relay claims.

An isolated local Wrangler run exercised D1 and R2 through the Worker, then Rust claimed a second job and submitted a result through a fake Codex executable. The first fake script failed because Node treated it as an ES module; the Worker recorded that failed result, and Rust's status output was corrected. After fixing the fixture and retrying locally, D1 showed a completed job on attempt two and R2 contained the fake Codex result. This verifies the relay protocol and retry path, not a real model or email delivery.

### Account and device pairing prototype

The Worker serves `/account` and verifies a Google Identity Services ID token against Google's signing keys, the configured client ID, issuer, expiry, and a verified personal `@gmail.com` address. Google's stable `sub` identifies the account. It stores only a hash of the browser session token. A signed-in owner can create a ten-minute, one-use pairing code; the Rust daemon exchanges it for a device record and writes its own token to an absolute path with mode `0600`. The owner can list and revoke devices. This requests Google identity only, not Gmail mailbox access. [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

For local setup, configure `GOOGLE_CLIENT_ID` with an OAuth web client allowed to run on the relay origin and set `AGENT_DOMAIN` to the intended mail domain. Set `PUBLIC_ORIGIN` to the relay's HTTPS origin so owner-addressed result emails can link to an authenticated run receipt. Apply D1 migrations, then open the Worker's `/account` page. After signing in, create a pairing code and run the displayed command from this checkout. Enter an absolute workspace path to copy a second command that builds and installs the macOS login agent after pairing. The account page labels its generated address as reserved until real delivery is configured. Signed Resend events now select exactly one active account address, and replies send from that account's address; events addressed to multiple account aliases are ignored. This routing is source-tested, with no live provider delivery yet. A local Wrangler/Rust smoke test paired a token, confirmed an authenticated claim, and revoked the disposable test device. No real Google sign-in was performed.

The run receipt at `/runs/<job-id>` requires the owner's browser session and shows the recorded outcome, checks, attempts, and email delivery state. Its link appears only on replies addressed to the owner. It is a structured receipt, not a step-by-step agent trace; trace capture and artifact access remain to be built.

The account page also lists the owner's email threads and their authorized participants. The owner can explicitly grant an address reply access on an existing thread, including someone they placed in Bcc, and revoke it later. Granting access does not send an invitation; that person needs the existing email thread to reply to. Revocation stops future replies and invalidates queued or running jobs from that participant in the relay; a running local adapter notices the lost lease at its next renewal attempts. Automatic Bcc grants remain unavailable because the agent's delivered email cannot prove who else was Bcc'd. These controls are locally tested but have not been used with a real Google sign-in or delivered email.

### Test-mode credit wallet

Migration `0005_test_wallet.sql` adds a separate append-only credit ledger. With `BILLING_TEST_MODE=true`, a `sk_test_` Stripe secret, a matching `whsec_` test webhook secret, and `PUBLIC_ORIGIN` set to this relay's origin, the signed-in account page can create a fixed $10 **Stripe test-mode** Checkout. The balance changes only after a raw-body signature-verified paid Checkout webhook; duplicate events do not add credits again. A successful refund subtracts its amount once, and a later failed refund restores it after the Worker retrieves the current refund state from Stripe. A refund received before its paid Checkout is stored and reconciled when the credit arrives or by the scheduled Worker. The browser's return from Checkout never credits the wallet; the account page offers a balance refresh while the webhook is in flight. [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create) · [webhook signatures](https://docs.stripe.com/webhooks/signature) · [refund states](https://docs.stripe.com/api/refunds/object)

This wallet is non-spendable and accepts no live Stripe key or live event. It has only mocked provider tests: no Stripe account, Checkout session, webhook destination, task debit, dispute reconciliation, or real payment is connected. Keep it in test mode until those paths and the final price are approved and verified.

```sh
npm test
npm run eval:email
```

The tests cover durable offline mail, a six-message owner/participant/agent thread across a restart, per-turn model selection, duplicate IDs, To/Cc/Bcc access and Bcc privacy, revocation, Gmail reaction MIME, approval and failure states, HTML escaping, header injection, interrupted job recovery, claim renewal and selected-job claiming, signed device claims and stale-lease rejection, fake Codex and Claude CLI create/resume cycles, raw MIME, attachments, import limits, a signed Resend event with retrieved raw email, and a two-turn mocked provider send with reaction capture and uncertain-send handling. The [v1 email response specification](EMAIL_RESPONSE_SPEC.md) and `eval:email` command provide a fixed eight-case multipart MIME corpus; each run writes parsed HTML, plain text, raw mail, and a report under ignored `.local/email-eval/` for review. A separate `node scripts/evaluate-email-prompt.mjs --run` command makes six bounded live Luna turns on synthetic files and compares the active prompt with a candidate. Neither check simulates Gmail rendering or proves link destinations.

## Current scope

The lab uses deterministic mock runners by default. Opt-in Codex and Claude CLI adapters each completed a local multi-turn scratch-thread run through the Rust worker. An earlier Claude CLI probe hit its budget gate; the later restricted, short-system-prompt route completed both turns. A Resend intake module verifies webhook signatures, fetches provider-matched raw MIME, checks DMARC, and refuses to infer hidden Bcc guests. A Cloudflare Worker now has local D1/R2 inbound storage, account-address routing, an authenticated claim/result path, queued outbound sends, reaction storage, source-implemented Google sign-in, owner-managed thread access, one-use device pairing, and a non-spendable Stripe test wallet. Local SQLite tests, a Wrangler/Rust protocol smoke, and a Wrangler/Rust pairing smoke pass; Wrangler built the current Worker in a dry run. A disposable local Wrangler D1/R2 run also completed two real Codex Luna read-only turns through the Rust relay in one session, stored both results, and queued both replies. The replies were not sent. A dedicated Google Cloud project, `tagmails-development`, has been created, but its OAuth branding is waiting at Google's User Data Policy agreement and no OAuth client exists yet. Resend signup is also waiting at its terms step. Actual email delivery, live billing, artifact access, and production runtime approvals remain. TagMails is the selected public brand; `tagmails.com` has not been purchased or verified for use.
