# TagMails pilot agent on macOS

This bundle contains only the local daemon, its Codex and Claude adapters, and the login-agent installer. Keep it in a stable location: the macOS login agent starts the binary from this folder. It does not include the relay service, website, test inbox, or account credentials. The owner-private [setup page](https://tagmails.saimun-h-shahee.chatgpt.site/setup) provides the pilot download. The developer can also create it from a committed checkout with `node scripts/package-agent.mjs`; the command prints a local `.tar.gz` path for private transfer.

## Prepare the Mac

Install Node.js and Rust/Cargo, then sign in to the Codex or Claude Code CLI you plan to use. The selected workspace must already exist. Extract this bundle into a folder you will keep with `mkdir -p ~/tagmails-agent && tar -xzf /path/to/tagmails-agent-REVISION.tar.gz -C ~/tagmails-agent`, open Terminal in that folder, and run:

```sh
npm ci --omit=dev
cargo build --release -p tagmails-daemon
```

Only after the release build succeeds, sign in on the private setup page with the Gmail account that will own the agent. Enter the absolute path to the workspace and select **Read only** for the first pairing. Create a one-time pairing code, then run its pairing command from this extracted folder within 10 minutes. The code can pair one Mac only; keep the command private. If the command reports an interrupted response, run it again with the same code. The daemon checks the saved token's status before trying another pairing.

Once the page shows the Mac as paired, copy its start command. First append `--print` and save that preview to inspect the workspace, binary, access mode, and token path. Then run the command without `--print` to start the macOS login agent. The installer refuses to replace an existing one.

The login agent watches for new email jobs. Its logs are in `~/Library/Logs/TagMails/`. Revoking the Mac on the setup page stops new claims. To stop the local process, use `launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.tagmails.daemon.plist"`. Remove that plist only when you want to disable startup at login.

## Moving or updating the bundle

Stop the login agent before moving this folder. A new build stays in a separate folder until you have tested it. The existing LaunchAgent plist contains an absolute binary path and does not update itself; install a new plist only after stopping and removing the old one. Keep the owner-only device token file at `~/.config/tagmails/device-token` so the existing pairing can be reused. Do not send that file with the bundle.

The development relay and Site are currently for a private pilot. Live provider email delivery and paid billing are separate launch gates.
