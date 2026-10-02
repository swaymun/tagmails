# TagMails

TagMails gives an existing local coding agent an email address. This repository currently contains the product plan and an **internal, synthetic Gmail-style test inbox**. It does not send email, invoke a model, change files on behalf of a message, or charge money.

## Run the internal inbox

Requires Node.js 20 or newer. No package install is needed.

```sh
npm run lab
```

Open `http://127.0.0.1:4177`. The lab binds only to localhost. Its synthetic messages and queue persist in `.local/mock-inbox.json`; the **Reset synthetic inbox** control restores the example set.

The TagMails landing page prototype is at `http://127.0.0.1:4177/landing/`. It describes the proposed product, links to the synthetic inbox, and includes a copyable setup prompt preview. Signup, installation, payments, and real delivery are not connected.

The initial inbox includes examples for a decision catch-up, synthetic metrics, call preparation, a failed task, an approval pause, a queued bug report, and a CC invitation. Open **Internal test controls** to connect or disconnect the mock daemon, process queued mail, load more examples, verify and approve a guest for a selected thread, or approve a paused task. Compose and reply work like email. Model routing accepts a `Model: Claude`, `Model: Codex`, or `Model: Luna` line in the message body.

Outgoing replies are built as multipart plain-text and HTML MIME with `Message-ID`, `In-Reply-To`, and `References` headers. The thread view renders the HTML decoded from those generated MIME bytes and offers a raw MIME view. Every result states that it is synthetic. The local trace pages show mock job events.

To process queued mail with the local Rust prototype, keep the inbox server running in one terminal and run this in another:

```sh
cargo run -p tagmails-daemon
```

The worker polls the localhost lab, claims one queued task at a time, and returns a structured synthetic result. Use `cargo run -p tagmails-daemon -- --once` to process at most one task. It does not invoke Codex or Claude. The built-in **Process next email** button is also available for UI testing without Rust.

```sh
npm test
```

The tests cover durable offline mail, reply continuation, explicit model selection, duplicate IDs, CC guest permissions, approval and failure states, HTML escaping, header injection, interrupted job recovery, and expired Rust claim rejection.

## Current scope

The lab uses deterministic mock runners. Real Codex and Claude adapters, a production Rust daemon, hosted relay, Google sign-in, payment ledger, real delivery, and artifact storage are next stages in [PLAN.md](PLAN.md). TagMails is the selected public brand; `tagmails.com` has not been purchased or verified for use.
