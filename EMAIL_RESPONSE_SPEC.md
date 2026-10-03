# TagMails email response format v1

The agent returns a structured outcome. The relay, not the model, builds the HTML and plain-text email. This format is for the first Gmail beta and its internal lab.

## Result contract

| Field | Purpose |
| --- | --- |
| `state` | `completed`, `failed`, `needs_approval`, or `needs_clarification`. `completed` means the agent turn ended and is headed “Agent reply”; it does not prove every task claim. `needs_approval` says “Needs your attention” because a local approval screen is not yet available. |
| `summary` | One concrete outcome or the one thing the recipient must decide. Never claim an unverified side effect. |
| `details` | Short items describing work or findings. Omit when empty. |
| `checks` | Verification, uncertainty, and material limits. Omit when empty. |
| `links` | Links supplied by the trusted caller, with human-readable labels. The managed outbox currently supplies only the owner-authorized run receipt. Model text does not create trusted links. |
| `note` | Optional context such as “synthetic example” or “local read-only run.” Omit when empty. |

The email has matching UTF-8 plain-text and HTML parts. It starts with the outcome, follows with work and checks, then links, then a reply invitation. HTML escapes all model text and uses semantic headings, paragraphs, lists, and anchors. No JavaScript or form controls are sent. Gmail supports a subset of CSS in `<style>` blocks and media queries; unsupported styles may be ignored, so content must remain readable without CSS. [Gmail CSS support](https://developers.google.com/workspace/gmail/design/css)

A completed local write turn adds a note asking the recipient to verify file changes before relying on them. A model can report an edit that did not happen; the relay currently verifies only a specifically requested exported file, not every workspace change.

Codex and Claude answers use the first paragraph as the email summary. If it exceeds the 500-character summary limit, the rest continues in details at word boundaries. Details are limited to twelve 300-character items by the relay contract. When the answer exceeds that space, the email explicitly says it was shortened and invites a follow-up; the private transcript is separately bounded and must not be described as a complete copy.

The linked transcript now retains the agent's final answer up to 8,000 characters within a 34 KB transcript budget, instead of showing only its first 800 characters. Earlier visible messages and tool-step descriptions remain bounded; if any content is omitted, the run page labels the transcript as shortened. The relay validates the longer final event before accepting a device completion.

For managed replies, the relay adds a “Selected model” detail from the model route stored when the inbound email arrived. The owner-only run receipts show the same route. It labels whether the sender requested the model in that email or the account default supplied it. This describes the selected route, not proof that the runtime completed a model call. Older jobs without a stored route and requests with an unavailable model omit the detail; the relay does not infer it from current settings or generated text.

Only absolute HTTPS links are accepted in normal mail. The localhost lab additionally accepts an explicit `127.0.0.1` HTTP port. The renderer checks URL syntax and scheme, then uses the same accepted links in HTML and plain text; a section with no accepted links is omitted. The caller is responsible for verifying that a link belongs to this run, has appropriate access, and points to a real resource. In the managed path, a guest-only reply has no transcript link while the Site is owner-private. A shared reply labels its link “owner only” so copied participants know they cannot open it. Once participant transcript access is enabled, authorized visible recipients may use the shared link.

Images and video use labeled private links in v1. This is a fallback, not a claim that inline media or downloads work. Inline images need a scoped artifact route, descriptive alt text, and a real Gmail rendering check. External images may be hidden by Gmail settings or message safety checks. Video should have a poster and a plain-text link after the private viewer exists. [Gmail image behavior](https://support.google.com/mail/answer/145919?hl=en)

## Repeatable evaluation

Run `npm run eval:email`. It saves raw `.eml`, parsed HTML, plain text, and `report.json` for a fixed nine-case corpus under ignored `.local/email-eval/`. The corpus covers completion, source links, image and video link fallbacks, unsafe-only links, approval, failure, clarification, and hostile text. It checks multipart MIME, outcome headings, content in both parts, link scheme filtering, escaped text, missing-value leakage, and reply continuity.

This deterministic pass checks rendering mechanics. It does not judge factual accuracy, verify URLs, test Gmail's actual rendering, or prove that model prompts produce good results. Promotion requires a human review of the fixture previews, then real owned Gmail desktop and mobile messages with saved MIME and screenshots. Model prompt versions should be compared on the same task corpus before replacing the default.

For a small live prompt comparison, run `node scripts/evaluate-email-prompt.mjs --run`. It uses the local Codex sign-in for twelve bounded, read-only Luna turns: the current Codex email prompt and a candidate on four single-turn tasks plus an owner-to-participant follow-up in one resumed thread. The source file is removed before the participant reply, testing whether the first answer preserved names and decisions. A separate case checks that forwarded text claiming to be owner approval does not make an authorized participant the owner. It saves prompts, answers, JSON events, session IDs, token counts, and a heuristic report under ignored `.local/email-prompt-eval/`. After editing the grading rules, use `--rescore <saved-run-directory>` to score saved answers again without model calls. In the first expanded run, the active prompt omitted a project codename and failed both shared-thread screens; the candidate passed. After the active prompt was revised to retain concrete names and decisions, both versions passed 10/10 narrow screens in a second run. In the twelve-turn run, both prompts rejected the forwarded approval and correctly answered the other cases. The paired answers were read manually. One run per prompt cannot establish a general quality difference or prove real Gmail behavior. [OpenAI model optimization](https://developers.openai.com/api/docs/guides/model-optimization) · [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
