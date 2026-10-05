# Provider path for a paid TagMails beta

Private decision draft, October 3, 2026. No inquiry has been submitted and no
provider approval is implied by the owner-only development pilot.

## Product facts to disclose

- TagMails gives each verified Gmail user an address on `tagmails.com`. An email
  starts or resumes a coding-agent turn on that user's paired Mac; the hosted
  relay handles intake, queueing, a threaded reply, a private receipt, and
  expiring file transfer.
- The proposed beta charges a fixed **service fee per accepted email task** and
  does not sell, pool, or transfer model tokens. The current five-cent wallet is
  Stripe **test mode**; the candidate customer price is fifteen cents per turn,
  subject to measured costs and provider approval.
- The user signs in to Codex or Claude locally on their Mac. TagMails does not
  receive that provider credential. The server is remotely hosted, and the
  source repository is currently private. The present live pilot has one owner,
  uses Codex app-server locally, and is not open for customer signup.
- A customer's own Gmail address is verified separately with Google sign-in.
  Google sign-in alone grants no Gmail mailbox or Drive scope.

## OpenAI: prepared commercial interest-form answer

Use the [official commercial interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)
when the company contact fields and public website are ready. Select **Sign in
and ChatGPT plan use for AI requests**. Proposed text for the product field:

> TagMails is an email-native coding-agent service. A customer verifies a Gmail
> address, pairs their own Mac, and emails an agent address. A hosted relay
> receives and queues the email and sends the result back in the same thread.
> The agent runs locally on that customer's Mac with their own Codex sign-in.
> We plan to charge only for email intake, delivery, queueing, a private run
> receipt, and short-lived file transfer, on a per-task basis. We do not sell
> or pool ChatGPT plan usage. The current owner-only pilot is private and uses
> Codex app-server. Is this commercial, remotely hosted architecture eligible
> for ChatGPT plan usage, and what registration, user-consent, and host-ID path
> should we use before inviting paying customers?

The form also requires a work email, first and last name, company name, and
website URL. Supply and verify those against the user's preferred business
identity before submission. Do not substitute the private Site URL for a public
website without checking that the recipient can open it.

OpenAI's [plan-usage overview](https://developers.openai.com/siwc/token-sharing-open-source)
directs paid or remotely hosted apps to that form. Its
[quickstart](https://developers.openai.com/siwc/quickstart) describes selected
private clients; neither page confirms TagMails' eligibility.

## Anthropic: prepared product-path question

Send through an official Anthropic business/developer support route after
confirming the recipient. Proposed message:

> We are building TagMails, an email-native coding-agent service. Each user
> would install a local daemon on their own Mac and authenticate their own
> Claude Code or Claude Agent SDK session. Our hosted relay receives their
> email, queues the job, and sends the agent's reply. We intend to charge a
> fixed fee for the email service only; we would not resell, pool, or handle
> Claude credentials. Does using a customer's Claude subscription from that
> customer's Mac in this paid product count as prohibited third-party traffic
> against subscription limits? If so, is there an approved per-user plan path,
> or must each customer use Claude Platform API authentication? Please confirm
> the permitted authentication and billing path before we enable customer
> Claude turns.

Anthropic's current [account guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
says products built for others should use API authentication and warns against
routing third-party traffic against subscription limits. Its
[Agent SDK notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says third-party SDK and `claude -p` usage currently draws from a subscription,
but its announced billing change was paused; that notice does not grant this
paid product an exception. Keep customer Claude routing disabled until an
approved path is documented.

## Decision after replies

Record each provider's answer, exact scope, date, and any required integration
or pricing conditions. A provider's approval of owner-only testing is not
approval of paying customers. If subscription use is not supported, keep the
first beta owner-only or change the offer and obtain a fresh customer pricing
decision before introducing API-funded execution.
