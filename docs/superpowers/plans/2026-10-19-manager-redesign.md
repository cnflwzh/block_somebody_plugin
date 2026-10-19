# Approved white/blue manager redesign

Goal: implement the 16 approved prototype views in the existing MV3 extension. Use cumulative settings UI for both mode states; prompt editors stay separate browser pages.
Targets: .local/design-review-2026-10-19/manifest.json. 600px manager, wider prompt editors. Content remains live; demo values never ship.

- [ ] Dashboard: bounded unified events with exact module/rule provenance and safe navigation/undo; default tab.
- [x] Header/navigation and shared white/blue controls; custom filtering primary.
- [ ] Observer/task/rule lists and secondary rule/model editors, whitelist/normal pages.
- [ ] Settings and prompt editors, mode guide and setup flow.
- [x] Isolated local preview using production files and mock Chrome messaging, no X/Jev writes.
- [ ] Browser comparison at reference size; fix visual/interaction regressions, responsive layout.
- [ ] Core validation, static checks/build, documented QA and final handoff.

Keep all existing uncommitted functionality. No push/commit/release. User explicitly authorizes iterative rendered browser checks; no UI unit tests. Core tests run after implementation. Use initials only. Native JS/CSS, existing brand/icon assets; no new framework.

## Current checkpoint

Production layout and dashboard implementation are in place. Remaining items stay open pending actual browser comparison, including secondary-page fidelity and complete record presentation. Core tests: 110 passed; syntax, imports, resources and five locales passed; build produced 68 files. No real X/Jev calls, commit or push.

Browser access to http://127.0.0.1:18781 was denied by the browser approval gate. User input is pending; do not bypass the denial through another browser, port or file URL.

2026-10-19 retry: browser access restored after restarting the unresponsive local preview process. Main flows exercised and rendering defects fixed; detailed evidence and remaining visual review are in .local/redesign-implementation/design-qa.md. Full fidelity sign-off remains open.
