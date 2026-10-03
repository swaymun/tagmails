# TagMails — product and build plan

- Date: 2026-10-02
- Status: offline Gmail-style lab and a localhost Rust mock worker implemented; hosted and live integrations have not started
- Public brand: TagMails
- Internal project name: Wonder Email

## Product promise

Give an existing local agent an email address. A customer signs in with Google, connects Codex or Claude Code on their computer with one copyable setup prompt, and sends work to the address. The service queues the message while the computer is offline. The local daemon resumes the appropriate agent session, completes the task, and sends a concise result in the same email thread with artifacts and a private run link. A reply continues that session. The daemon, relay, account site, and viewer are open source. The managed deployment charges for email delivery and retained storage; optional API-funded execution uses credits.

The initial audience is people already using coding agents who want to assign a task from any email client. The first supported agent runtimes are Codex and Claude Code. The first platform for the daemon is macOS. The website handles account setup, balance, address and device status, memory controls, traces, and billing; routine work stays in email.

## Journey and boundaries

1. Sign in with Google. For the first beta, accept a verified `@gmail.com` address and make it the initial authorized sender; defer Google Workspace and other Google-account addresses until sender verification is designed for them. Save Google's stable `sub` as account identity. Google sign-in does not need Gmail mailbox access. [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
2. Reserve `name@tagmails.com` once that domain is acquired and verified, choose a workspace and local runtime, and copy the Codex or Claude Code setup prompt. The installer pairs a device, registers a macOS LaunchAgent, and tests a read-only status call.
3. Send a task from the authorized address. The relay verifies the email provider's signed webhook, records one durable job per incoming message, checks sender authorization, and gives the local daemon a signed job envelope. The daemon only pulls outbound over HTTPS.
4. A new email creates a project session. A reply resolved through `Message-ID`, `In-Reply-To`, and `References` continues the saved session. Subject lines are display text, not session identity. [Resend threading](https://resend.com/changelog/message-id-for-sent-emails)
5. The completion email contains a clear outcome, what changed or was delivered, checks and limitations, action links, small attachments when appropriate, a private trace link, and a simple invitation to reply. Failed or waiting runs say what needs attention. The full trace stays inspectable outside the email.
6. The owner grants thread-scoped participation by including another address in To or Cc on an email to the agent. The local lab also simulates Bcc grants when it knows the sender's complete recipient list. Gmail hides other Bcc guests from the copy delivered to the agent, so production needs either owner Gmail Sent access or an explicit owner invite to verify those grants; the owner is choosing that first-beta path. Only the owner can add participants and revoke access. A participant cannot expand workspace or action permissions. Bcc recipients remain hidden from visible reply headers; their replies are private unless they explicitly include the owner. Production must authenticate the owner and verify inbound sender provenance before treating a recipient field as a grant.

### Default safety rules

- The Google-verified sender is authorized for ordinary tasks within the configured workspaces. A new address is added through an authenticated account action or a verified invitation. SPF/DKIM/DMARC results are defense in depth; the visible `From` field alone is insufficient.
- Forwarded mail, quoted text, attachments, web pages, and repository files are task data. They do not change permissions or billing limits.
- Separate local approval remains required for sensitive side effects such as sending mail as the user, merging, deployment, purchases, or broad file access. The service's signed envelope does not override the runtime's approval boundary.
- Deduplicate provider webhooks and mail `Message-ID`s. Persist job state before acknowledging inbound mail. An interrupted job checks its prior side effects before retrying. A completion message is sent once.
- Keep local model credentials on the user's computer. Keep service API secrets in the managed server's secret store. Store traces and artifacts privately with scoped, expiring access.

## Architecture to implement first

```text
Google account ── signup ──▶ open-source web/relay service
                                   │
incoming email ── Resend webhook ──┼──▶ durable jobs + credit ledger (D1)
                                   │                 │
                                   │             encrypted payloads,
                                   │             traces and files (R2)
                                   ▼
                      signed job claim over HTTPS
                                   ▼
                    Rust daemon on the customer's Mac
                    ├── local SQLite identity, memory, sessions
                    ├── Codex app-server adapter
                    └── Claude Code/Agent SDK adapter
                                   │
                         result + artifact manifest
                                   ▼
                           threaded email reply
```

**Proposed managed stack:** one TypeScript Cloudflare Worker for auth, address reservation, Resend webhooks, job claims, account pages, trace access, and Stripe webhooks; D1 for transactional metadata and an append-only credit ledger; R2 for bounded email payloads, attachments, traces, and artifacts. No Durable Object is required for the first job queue. Cloudflare currently lists a $5/month minimum for Workers Paid, with 10 million requests and 30 million CPU milliseconds included; D1 Paid includes 25 billion rows read, 50 million rows written, and 5 GB storage. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

**Self-hosting contract:** the same open-source server can be deployed to a separate Cloudflare account with its own domain, Resend key, D1, and R2; billing can be disabled. Document this path and test it before claiming self-hosting support. Additional mail and storage providers are later adapters once the first provider is stable. Choose the repository license before publishing source; retain license and attribution for reused code.

**Daemon:** Rust owns pairing, device keys, queue polling, local persistence, launch-at-login, workspace boundaries, and recovery. Keep runtime-specific protocol handling in small adapters. Inspect Wonder's App Server item projection and reconciliation (`crates/wonderd/src/history.rs`, `crates/wonderd/src/lib.rs`), its `crates/wonder-app-server`, and `services/claude-runtime` before copying logic. Review T3 Code's transcript and projection paths for ideas and license terms; its repository is MIT licensed. [T3 Code](https://github.com/pingdotgg/t3code)

## Runtime and model paths

| Mode | First implementation | Customer billing |
| --- | --- | --- |
| Bring your Codex plan | Local Codex app-server with user-authorized ChatGPT plan token. Save and resume thread IDs. Verify actual model access with an inference turn; `model/list` is only a catalog. | Hosted credits pay for mail and storage. Model use draws from the customer's plan. |
| Bring your Claude plan | Local Claude Code/Agent SDK session with the user's own sign-in, preserving Claude's approval flow. Verify create/resume and current subscription behavior in a live bounded spike. | Hosted credits pay for mail and storage. Current Anthropic guidance says Agent SDK and `claude -p` still draw from subscription limits; this is version-sensitive. |
| Managed API credits | A separately metered, capped API execution path. Keep the same local workspace boundary when a task requires local files. Evaluate Codex App Server/API-provider and Claude Agent SDK/API-key paths with real usage records before exposing this mode. | Charge observed model, tool, and sandbox costs plus a disclosed service margin; reserve a task budget and refund unused reservation. |

OpenAI Docs supports Codex app-server with a ChatGPT-plan OAuth token and local `thread/resume`. Its preview path requires `store:false`, uses local history, and has tool limits that the adapter must honor. The [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) is an option for managed cloud work, but its hosted sandbox is a separate execution location from the customer's Mac. [Codex app-server guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) · [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Set `gpt-6.1-sol` with medium effort as the initial Codex default and `claude-sonnet-5-5` with **explicit** medium effort as the Claude default; Sonnet's documented API default is high. Let the sender override through a short, documented subject/body syntax, and echo the actual selected model in the result details. Offer a per-address default in account settings. Use GPT-6 Luna for low-cost live smoke tests when API testing is enabled. [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) · [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) · [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

Start routing with explicit model requests and deterministic rules. Run an evaluation set before adding an inferred classifier. Compare Jev's hosted price and Laya's local compute, accuracy, calibration, and privacy on **our own email fixtures**. Neither model may grant permissions, spend credits, or choose unsafe side effects. Laya is the ConvAI Innovations decision model, not LLaMA. [Jev announcement and rate](https://typesafe.ai/blog/introducing-system-one-models-and-jev) · [Laya source and benchmark caveats](https://github.com/NandhaKishorM/laya)

## Email output and research loop

Create a versioned response specification and fixture corpus before tuning prompts. The renderer takes a structured run result, so the agent does not improvise raw HTML or unverified links. Each email has a plain-text part and a conservative HTML part. Use semantic headings, paragraphs, lists, clear links, descriptive image alt text, and small inline previews when tested. Keep large files and videos behind private web links with an image poster and a plain text fallback. Gmail's 25 MB attachment limit applies to personal accounts, and Gmail's automatic Drive conversion is for a user attaching files in Gmail; the relay must host oversized files itself. [Gmail attachment guidance](https://support.google.com/mail/answer/6584)

The internal test site will mimic a Gmail conversation list and thread view while rendering **the actual generated MIME** and status events from a local fixture relay. It will support sample inbound messages, multi-person replies, To/Cc/Bcc participation, model overrides, offline queueing, approvals, attachment previews, Gmail reactions, and failure states. It is an inspection tool, not a public Gmail clone.

For a Gmail-first experience, send directly from the agent address in a normal threaded email with the intended participants in To/Cc, at most 20 recipients, and no custom Reply-To. Gmail can show its native emoji reaction control on that message when the recipient opens it in a supported Gmail client; a Gmail address alone does not prove which client they use. A reaction arrives as a MIME email with a `text/vnd.google.email-reaction+json` part and an `In-Reply-To` pointing to the reacted message; record it as feedback without starting an agent run or charging for a task. Gmail does not offer reactions to Bcc recipients on that message. [Gmail reaction format](https://developers.google.com/workspace/gmail/reactions/format) · [Gmail reaction limits](https://support.google.com/mail/answer/14080429?co=GENIE.Platform%3DDesktop&hl=en)

Use [Claude Tag's published examples](https://www.anthropic.com/news/introducing-claude-tag) as a product-behavior reference: people hand an agent a messy existing conversation, ask for a catch-up or a concrete artifact, and come back to the same thread after it works asynchronously. The first synthetic email fixtures should feel like a decision catch-up, an incident or bug report leading toward a draft PR, a metrics question, and a follow-up that needs a person's decision. Keep memory and access scoped to the email thread and configured workspace. Future scheduled or proactive work can follow after direct email tasks are reliable; the examples must never imply a mock run actually changed code or queried live data.

Run an iterative evaluation loop on a fixed fixture set: code change with PR, report with citations, image output, video output, attachment input, ambiguous model request, multi-person thread, offline/retry, approval request, and failed run. Score factual fidelity to the run, action and link validity, scanability, reply continuity, accessibility, and client rendering. Compare prompt versions in the mock inbox, then send a small set of real Gmail↔agent-address messages with Luna and inspect Gmail desktop and mobile behavior. Save the exact MIME, screenshots, costs, and failures. Promote a prompt only when it improves the fixtures without regressions.

## Cost and pricing research snapshot

Figures checked October 2, 2026; validate again before launch.

| Component | Published rate | Implication |
| --- | --- | --- |
| Resend transactional mail | Free: 3,000 emails/month and 100/day. Pro: $20/month for 50,000; overage $0.90/1,000. Each inbound email counts toward the same quota. | One customer message plus one reply consumes two email units. Marginal overage is about $0.0018 per exchange, before base fee, support, and retries. [Resend pricing](https://resend.com/pricing) |
| Cloudflare R2 Standard | $0.015/GB-month, $4.50/million Class A and $0.36/million Class B operations; 10 GB-month and large operation allowances are free. | A 10 MB file retained one month is about $0.00015 of storage before request costs. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Stripe US domestic card | 2.9% + $0.30 per successful transaction. | A $10 top-up incurs about $0.59 processing, so minimum top-ups avoid card fees dominating small balances. [Stripe pricing](https://stripe.com/pricing) |
| GPT-6.1 Sol API, standard short context | $2/1M input and $10/1M output tokens; cached input $0.10/1M. | A hypothetical 20k input + 5k output **single model call** is $0.09; a full agent task may make many calls and use paid tools. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |
| Claude Sonnet 5.5 API | $2/1M input and $10/1M output tokens; cache rates vary. | The same hypothetical token counts are $0.09 before tools and repeated calls. [Claude model pricing](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) |
| Jev / Laya decision routing | Jev advertises $0.042/1M input tokens; Laya has open weights, so the cost is hardware and operations. | Routing is unlikely to dominate cost. Accuracy and failure handling matter more than the per-call price. [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) · [Laya](https://github.com/NandhaKishorM/laya) |

**Pricing hypothesis to validate:** a $10 minimum manual top-up, with no automatic reload by default. Charge a provisional **$0.05 for each accepted incoming task or follow-up email**, including its one result email, a bounded attachment allowance, and 30-day text trace retention. Reject or request approval for work exceeding the published file limit. For API-funded tasks, show a per-task maximum and charge observed provider model, tool, and sandbox costs **plus a proposed 10% margin**, in addition to the email charge; reserve a budget and refund unused funds. Show every line item and the exact charge before enabling billing. Bill larger retained storage by GB-month after an included allowance. This is a pilot hypothesis, not a published price: use measured agent usage, support burden, Stripe fees, and delivery failures to set the final exchange price, included storage, API margin, and refund policy before opening paid signup. A flat per-email charge must not silently absorb unbounded model work.

Custom customer domains need a separate cost line. Resend currently includes 3 domains on Free and 10 on Pro; its $20/month add-on adds 100 domains on eligible plans, while Scale includes 1,000. Offer the shared domain first and test a customer subdomain setup before pricing custom domains. [Resend domains and plans](https://resend.com/pricing)

## Domain shortlist

The `.com` registry's RDAP endpoint returned HTTP 404 for each candidate below on October 2, 2026. That means no current registration record was returned; registrar availability, premium status, trademark clearance, and social handles remain unchecked. Recheck immediately before purchase. Cloudflare's published ordinary `.com` registration/renewal rate is $10.46/year, but an individual domain's checkout may differ. [ICANN RDAP explanation](https://lookup.icann.org/) · [Cloudflare registrar prices](https://pricing.registrar.cloudflare.com/)

| Candidate | Assessment |
| --- | --- |
| **replywork.com** | Earlier brand candidate; short and task-oriented, but TagMails is now the chosen name. |
| **donebymail.com** | Clear promise and friendly tone; longer to type. |
| **runbymail.com** | Strong developer feel; less obvious to a nontechnical customer. |
| **taskbyemail.com** | Descriptive and searchable; reads more like a feature than a brand. |
| **tasksbyemail.com** | Explicit, but visually reads as “TasksByeMail.” Drop from the lead shortlist. No .com registration record was returned on October 2, 2026. |
| **task4email.com** | User-suggested candidate. Short and explicitly mentions email, but the `4` is ambiguous when spoken (`for`/`by`), and “task for email” sounds like a tool for managing email rather than an agent reached through email. No registration record or obvious exact-name web result was found on October 2, 2026; this is not a registrar or trademark clearance. |
| **mailtheagent.com** | Clear call to action and memorable, though longer and more descriptive than a distinctive brand. No .com registration record was returned on October 2, 2026. |
| **agentbyemail.com** | Unambiguous description of the product; more functional than brandable. No .com registration record was returned on October 2, 2026. |
| **tagmails.com** | **Chosen public brand and preferred domain.** It fits the idea of bringing an agent into an email thread. No .com registration record was returned on October 2, 2026; registrar checkout and trademark clearance still matter, especially because “TAG Mail” has other existing uses. |

Use **TagMails** in public-facing product work and keep Wonder Email as the internal project name. Do not purchase the domain based on RDAP alone.

## Build sequence and proof

| Phase | Work | Evidence to exit |
| --- | --- | --- |
| 0. Plan and reuse audit | Resolve the product defaults, inspect Wonder and T3 paths, choose license and initial hosting, draft threat and cost model. | Reviewed plan, source pointers, domain and pricing evidence. |
| 1. Offline prototype | Rust daemon, local store, two runtime adapters, email fixture parser/renderer, fake Gmail testing site, queue simulation. | New task, reply, interruption/restart, attachment, approval, and error fixtures behave correctly in the local UI. |
| 2. Open-source relay | Worker, D1/R2, Resend inbound/outbound, device pairing, signed claims, private trace and artifact pages; self-host config. | Provider webhook replay, duplicate message, offline recovery, auth rejection, and self-host deployment tests. |
| 3. Account and billing | Google sign-in, address reservation, installer prompts, Stripe test-mode wallet and ledger, metering, storage retention and limits. | Reconciled balance under duplicate Stripe events, failed tasks, refunds, and low balance; no real charge. |
| 4. Private live pilot | Domain, verified DNS, production provider keys, one owned Gmail sender and one agent address, Luna smoke tests, then Codex and Claude real work. | Delivered messages in Gmail, working thread continuity, local session resume, trace privacy, measured per-task cost and screenshots. |
| 5. Launch | Text-forward landing page, example email threads, docs and install prompts, public repository, launch copy and motion-video brief for Claude Code. | Site and signup tested end to end; source and license published; pilot defects closed; video remains a plan until separately produced. |

### Prototype evidence so far

- The localhost Gmail-style lab has seven synthetic starting threads, a compose and reply flow, explicit model routing, an offline queue, a threaded multipart HTML/plain-text reply, raw MIME inspection, trace pages, owner-granted To/Cc/Bcc participant access and revocation, Gmail reaction capture, and approval/failure fixtures. It can import a bounded raw `.eml` file and display persisted image attachments. Fifteen local tests include a six-message multi-person, multi-turn thread across restart, per-turn model changes, private Bcc delivery, and reaction mail that does not enqueue work.
- A Rust mock worker can claim queued jobs from that lab and return a synthetic result. Claims carry a lease ID so an expired worker cannot complete a newer claim. A composed `Model: Luna` fixture and an imported image email were processed and rendered in the browser in their original threads; the worker fetched the image bytes and reported their size.
- The text-forward TagMails landing prototype is available at `/landing/` on the local lab server. Its setup prompt is explicitly a preview, and its pricing is marked as a pilot proposal.
- An opt-in, one-job Codex CLI adapter now runs Luna or GPT-6.1 Sol in a selected absolute workspace with a read-only sandbox. It saves thread sessions and completed job results locally, renews claims, and labels real results separately from mock replies. A live scratch-folder Luna create/resume returned the expected codename both turns; an integrated Rust worker and synthetic inbox then produced a three-turn thread. The first integrated reply incorrectly said it could not read the note; after making read permission explicit, later replies read the note and reported its codename and status. A wrong selected job ID claimed nothing. This is a local prototype, not proof of provider delivery or production workspace isolation. Twenty-two local tests now cover the synthetic lab, fake CLI create/resume, lease renewal, and verified Resend intake.
- After updating local Claude Code from 2.1.38 to 2.1.288, a new isolated `claude-sonnet-5-5` session returned the expected first reply with $0.010528 of reported list-equivalent usage. A CLI `--resume` attempt stopped at the $0.05 budget gate without a reply; its result reported 46,967 cache-creation input tokens and $0.188396 of list-equivalent usage for that attempt. These are protocol probes, not agent email tasks or proof of billing. Investigate Claude resume context growth and budget enforcement before enabling that path for customers. Pin the exact Claude model instead of relying on an alias; the older installed CLI resolved `sonnet` to Sonnet 4.5 in the first probe.
- A Resend intake module now verifies the raw signed webhook, matches the fetched provider record and raw MIME, requires DMARC pass, bounds the download, and suppresses grants based on Bcc addresses in the agent's copy. Synthetic tests cover forged signatures, mismatches, and an agent that was itself Bcc. It still needs a hosted endpoint, account key, durable deduplication, and real provider tests. Resend's event contains metadata, while body and headers require a follow-up API fetch. [Resend receiving webhook](https://resend.com/docs/dashboard/receiving/create-receiving-webhook) · [retrieve received email](https://resend.com/docs/api-reference/emails/retrieve-received-email) · [verify webhook](https://resend.com/docs/webhooks/verify-webhooks-requests)
- The remaining phase 1 work includes a hosted verified provider endpoint, production selected-workspace pairing, a Codex app-server adapter with approvals, and a bounded Claude runtime adapter. `postal-mime` handles local RFC 822 parsing, with `html-to-text` for HTML-only input. [postal-mime](https://github.com/postalsys/postal-mime) · [html-to-text](https://github.com/html-to-text/node-html-to-text)

The landing page should follow the useful interaction pattern from [Call4Me](https://call4.me/): show the product in one sentence, a real example, simple credits, and a copyable setup prompt. [Nick Khami's architecture article](https://x.com/skeptrune/status/2106086714175570205) also suggests a useful discipline for this product: collect missing task details before execution and verify that promised actions happened. The page will use its own copy and visual identity.

## Provisioning and action gates

Create separate development and production credentials for Google OAuth, Resend, Cloudflare, Stripe, and any managed model API. Inventory existing accounts first. Store secrets outside Git and configure least-privilege keys, rotation, and test-mode defaults. Free account setup can proceed within the requested project scope. Domain purchase, paid Cloudflare/Resend upgrades, live Stripe activation, payment, and public deployment follow a concrete cost and configuration review. A login, key, or successful upload alone is not proof of live delivery.

The immediate next step after this plan is the offline fixture prototype. It can exercise the end-to-end shape before a domain, production account, or paid model call exists.

## Open decisions for plan review

1. Check **TagMails** for trademark conflicts and confirm `tagmails.com` at a registrar before purchase. The brand choice is settled; domain acquisition is not.
2. Set the beta's default workspace permission and approval profile. Start with a selected folder and explicit approval for external side effects.
3. Choose how long the hosted service retains messages, artifacts, and traces. The first proposal is 30 days for task payloads and artifacts, with a shorter default for raw inbound mail once the job is settled.
4. Decide whether API-funded tasks launch with the first beta or after subscription-backed local execution is proven. The recommended sequence is after the local path is reliable and metering has real task samples.
5. Decide public licensing before publishing. The entire stack stays source available and self-hostable under the chosen open-source license.
