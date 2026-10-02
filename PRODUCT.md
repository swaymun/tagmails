# TagMails

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: use the simplest suitable stack. The internal test site uses Node.js built-ins and plain HTML, CSS, and JavaScript. The planned production relay is a TypeScript Cloudflare Worker and the planned macOS daemon is Rust. These choices remain subject to implementation evidence.

## Users

People who already use Codex or Claude Code and want to send work to their existing agent from an email client, then continue by replying.

## Product Purpose

Give a local agent an email address. Queue work while the computer is offline, resume the agent when available, and return a useful result in the same thread with artifact and private trace links.

## Positioning

The customer's own local Codex or Claude Code session performs the task. The hosted service supplies address routing, durable delivery, storage, and optional metered API-funded execution.

## Operating Context

The first beta uses Google sign-in with a verified Gmail address. Customers install a macOS background daemon with a copyable setup prompt. They send tasks, receive results, and reply in the same email thread. The website handles setup, balances, device status, and run inspection. An internal Gmail-like site is used to test the email interaction before real delivery.

## Capabilities and Constraints

- Both the daemon and server are intended to be open source and self-hostable.
- Codex and Claude Code are the first agent runtimes. The local subscription-backed path comes before managed API credits.
- Explicit model choices take precedence over defaults. Laya means ConvAI Innovations' decision model; it is only a possible future classifier, not a required implementation component.
- The owner grants thread-scoped participation by including an address in To, Cc, or Bcc on an email to the agent. Participants can reply within that thread but cannot add others; the owner can revoke access. Production must verify inbound mail provenance before trusting the sender address. Bcc identities stay private in visible reply headers. Sensitive actions retain local approval gates.
- Gmail users can react to an agent reply with a native emoji where Gmail offers the control. Inbound reaction mail is feedback on that message and does not start a task. Bcc recipients cannot react to the original Bcc message in Gmail.
- Completion emails include a concise outcome, real checks and limitations, links and small previews where supported, and an accessible full trace.
- The internal test site uses synthetic messages and must identify simulated work clearly.
- TagMails is the chosen public brand; Wonder Email remains the internal project name. Domain acquisition, license, final pricing, and retention policy are open decisions.

## Brand Commitments

The landing site should use the TagMails name, be text-forward, and include a copyable setup prompt, inspired by the interaction pattern at Call4Me without copying its design. `tagmails.com` is the preferred domain, pending registrar and trademark checks; other ideas are tracked in PLAN.md.

Claude Tag is a reference for the use cases and collaborative feel: delegate from an existing conversation, get a concrete result in-thread, continue later, and keep memory and access scoped. The internal test site should look and behave like Gmail based on the user's supplied screenshot; it remains an internal testing surface rather than public product branding.

## Evidence on Hand

PLAN.md records the product plan, provider pricing research, domain shortlist, and references to Wonder and T3 Code. There are no verified customer testimonials, live task outcomes, or published product metrics yet.

## Product Principles

- Keep everyday work in the email thread.
- Show what the agent actually did and link to the full run.
- Resume the same local session on replies.
- Keep sender permission and local action approval explicit.
- Make hosted costs and retained data understandable before charging.
