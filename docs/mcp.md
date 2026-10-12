# TagMails over MCP

The relay serves a plain remote MCP server at `<relay>/mcp` (streamable HTTP, JSON responses, no UI). The hosted one is `https://tagmails-relay-dev.saimun-shahee.workers.dev/mcp`; a self-hosted relay serves the same path on its own origin.

## Connect

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add --transport http tagmails <relay>/mcp`, then `/mcp` → tagmails → Authenticate |
| Codex | `codex mcp add tagmails --url <relay>/mcp`, then `codex mcp login tagmails` |
| Claude, ChatGPT | Settings → Connectors → **Add custom connector**, URL `<relay>/mcp` |

The client opens a TagMails page that asks you to sign in with Google: the same owner check as the website. On a relay with `PUBLIC_SIGNUP_ENABLED=true` the first sign-in creates your account; otherwise only `PILOT_OWNER_EMAIL` can connect.

## Tools

| Tool | Does |
| --- | --- |
| `status` | Agent address, paired computers and last check-in, balance and price, 5 recent runs, connected apps |
| `pair` | One-time pairing code (10 minutes) plus the exact install, `tagmails pair` and `tagmails start` commands and the site's setup prompt. Run them on the computer that should do the work. Adds `--relay` for a self-hosted relay. |
| `runs`, `run` | Recent runs; one run's receipt. The agent's summary and answer appear only while the relay can read the stored result (`result.status` is `available`, `none`, `expired` or `unreadable`). |
| `billing` | Balance and a Stripe Checkout link for a $10 top-up. The tool never charges anything. |
| `revoke_device` | Disconnect a paired computer; its queued and running jobs fail. |
| `disconnect` | Revoke this app's access (or another connected app's, by id from `status`). |

## Tokens

- OAuth 2.1 authorization code flow with PKCE (S256) and dynamic client registration; clients are public (no secret). Metadata: `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`.
- Scopes: `tagmails.read` (`status`, `runs`, `run`) and `tagmails.manage` (`pair`, `billing`, `revoke_device`). No scope requested means both.
- Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every use; reusing an old one more than a minute later revokes the whole connection. `POST /oauth/revoke` with either token, or the `disconnect` tool, ends a connection at once. Codes and tokens are stored only as hashes.
- Every token is bound to one account; tools read and change only that account's rows.
- Tokens are issued only for `<relay>/mcp` (a different `resource` gets `invalid_target`). A tool the connection's scope doesn't cover returns 403 with `insufficient_scope`.
- `/mcp` refuses browser `Origin`s other than the relay, the Site, claude.ai, chatgpt.com, localhost and `MCP_ALLOWED_ORIGINS`; requests without an Origin are fine.
- Limits: bad tokens and sign-in attempts share `AUTH_RATE_LIMIT` per IP, token requests share it per client, and signed-in calls share `PUBLIC_RATE_LIMIT` per account.
