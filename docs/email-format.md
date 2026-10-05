# Reply email format (v5)

The agent returns a structured result; the relay, not the model, builds the email (`apps/mock-inbox/mail.mjs`, `markdown.mjs`). Check changes with `npm run eval:email`, then with real Gmail desktop and mobile messages.

## Result contract

| Field | Purpose |
| --- | --- |
| `state` | `completed`, `failed`, `needs_approval`, or `needs_clarification`. `completed` means the turn ended; it does not prove every claim in the answer. |
| `answer` | The full agent answer as light Markdown, up to 32,000 characters. Older agents omit it; the email then joins `summary` and `details`. |
| `summary`, `details` | A 500-character lead and up to twelve 300-character paragraphs: a short preview kept for older clients and the run page. |
| `checks`, `note` | Limits and warnings, e.g. "verify local file changes" after a write turn. Shown in the body only when there is no run link. |
| `links`, `meta`, `statusLine`, `brandUrl` | Supplied by the relay, never by model text. |

## Layout

- The answer comes first. No heading, card or "Agent reply" label.
- Markdown renders to inline-styled HTML: paragraphs, bold/italic, lists (nested), code spans and blocks, tables, quotes. Everything is escaped first; only `https` links survive. Local file links (`/Users/...`) keep their label as plain text.
- One quiet footer line: `Transcript · GPT-6 Luna Medium · in <project> · Credits $8.85 · tagmails.` Failed and approval replies add "Stopped" / "Needs approval". Relay-only replies (clarifications, a revoked computer) have no run link.
- The plain-text part carries the same answer and footer.
- Mail is sent as `TagMails <agent address>`.

## Attachments

Owner-only completed replies attach output files directly when their combined size is at most 5 MB; larger files stay behind the private run link for seven days. The sender reads only unexpired artifacts of that account and run and checks their saved length and hash. Owner files are never attached to shared replies.

## Status reactions

For a verified, authorized task email, react to its `Message-ID`: 👀 after intake, 📝 when a computer starts work, ✅ only after a completed result is saved, ⚠️ for a known terminal failure. Each (message, state) is sent once; reaction failures never lose or duplicate the task, and reactions cost no credits. Gmail needs a separate MIME message with a `text/vnd.google.email-reaction+json` part, so reactions only work from a verified sending domain without a Reply-To override. `STATUS_REACTIONS_ENABLED` stays off until that is verified. [Gmail reaction format](https://developers.google.com/workspace/gmail/reactions/format)

## Credits and allowance

With test billing on, owner-only replies show the remaining test-credit balance; failed, approval and clarification results return their reserved credit first. Shared replies never show the owner's balance. When the Codex sign-in matches the owner, the reply can show plan allowance windows from a snapshot under 15 minutes old; never estimate allowance from token counts.
