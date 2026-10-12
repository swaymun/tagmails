# Pricing

The hosted service at [tagmails.com](https://tagmails.com) charges **$0.0025 (a quarter of a cent) for each email you send it**, so $1 covers 400 emails. You keep a prepaid USD balance, topped up $10 at a time through Stripe Checkout; new accounts start at $0. Emails wait until your balance covers them.

The agent itself runs on your own computer with your own Codex or Claude plan, so Tagmails never bills model usage. A self-hosted relay charges nothing; billing stays off unless you configure it.

## What is charged

- Each email that Tagmails accepts and answers is charged once, when the reply goes out. That includes failed runs, runs waiting for approval, and questions Tagmails sends back (which project, an unavailable model, a revoked computer).
- A question back is still sent free when your balance can't cover it, up to five a day. After that it only appears on the run page on the website.
- A run whose computer stops responding three times is failed with a reply, charged like any other.

## What is free

- Follow-ups you send while a run is still working, when they join that run.
- A bare "thanks" sent mid-run, duplicate mail, Gmail status reactions, and mail from senders Tagmails ignores.
- Files up to 3.5 MB in total, attached to the reply. Tagmails hosts nothing larger; tell the agent where big files should go (see standing instructions in the [README](../README.md#settings-by-email)).
- A reply that is blocked before sending, or bounces for its only recipient, releases its charge.

Balances show in dollars, rounded down to the cent. A self-hosted relay can set its own price with `EMAIL_PRICE_MILLICENTS` (250 = $0.0025).
