# TagMails

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: use the simplest suitable stack. The internal test site uses Node.js built-ins and plain HTML, CSS, and JavaScript. The planned production relay is a TypeScript Cloudflare Worker and the planned macOS daemon is Rust. These choices remain subject to implementation evidence.

## Users

People who already use a local coding agent and want to send work to it from an email client, then continue by replying.

## Product Purpose

Give a local agent an email address. Queue work while the computer is offline, resume the agent when available, and return a useful result in the same thread with artifact and private trace links.

## Positioning

The owner-only development pilot runs Codex on the owner's Mac. The hosted service supplies address routing, durable delivery, and storage. Customer use of a personal model subscription is gated on the provider's supported commercial path or confirmation; Claude Code is a local lab adapter, not a customer beta route. Metered API-funded execution remains outside the first beta by user decision.

## Operating Context

The first beta uses Google sign-in with a verified Gmail address. Customers install a macOS background daemon with a copyable setup prompt. They send tasks, receive results, and reply in the same email thread. The website handles setup, balances, device status, and run inspection. An internal Gmail-like site is used to test the email interaction before real delivery.

## Capabilities and Constraints

- Both the daemon and server are intended to be open source and self-hostable.
- Codex is the current owner-only live runtime. Claude Code has a local adapter but is held from customer deployment pending an API-backed or provider-approved path. OpenAI's plan-usage documentation directs paid or remotely hosted apps to its interest form; a paid TagMails beta must clear that gate too. [OpenAI plan-usage overview](https://developers.openai.com/siwc/token-sharing-open-source) · [Anthropic account guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
- Explicit model choices take precedence over defaults. Jev classifies an initial email without a `Model:` directive; replies keep that thread's model unless the sender explicitly changes it.
- The owner-only pilot is the current scope. Thread-scoped participation remains implemented in local fixtures but is deferred for live beta testing, including its provider-plan implications. Production must verify inbound mail provenance before trusting the sender address. Bcc identities stay private in visible reply headers. Sensitive actions retain local approval gates.
- Gmail users can react to an agent reply with a native emoji where Gmail offers the control. Inbound reaction mail is feedback on that message and does not start a task. Bcc recipients cannot react to the original Bcc message in Gmail.
- Completion emails include a concise outcome, real checks and limitations, links and small previews where supported, and an accessible full trace.
- The internal test site uses synthetic messages and must identify simulated work clearly.
- TagMails is the chosen public brand; Wonder Email remains the internal project name. MIT is the selected source license. The user bought `tagmails.com`; final pricing and retention policy are open decisions.

## Brand Commitments

The private pilot uses the TagMails name, a text-forward landing site, and a copyable setup prompt, inspired by the interaction pattern at Call4Me without copying its design. The user bought `tagmails.com` on October 3, 2026. A narrow USPTO wordmark search found no exact match, but Etag Digital actively markets a `TagMail` email product. Keep broader name clearance open before public launch. Details and sources are in PLAN.md.

Claude Tag is a reference for the use cases and collaborative feel: delegate from an existing conversation, get a concrete result in-thread, continue later, and keep memory and access scoped. The internal test site should look and behave like Gmail based on the user's supplied screenshot; it remains an internal testing surface rather than public product branding.

## Evidence on Hand

The original product plan (domain shortlist, pricing research, Wonder and T3 Code references) is in git history before October 5, 2026. There are no verified customer testimonials, live task outcomes, or published product metrics yet.

## Product Principles

- Keep everyday work in the email thread.
- Show what the agent actually did and link to the full run.
- Resume the same local session on replies.
- Keep sender permission and local action approval explicit.
- Make hosted costs and retained data understandable before charging.
