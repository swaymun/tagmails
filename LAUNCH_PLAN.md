# TagMails launch plan

Status: internal working plan, 2026-10-02. No public launch date is set. The local Gmail-style lab, account prototype, and relay are useful demonstrations; a real Gmail-to-agent-to-Gmail exchange has not yet been verified.

## Positioning

**Give your agent an email address.** Send a task to TagMails from Gmail, pick Codex or Claude when it matters, and get the result back in the same conversation. The connected Mac runs the work. The owner can bring someone into the thread by adding them in To or Cc; a later reply continues the agent session. The first public examples should focus on a catch-up from a messy thread, a concrete analysis task, and a follow-up decision. Show the agent's actual output, check results, and limitations.

The initial audience is developers and small teams already using Codex or Claude Code on a Mac. The first offer is a private beta with Google sign-in for personal Gmail addresses and a single selected local workspace. Keep the email and storage price separate from any later API-funded model cost. The [internal pricing model](PRICING_MODEL.md) uses current public rate cards to define what to measure; do not publish the proposed $0.05/task or 10% API margin as final until live usage and refunds are measured.

## Release gates

| Gate | Proof required before it can appear as a live claim |
| --- | --- |
| Address and signup | Own and verify the chosen domain; complete Google OAuth configuration; create an account, reserve its address, pair and revoke a Mac from the real account page. |
| Email loop | From an owned Gmail account, send a task to the agent address and receive a correctly threaded, readable result in Gmail desktop and mobile. Repeat with a reply and a second agent turn. Preserve the raw MIME and screenshots. |
| Multiplayer | Owner adds a second owned address in To/Cc; that participant's reply succeeds. A nonparticipant and a participant attempting to add a third address are refused. Do not advertise Bcc grants until a production verification path exists. |
| Execution | Run one bounded Codex task and one bounded Claude task in the selected workspace; test offline queue recovery, interrupted work, approvals, and truthful failure mail. Record actual model, cost, and outcome. |
| Customer controls | Show run status, a private owner receipt, device revocation, and clear retention/deletion behavior. Test cross-account isolation, duplicate provider events, and one delivered plus one bounced recipient in the same reply. Confirm that the receipt distinguishes provider acceptance from inbox delivery. A receipt is a summary until full trace capture is implemented. |
| Pricing and payments | Decide the measured service price and refund behavior; reconcile an idempotent Stripe test-mode top-up and a duplicate webhook before any paid signup. Display a maximum for API-funded work if offered. |
| Open source and setup | MIT is selected; publish the exact deployable source, self-host instructions, security and limitation notes, and a tested copyable Codex/Claude setup prompt. The license file alone is not a public source release. [GitHub licensing guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) |

The launch site, screenshots, examples, and video must be assembled from the same verified release candidate. Mark synthetic inbox fixtures as examples. Avoid launch claims about PR creation, artifact downloads, full traces, paid execution, or Bcc invitations until each works in the public build.

## Private pilot

Recruit five to ten people who already use Gmail and a local coding agent. Start with owner accounts and workspaces under our control, then add external testers once setup and revocation work. Give each tester three specific tasks: catch up on a thread, ask for an analysis or draft in a selected workspace, and reply with a follow-up. Invite a second person on one thread with an owner-authored To/Cc grant.

For every attempted task, record: signup/pairing completion, delivery and reply latency, model and runtime, whether the result matched the run record, link validity, Gmail rendering, number of turns, retries/failures, provider cost, and support intervention. Ask the tester whether the answer was useful and what they expected to happen next. Keep raw mail and screenshots private and redact personal data before creating examples.

Go to public beta only when all release gates pass and the pilot has no unresolved wrong-recipient, unauthorized execution, duplicate charge, or misleading-result defect. A fixed threshold for speed or task success should be chosen from actual pilot data rather than invented now. Keep an issue list with owner, reproduction, and decision for every pilot failure.

## Launch assets

1. A text-forward landing page with one sentence, a real email thread, the actual supported Mac/Gmail scope, pricing, a copyable setup prompt, and a beta signup or working account link. The current local landing is a prototype.
2. A short setup guide for Google sign-in, paired Mac, selected workspace, model selection, To/Cc sharing, reactions, and revocation. Explain that reacting to an agent message is feedback; it does not start or bill a task.
3. Three redacted, reproducible example threads with exact prompts, actual result email, outcome, and run receipt. One should show a second authorized participant. Include a failed or waiting example so expectations are clear.
4. An open-source repository with license, self-host steps, architecture, contribution path, security reporting, and a changelog. A public repository without a license is not an open-source release. [GitHub licensing guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
5. The [motion video brief](LAUNCH_VIDEO_BRIEF.md) for Claude Code. Produce the final cut only from verified scenes. A labeled concept animatic is acceptable internally before the live flow exists.

## Launch sequence

### Preparation

Freeze the release candidate and run the release gates. Open the beta to a small cohort, fix observed defects, and update docs and copy from their language. Prepare support replies for pairing failures, mail rejection, delayed queue, cost questions, and account deletion. If using Product Hunt, prepare a real personal maker account early: its help center requires a personal account and completed onboarding, and its preparation guide says newly created accounts wait one week before posting. Product Hunt allows scheduling in advance and recommends a direct product URL. [Product Hunt help](https://help.producthunt.com/en/articles/479557-how-to-post-a-product) · [before-launch guide](https://www.producthunt.com/launch/before-launch) · [preparation guide](https://www.producthunt.com/launch/preparing-for-launch)

### Beta announcement

Publish the site and repository only after the gates pass. Invite pilot users to try a specific workflow and report what happened. Monitor delivery, failed jobs, account pairing, support load, and charges during the first day. Keep a rollback path for inbound delivery and pause new signups if recipient isolation or billing evidence is unclear.

### Community posts

Use Product Hunt when the product is available at a direct URL and the team can answer setup questions that day. A maker can submit their own product. Ask for feedback and use, not votes; Product Hunt's launch guidance says not to ask directly for upvotes. The video is optional there, so it should not delay a ready product. [Product Hunt launch guide](https://www.producthunt.com/launch) · [preparation guide](https://www.producthunt.com/launch/preparing-for-launch)

Use Show HN only when a reader can try something immediately; its guidelines say a signup page alone is insufficient. A public self-host demo or genuinely usable beta may qualify. The founder should write the post and answer comments personally: Hacker News asks people not to use generated text for posts or comments and not to solicit upvotes. Prepare factual notes and links for the founder, then let them write in their own voice. [Show HN guidelines](https://news.ycombinator.com/showhn.html) · [HN guidelines](https://news.ycombinator.com/newsguidelines.html)

Send the short launch video and a real example thread to the channels where the intended users already discuss Codex and Claude. The video is a supporting demonstration, not a substitute for a working setup. Use a distinct source tag on each link so signups and completed first tasks can be attributed without exposing email content.

### First two weeks

Review first-task completion, time to first reply, second-turn rate, multiplayer use, reaction feedback, cost per completed exchange, refund requests, and support interventions. Read a sample of consented run receipts against their actual emails. Publish fixes and known limitations. Decide whether to broaden Gmail beta, change the proposed price, or keep the cohort capped based on that evidence.

## Decisions still needed

- Resolve the active `TagMail` email-product naming risk before purchasing `tagmails.com` or broadly launching the TagMails brand; then confirm domain checkout and trademark clearance.
- Choose production Bcc invitation behavior: verified Gmail Sent access or an authenticated owner invite; the current production path supports verified visible To/Cc grants.
- Set retention and the final exchange price after measuring live delivery and model use.
- Decide when API-funded model execution follows the subscription-backed local path.

Owner actions should be requested when a concrete purchase, terms acceptance, paid service, public deployment, or payment activation is ready for review. The current plan and local prototype do not require those actions to continue development.
