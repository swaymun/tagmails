# Internal Gmail lab design QA

- Source visual truth: `/var/folders/5p/rtwz2t594rl90y8ky50q0w5m0000gn/T/codex-clipboard-02f2a15e-e6a8-49ab-ab63-e36fae5b0861.png` (700 × 390 pixels, including laptop and browser chrome).
- Implementation: `http://127.0.0.1:4177/`. Browser screenshots were captured in Codex's in-app browser during this QA; that browser exposes the image in the tool result but no local screenshot file path.
- Desktop comparison: 1260 × 660 CSS viewport at device scale 1, displayed beside the source screenshot. The source's Gmail content is scaled inside a laptop frame, so the comparison focuses on the app content rather than the frame.
- Mobile check: 390 × 844 CSS viewport at device scale 1, inbox, compose, and shared-thread states.

## Findings and iteration

- [P2, fixed] At phone width, Compose was accessible only through the navigation menu. Added a floating Compose button on the inbox. The live mobile capture showed it at the lower right; clicking it opened the existing form with To, Cc, Bcc, Subject, and Message fields. It disappears in a thread, where Reply and authorized Reply all remain available.
- [P3, accepted] The reference depicts an older Gmail logo and browser frame. The lab uses a modern Gmail-style mark and native page presentation. The app's toolbar, folder rail, category tabs, dense rows, colors, and spacing follow the reference's content layout.

## Fidelity checks

- Typography and copy: compact Gmail-style text hierarchy; synthetic task subjects and explicit local-only labels distinguish this test inbox from real mail.
- Layout and spacing: desktop sidebar and category proportions align with the scaled reference; the 390-pixel mobile inbox and thread had no document overflow.
- Colors and assets: white surfaces, red active category, pale selected inbox, gray toolbar icons, and Gmail-style mark are consistent. The source's tiny photographic avatar is represented by a synthetic account initial.
- Interaction: mobile Compose opened; an authorized shared thread showed Reply all with the teammate in Cc; a revoked-guest thread showed Reply only. Browser error and warning logs were empty.

No remaining P0, P1, or P2 visual issue was found in these checked states. Actual Gmail rendering and a live provider email are separate pilot gates.

final result: passed
