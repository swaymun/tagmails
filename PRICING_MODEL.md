# TagMails pricing model

Internal decision memo, checked October 3, 2026. These are current public list prices and illustrative calculations, not measured TagMails unit economics or a customer offer.

## What one charge buys

The billable unit should be **one accepted task turn**: one authorized inbound message that starts or resumes an agent run, plus its result email and retained receipt. A second substantive reply is another turn, including when an authorized participant sends it. A duplicate delivery, Gmail reaction, invalid `Model:` request, or rejected sender is not a billable turn. The account owner funds participant turns; the owner alone can grant participants. Show the expected debit before enabling a model route, and state the refund rule for failed or bounced replies before live payments.

The test wallet now returns the five-cent debit when Resend reports a terminal `bounced`, `failed`, or `suppressed` outcome for the reply's sole To recipient. That recipient is the sender of the task turn. A Cc recipient's failure alone does not release the charge, and a delayed event is not terminal. The release is one-way if a later event says delivered, in the customer's favor. This is an internal pilot rule; verify real provider event ordering and decide how to explain mixed-recipient outcomes before collecting money.

Keep two prices visibly separate:

1. **Bring your plan:** a service charge for intake, queueing, email reply, receipt, and seven-day file storage. Codex or Claude usage draws against the customer's own subscription and is not an API cost paid by TagMails.
2. **Managed API:** the same service charge plus measured model and tool spend and a disclosed management margin. Reserve a maximum before starting and return unused credit. This path is not implemented for customer billing.

## Public rate inputs

| Cost | Current public rate | Implication |
| --- | --- | --- |
| Resend transactional mail | Free: 3,000 emails/month and 100/day. Pro: $20/month for 50,000, then $0.90/1,000 overage. Each received email counts against the transactional quota. | Budget at least an inbound and an outbound quota unit per successful turn. Verify multi-recipient counting on an actual invoice before pricing shared threads. The free daily limit could constrain a bursty beta. [Resend pricing](https://resend.com/pricing) |
| Jev 1.13 model router | $0.042/million input tokens; output tokens are free. | At most one call for a new thread without an explicit model line; replies inherit their route. Budget this separately from the agent run and watch accuracy and latency as well as price. [TypeSafe models](https://docs.typesafe.ai/models) |
| Cloudflare Worker | Paid account minimum $5/month, including 10 million requests and 30 million CPU milliseconds; overage is $0.30/million requests and $0.02/million CPU milliseconds. | The $5 fixed floor matters at low volume. Actual CPU, request count, and account-wide allocation need measurement. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 and R2 | D1 Paid includes 25 billion reads, 50 million writes, and 5 GB. R2 Standard includes 10 GB-month, 1 million Class A, and 10 million Class B operations; excess storage is $0.015/GB-month. | Likely within allowances for a small text beta, but large attachments, repeated downloads, and delayed cleanup must be metered. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Stripe domestic card | 2.9% + $0.30 per successful transaction. | A $10 top-up costs about $0.59, leaving $9.41 before the service is delivered. International cards, conversion, disputes, refunds, and taxes can change this. [Stripe US pricing](https://stripe.com/us/pricing) |
| GPT-6.1 Sol API | $2/million uncached input tokens, $0.10/million cached input, $10/million output. Inputs above 272K in one request have higher rates. | Execution cost can dwarf the mail fee; record every request, cache category, tool call, and final provider charge. [Official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |
| Claude Sonnet 5.5 API | $2/million input tokens, $0.20/million cache reads, $10/million output. | The list-price base matches Sol, but workload tokenization, caching, tools, and result quality can change cost per completed turn. [Claude model pricing](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) |

## Illustrative math

The current **$0.05 test debit is a fixture price**, not a release price. If a $10 domestic-card top-up is fully consumed at five cents per turn, the $0.59 card fee allocates to about **$0.00295 per turn**, leaving **$0.04705** before mail, hosting, support, and refunds. At 100 turns/month, a standalone $5 Worker floor alone is $0.05/turn. At 1,000 turns/month it is $0.005/turn, and a simple one-inbound/one-outbound assumption consumes 2,000 Resend quota units. If the Pro plan is required at that volume, its $20 floor adds $0.02/turn. These are scenario divisions, not forecasts; shared Cloudflare costs and actual provider metering may differ.

The live 24-case routing evaluation made 19 Jev calls using 10,021 input tokens, or about 527 per call. At the October 3 list rate, that is an estimated **$0.000421 total** and **$0.000022 per classified email**; 1,000 similarly sized initial emails would cost about **$0.022** in Jev input. This is a list-price calculation from reported token usage, not an invoice or a forecast for longer emails. The relay caps current subject and body text before classification, and an explicit `Model:` line or a reply that inherits its thread route skips Jev.

An illustrative API turn with **100,000 uncached input tokens and 5,000 output tokens** costs **$0.25** at the listed Sol or Sonnet rates, before extra tool, cache-write, long-context, and retry charges. A 10% model markup alone adds $0.025. After allocating the $10 top-up card fee proportionally, that markup contributes only about $0.009 before mail, hosting, support, and losses. The provisional five-cent service fee plus that API charge and 10% margin would total **$0.325** for this example, but a real agent turn can use many requests and cost much more. Do not publish a flat managed-model price without a hard budget and measured cost distribution.

The October 3 prompt evaluation saved usage for eight **active-prompt Codex Luna** turns on short synthetic email tasks. They reported 15,482–53,610 input tokens per turn, including 11,008–41,216 cached input tokens, and 49–184 output tokens. Applying the listed GPT-6.1 Sol rates to those token categories yields a **counterfactual** $0.0105–$0.0341 per turn, averaging $0.0188. These were subscription-backed Luna CLI runs, not Sol API charges; the small read-only fixtures omit production email delivery, files, retries, longer agent work, and any paid tools. The sample therefore cannot set a customer price. Even its average would leave only about 3.1 cents of a five-cent debit before payment fees, email, hosting, storage, and support if TagMails paid that model bill. [GPT-6.1 Sol list rates](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

## Decision gate

Keep the five-cent debit in test mode. For a priced beta, measure at least: accepted turns and provider quota units per turn (including To/Cc fanout), Worker CPU and D1/R2 use, file storage days, card fee by top-up size, model spend per completed and failed turn, retries, bounced replies, refunds, and human support time. Sample both short and long multi-turn Codex and Claude tasks. Set the service charge from the upper observed cost range plus a clear margin; show a separate maximum for managed API work. Reconcile Stripe's signed test webhook, then validate the failure/refund policy against real delivery events before collecting real money.
