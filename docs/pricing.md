# Pricing

Status: 2026-10-11. The hosted relay charges **$0.0025 (a quarter of a cent) per reply**, so $1 covers 400 emails. Customers keep a prepaid USD balance topped up $10 at a time through Stripe Checkout; new accounts start at $0. Models run on the customer's own Codex or Claude subscription on their own machine, so model usage is never billed by TagMails.

## What is charged

- Every reply TagMails sends for an accepted email is charged, including failed and approval-waiting runs and questions TagMails sends back (which project, an unavailable model, a revoked computer). A question back is sent free when the balance can't cover it, so it never waits for a top-up.
- Free: duplicate mail, Gmail status reactions, follow-ups that join a running turn (steers), and mail from senders TagMails ignores.
- A charge is released when the reply is blocked before sending or bounces for its only To recipient.
- Files up to 3.5 MB are attached free. TagMails hosts nothing larger; agents put big files in the owner's own storage when their standing instructions say where.

The ledger keeps top-ups in whole cents (`credit_ledger.amount_cents`) and email charges in thousandths of a cent (`test_email_charges.amount_millicents`, 250 per email). A relay can change the price with `EMAIL_PRICE_MILLICENTS`. Balances show in dollars, rounded down to the cent.

## Unit economics

Costed at paid rates, ignoring every free allowance. Sources and method: `.local/audit-2026-10-11/economics.md`.

| Per reply | Cost | Basis |
| --- | --- | --- |
| Outbound mail: 👀 reaction, reply, ✅ reaction | $0.00105 | 3 × $0.35 per 1,000 (Cloudflare Email Sending) |
| Jev routing (model and project, about 10k input tokens) | $0.00042 | $0.042 per million input tokens; estimated from eval runs, not yet measured in production |
| Workers, D1, R2 | under $0.0001 | estimated |
| Stripe ($0.59 per $10 top-up) | $0.00015 | 5.9% of revenue |
| **Total** | **about $0.0017** | |
| **Margin at $0.0025** | **about $0.0008 (≈32%)** | |

Where the margin shrinks or goes negative:

- A machine with about 40 project folders makes the project-routing prompt about 40k tokens ($0.0017 per email), which by itself costs about as much as the price.
- Each steer is free but costs a 👀 reaction and up to two Jev calls (about $0.0005).
- Fixed costs: the $5/month Workers Paid plan needs about 6,000 replies a month to cover at this margin.
- A Stripe dispute costs $15, and Stripe keeps its fee on a refunded top-up.

Before changing the price, measure real Jev token counts per email in production and the actual outbound sends per reply.
