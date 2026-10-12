# Security

Please report vulnerabilities privately, not in a public issue. Use GitHub's **Report a vulnerability** button on this repository's [Security tab](https://github.com/swaymun/tagmails/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a few days. Please give us a reasonable time to fix the issue before you disclose it.

In scope: the relay Worker (`services/`), the `tagmails` daemon and its adapters (`crates/`, `agent/`), the installer (`packaging/install.sh`), and the hosted service at tagmails.com. Test only against your own account and your own agent address, and never read or change other people's mail.

How Tagmails protects mail is described in [docs/email-privacy.md](docs/email-privacy.md).
