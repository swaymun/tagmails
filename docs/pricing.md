# Pricing

Status: 2026-10-12. The hosted relay charges **$0.0025 (a quarter of a cent) per reply**, so $1 covers 400 emails. Customers keep a prepaid USD balance topped up $10 at a time through Stripe Checkout; new accounts start at $0. Models run on the customer's own Codex or Claude subscription on their own machine, so model usage is never billed by Tagmails.

## What is charged

- Every reply Tagmails sends for an accepted email is charged, including failed and approval-waiting runs and questions Tagmails sends back (which project, an unavailable model, a revoked computer). A question back is sent free when the balance can't cover it, so it never waits for a top-up; an account without balance gets at most five such free replies a day (`FREE_RELAY_REPLIES_PER_DAY`), after which the answer is only on the run page.
- Free: duplicate mail, Gmail status reactions, follow-ups that join a running turn (steers), a bare thank-you sent mid-run (the Mac drops it), and mail from senders Tagmails ignores.
- A run whose computer stops responding three times is failed by the relay with a reply (`MAX_ATTEMPTS`); that reply is charged like any other.
- A charge is released when the reply is blocked before sending or bounces for its only To recipient.
- A Stripe dispute takes its amount back from the balance when Stripe withdraws the funds and returns it if the dispute is won (the webhook must be subscribed to `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`).
- Files up to 3.5 MB are attached free. Tagmails hosts nothing larger; agents put big files in the owner's own storage when their standing instructions say where.

The ledger keeps top-ups in whole cents (`credit_ledger.amount_cents`) and email charges in thousandths of a cent (`test_email_charges.amount_millicents`, 250 per email). A relay can change the price with `EMAIL_PRICE_MILLICENTS`. Balances show in dollars, rounded down to the cent.

## Unit economics

Costed at paid rates, ignoring every free allowance. Sources and method: `.local/audit-2026-10-11/economics.md`.

| Per reply | Cost | Basis |
| --- | --- | --- |
| Outbound mail: reply, plus 👀 and ✅ reactions when the owner turned them on | $0.00035–$0.00105 | 1–3 × $0.35 per 1,000 (Cloudflare Email Sending); reactions are off by default |
| Routing | $0 | runs on the owner's Mac with their own Claude or Codex subscription (since 0.2.27); it was Jev at about $0.0004 per email before |
| Workers, D1, R2 | under $0.0001 | estimated |
| Stripe ($0.59 per $10 top-up) | $0.00015 | 5.9% of revenue |
| **Total** | **about $0.0006** | |
| **Margin at $0.0025** | **about $0.0019 (≈76%)** | |

Where the margin shrinks or goes negative:

- Each steer is free but costs a 👀 reaction when the owner turned them on.
- Fixed costs: the $5/month Workers Paid plan needs about 6,000 replies a month to cover at this margin.
- A Stripe dispute costs $15, and Stripe keeps its fee on a refunded top-up.

Before changing the price, measure the actual outbound sends per reply. Routing latency (not cost) is the new routing metric: `tagmails status` prints p50/p95 per step from the Mac's `routing-latency.jsonl`.
