// The setup skill an agent reads at <site>/skill.md ("Read tagmails.com/skill.md
// and set up Tagmails"). A self-hosted relay serves the same text with its
// own --relay flag.

// The daemon pairs with this relay unless told otherwise (DEFAULT_RELAY in crates/tagmails-daemon).
const HOSTED_RELAY = 'https://tagmails-relay-dev.saimun-shahee.workers.dev';
// The first release whose `tagmails pair` can pair by link.
const MIN_VERSION = '0.2.28';

function configuredOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

export function setupSkill(env, request) {
  const relay = configuredOrigin(env.PUBLIC_ORIGIN) ?? new URL(request.url).origin;
  const site = configuredOrigin(env.SITE_ORIGIN) ?? relay;
  const flag = relay === HOSTED_RELAY ? '' : ` --relay ${relay}`;
  return `---
name: tagmails
description: Set up Tagmails on this computer so emails to the user's agent address run here with Codex or Claude Code, and check on it later. Use when the user asks to set up, pair, check or fix Tagmails.
---

# Tagmails

Tagmails hands each email the user sends to their agent address to Codex or Claude Code on this computer, in the right project folder, and replies in the same Gmail thread. Each email costs $0.0025.

## Set up

Work through these in order. Don't send any email or change project files. If a step fails, show the user the error instead of working around it. Never print or ask for tokens.

1. If \`tagmails --version\` fails or shows a version older than ${MIN_VERSION}, install or upgrade it: \`brew install swaymun/tagmails/tagmails\` (or \`brew upgrade tagmails\`), or without Homebrew \`curl -fsSL https://tagmails.com/install.sh | sh\` (needs Node.js 20.16+).
2. Ask the user, in one message, whatever they haven't already told you:
   - Which agent should run their emails: Codex or Claude Code? It must be installed and signed in on this computer; check with \`codex --version\` or \`claude --version\`.
   - Which default model and reasoning effort? Offer the recommended ones (Codex: gpt-6-sol, medium; Claude Code: claude-sonnet-5-5) or whatever their agent offers. Each email can still ask for another.
   - Optional: where should files too large for email (over 3.5 MB) go, for example a connected Google Drive or Dropbox?
3. Pair this computer. If the user gave you a pairing code (\`tm_pair_…\`, from the Tagmails website), run \`tagmails pair <code>${flag}\`; it works once, within 10 minutes. Otherwise run \`tagmails pair --no-wait${flag}\`. It prints a link (${site}/connect?code=…). Show it to the user exactly as printed and ask them to open it, check that the page shows the same code, and continue with the Gmail account they will email from. Their first sign-in creates their account. When they say it's done, run \`tagmails pair${flag}\` and check that it reports the computer as paired (it waits up to 10 minutes for the approval).
4. Start Tagmails in the background: \`tagmails start --projects\`, adding \`--model <id> --effort <level>\` (and \`--speed <tier>\`) if the user chose defaults. Each email then runs in the best-matching recent project folder.
5. If the user named a place for large files: \`tagmails set --instructions "For files too large for email, upload them to my <storage> and reply with the link."\`
6. Run \`tagmails doctor\` and show the user the output. If a check fails, fix what it says and run it again.
7. Tell the user: a welcome email from their agent address is in their Gmail; replying to it is the first test. If emails wait instead of running, their balance is empty: they can add some at ${site}.

## Later

- \`tagmails status\`: connection, defaults, service state. \`tagmails doctor\`: checks the setup and prints a fix for each problem.
- \`tagmails logs\`: the service log; each email logs which model ran in which folder.
- \`tagmails set --model <id> --effort <level>\` or \`--instructions "<text>"\`: change defaults without a restart.
- \`tagmails start --access read|write|full\` and \`--claude-permission manual|accept-edits|auto|bypass\`: what agents may do on this computer (recommended: Codex write, Claude auto). Only change these when the user asks.
- \`tagmails stop\`, \`tagmails uninstall\`.
- To move Tagmails to another account or reconnect after a revoke, run \`tagmails uninstall\`, move \`~/.config/tagmails/device-token\` aside, and pair again.
`;
}
