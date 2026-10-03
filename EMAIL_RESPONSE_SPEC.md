# TagMails email response format v1

The agent returns a structured outcome. The relay, not the model, builds the HTML and plain-text email. This format is for the first Gmail beta and its internal lab.

## Result contract

| Field | Purpose |
| --- | --- |
| `state` | `completed`, `failed`, `needs_approval`, or `needs_clarification`. The heading must reflect the state. |
| `summary` | One concrete outcome or the one thing the recipient must decide. Never claim an unverified side effect. |
| `details` | Short items describing work or findings. Omit when empty. |
| `checks` | Verification, uncertainty, and material limits. Omit when empty. |
| `links` | Links supplied by the trusted caller, with human-readable labels. The managed outbox currently supplies only the owner-authorized run receipt. Model text does not create trusted links. |
| `note` | Optional context such as “synthetic example” or “local read-only run.” Omit when empty. |

The email has matching UTF-8 plain-text and HTML parts. It starts with the outcome, follows with work and checks, then links, then a reply invitation. HTML escapes all model text and uses semantic headings, paragraphs, lists, and anchors. No JavaScript or form controls are sent. Gmail supports a subset of CSS in `<style>` blocks and media queries; unsupported styles may be ignored, so content must remain readable without CSS. [Gmail CSS support](https://developers.google.com/workspace/gmail/design/css)

Only absolute HTTPS links are accepted in normal mail. The localhost lab additionally accepts an explicit `127.0.0.1` HTTP port. The renderer checks URL syntax and scheme; the caller is responsible for verifying that a link belongs to this run, has appropriate access, and points to a real resource. In the managed path, a recipient who is not the owner does not receive the owner receipt link.

Images and video use labeled private links in v1. This is a fallback, not a claim that inline media or downloads work. Inline images need a scoped artifact route, descriptive alt text, and a real Gmail rendering check. External images may be hidden by Gmail settings or message safety checks. Video should have a poster and a plain-text link after the private viewer exists. [Gmail image behavior](https://support.google.com/mail/answer/145919?hl=en)

## Repeatable evaluation

Run `npm run eval:email`. It saves raw `.eml`, parsed HTML, plain text, and `report.json` for a fixed eight-case corpus under ignored `.local/email-eval/`. The corpus covers completion, source links, image and video link fallbacks, approval, failure, clarification, and hostile text. It checks multipart MIME, outcome headings, content in both parts, link scheme filtering, escaped text, missing-value leakage, and reply continuity.

This deterministic pass checks rendering mechanics. It does not judge factual accuracy, verify URLs, test Gmail's actual rendering, or prove that model prompts produce good results. Promotion requires a human review of the fixture previews, then real owned Gmail desktop and mobile messages with saved MIME and screenshots. Model prompt versions should be compared on the same task corpus before replacing the default.
