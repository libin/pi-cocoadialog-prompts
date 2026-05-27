# pi-cocoadialog-prompts

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension
that routes the `ask_user` tool to **native macOS dialogs** via
[swift-cocoadialog](https://github.com/libin/swift-cocoadialog).

Schema-compatible with [`pi-ask-user`](https://github.com/edlsh/pi-ask-user) —
drop in either extension and the agent uses the same parameters.

## When to use this

- **Pi runs in a backgrounded terminal** (you're working in another window).
- **Pi is in a hidden tmux pane** or another desktop / Space.
- You want OS-level urgency: dock badge, app activation, audible bell on appearance.

The native NSPanel calls `NSApp.activate(ignoringOtherApps:true)` so it pops to
the front regardless of where pi is running. **Won't work on remote SSH** (no
display) — fall back to `pi-ask-user` for those sessions.

## Install

```sh
pi install git:github.com/libin/pi-cocoadialog-prompts
```

A `postinstall` hook bumps this package to the first slot in
`~/.pi/agent/settings.json`'s `packages` array. Pi's tool registry uses
first-wins ordering when multiple extensions register the same name
(e.g. `pi-agent-dashboard` also registers `ask_user`), so this is required
for the native dialog to win.

Make sure `cocoadialog` is reachable. Either:

- Build [swift-cocoadialog](https://github.com/libin/swift-cocoadialog) and
  copy `.build/release/cocoadialog` into `/usr/local/bin/`
- Set `COCOADIALOG_BIN` to the absolute binary path
- Or rely on the bundled TextMate `Bundle Support.tmbundle` copy
  (auto-detected)

To try without installing (`-e` mode skips the postinstall hook — ensure
settings already put us first, or run `node scripts/promote.mjs` manually):

```sh
pi -e git:github.com/libin/pi-cocoadialog-prompts
```

## Tool

Name: `ask_user`. Schema (compatible with `pi-ask-user`):

| Parameter           | Type | Description |
|---------------------|------|-------------|
| `question`          | `string` | The question (rendered as bold header) |
| `context`           | `string?` | Body text shown below the question |
| `options`           | `(string \| {title, description?})[]?` | Multiple-choice options |
| `allowMultiple`     | `boolean?` | Multi-select (uses checkbox dialog) |
| `allowFreeform`     | `boolean?` (default `true`) | Adds a "Type something…" fallback |
| `allowComment`      | `boolean?` | Second prompt for an optional comment |
| `freeformMultiline` | `boolean?` | Use multi-line textbox (⌘⏎ submits) for freeform answer |
| `timeout`           | `number?` | Auto-dismiss in N milliseconds |

## Result shape

```ts
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string; comment?: string };

interface AskToolDetails {
  question: string;
  context?: string;
  options: { title: string; description?: string }[];
  response: AskResponse | null;
  cancelled: boolean;
}
```

## How it maps to dialogs

| Input                                  | Native dialog |
|----------------------------------------|---------------|
| No options                             | Inputbox (single-line) or Textbox (`freeformMultiline`) |
| Options + single-select (≤ 8 items)    | Radio buttons; freeform row is inline |
| Options + single-select (> 8 items)    | Dropdown (NSPopUpButton); freeform falls back to second dialog |
| Options + `allowMultiple`              | Checkboxes |
| `allowComment`                         | Follow-up Inputbox |

Markdown in `question` / `context` is rendered (bold / italic / code / links).

## Bundled skill: `ask-user`

This package ships a skill at `skills/ask-user/SKILL.md` that nudges the agent
to use `ask_user` before high-stakes or ambiguous decisions, with a strict
question budget so the user isn't spammed with native dialogs. It mirrors
`pi-ask-user`'s decision-handshake protocol but is tuned for the native NSPanel
UX (where each call is more disruptive than a TUI overlay).

## License

MIT.
