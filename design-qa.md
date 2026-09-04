# Design QA

## Evidence

- Source: `/var/folders/yh/p91mkfss73l0k4r4522lzpqw0000gn/T/codex-clipboard-7b90cb93-f8ea-4afb-887e-3e6f52c225f6.png`
- Hero implementation: `design-qa-assets/hero-implementation.png` at the in-app browser's 1280 × 720 viewport
- General settings implementation: `design-qa-assets/general-settings-implementation.png`
- Focused source/implementation comparison: `design-qa-assets/hero-comparison.png`; both Hero regions were cropped to the same 3.07:1 aspect ratio and normalized to 1014 × 330

## Findings

- P0: none.
- P1: none. The local-folder action occupies the requested third position in the Hero control row, after Workspace and agent preset. The floating machine-shutdown control is absent behind the gateway, and account logout is the final General settings row.
- P2: the launcher summary initially exposed only a generic accessible role. It now exposes a button role and is announced as “一键选择本机文件夹”.
- Visual differences limited to live state: the connected Workspace name and current access mode differ from the reference account state. Spacing, typography, transparent chip treatment, icon scale, and composer alignment match the adjacent controls.

## Interaction and runtime checks

- Settings opens on General and renders the logout description and danger-outline action without clipping.
- The local-folder action's network/protocol path is covered by focused tests; browser activation was intentionally not used because it launches the operating-system companion.
- No console error originates from `dsh-passwords` or `ui-conversation`. Existing unrelated messages remain in `dsh-spend` (`UsageStatsWidget` key warning) and `dsh-better-sidebar` (agent-terminals connection failure).

final result: passed
