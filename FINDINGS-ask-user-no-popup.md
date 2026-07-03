# FINDINGS — `ask_user` shows no popup, returns "No result provided"

**Date:** 2026-07-01
**Reporter:** Libin (via pi session, clancy cwd)
**Symptom:** Agent called `ask_user` (method `multiselect`). No native dialog appeared. Tool returned `No result provided`.

---

## TL;DR — two independent bugs

1. **Routing bug:** `ask_user` is being served by the **PI-Dashboard extension**, NOT by pi-cocoadialog-prompts. Dashboard's `multiselect` path routes to its **web client** (PromptBus), which nobody is watching in a terminal session → timeout → "No result provided".
2. **Binary capability bug:** the installed `swift-cocoadialog 3.0.0-swift` implements **only `msgbox` + `inputbox`**. `radio` / `checkbox` / `dropdown` are **"planned", not implemented** — so even correctly routed, `select` / `multiselect` cannot render.

---

## Evidence

### Who owns `ask_user`
- Active tool description contains `"UI provides a Select all toggle; do not add one"` — verbatim from
  `@blackbelt-technology/pi-dashboard-extension/src/ask-user-tool.ts`. So **dashboard owns the tool**, not us.
- Both extensions register `ask_user` at `session_start` (runtime) to bypass pi's load-time `detectExtensionConflicts`.
  Precedence = **packages array order** in `~/.pi/agent/settings.json`.
- Dashboard entry (`/Applications/PI-Dashboard.app/.../pi-dashboard-extension`) sits **earlier** than our entry
  (`../../Work/TextMate/pi-cocoadialog-prompts`), so dashboard's `session_start` registers `ask_user` **first**.
- Our `index.ts` **intentionally yields** when another extension already owns `ask_user`:
  ```ts
  const owned = all.find((t) => t?.name === "ask_user");
  if (owned) { /* skip our registration */ return; }
  ```
  `promote.mjs` tries to move us to array position 0, but it is **not effective here** (we are 4th-from-last).

### Why confirm/input would work but multiselect fails
- We patch `ctx.ui.confirm/select/input` in `patchUI()` (and patch **last**, so we win those).
- Dashboard's `ask_user.execute` calls `ctx.ui.confirm/select/input` → hits our native patches. ✅
- **BUT** dashboard's `multiselect` calls `polyfillMultiselect()` → `ctx.ui.multiselect` → **PromptBus → dashboard web UI**.
  We **never patch `ctx.ui.multiselect`** → falls through to dashboard web client → no terminal popup → hang → "No result provided". ❌
- Ref: `pi-dashboard-extension/src/multiselect-polyfill.ts` (primary path = `typeof ui.multiselect === "function"`),
  bridge patches `ctx.ui.multiselect` at `bridge.ts:1482`.

### Binary can't render menus
Installed binary: `swift-cocoadialog 3.0.0-swift` at
`~/Library/Application Support/TextMate/Managed/Bundles/Bundle Support.tmbundle/Support/shared/bin/CocoaDialog.app/Contents/MacOS/CocoaDialog`

```
CONTROLS (implemented): msgbox inputbox yesno-msgbox ok-msgbox standard-input secure-input
CONTROLS (planned):     textbox dropdown radio checkbox slider progressbar ...
```
Empirical test: `radio --items A B C` returned `{"values":["A"]}` **instantly, no interaction** (stub). `checkbox` returned empty.
So `select` (radio/dropdown) and `multiselect` (checkbox) are **non-functional** with this binary. Only `confirm`→msgbox and `input`→inputbox work.

---

## Fix required (recommended path 1 — code fix in this repo)

Two things must both be fixed:

### A. Win / co-route `multiselect`
Even though we yield the `ask_user` registration to dashboard, we must **patch `ctx.ui.multiselect`** in `patchUI()`
so dashboard's `polyfillMultiselect` picks up our native implementation (its primary path checks `typeof ui.multiselect === "function"`).
Patch order already favors us (we patch after dashboard attaches its `multiselect`), so adding the method is enough.

Also consider patching `ctx.ui.editor` for completeness.

### B. Implement `select` + `multiselect` on msgbox/inputbox primitives
The binary lacks radio/checkbox/dropdown. Implement with what exists:
- `select`: render a **numbered menu** via `inputbox` ("Enter 1-N:") or a chain of `msgbox` buttons (max ~3 buttons/dialog).
- `multiselect`: `inputbox` collecting comma-separated indices (e.g. "1,3,4"), parse back to labels.
- Validate input; re-prompt on bad entry; support cancel → return `undefined`.

(Alternative path 2: replace binary with a full cocoadialog build that implements radio/checkbox — but still need patch A for routing.)

### Guardrails
- Add a `doctor`/self-check that probes the binary for `radio`/`checkbox` support and logs a clear warning if only msgbox/inputbox exist.
- Consider NOT yielding `ask_user` when the owning extension is the dashboard AND session is terminal-only (`ctx.hasUI` heuristic), so our native dialog wins outright.

---

## Repro
```
# terminal pi session (no dashboard web client open)
ask_user({ method: "multiselect", title: "pick", options: ["a","b","c"] })
# => hangs / "No result provided"
ask_user({ method: "confirm", title: "ok?" })       # works (msgbox)
ask_user({ method: "input", title: "name?" })        # works (inputbox)
ask_user({ method: "select", title: "pick", options: ["a","b"] })  # broken (radio stub)
```

## Key files
- `pi-cocoadialog-prompts/index.ts` — `patchUI()`, `ask()`, `resolveBinary()`, session_start yield logic
- `pi-cocoadialog-prompts/scripts/promote.mjs` — array-position promoter (ineffective as-is)
- `@blackbelt-technology/pi-dashboard-extension/src/ask-user-tool.ts` — competing `ask_user`
- `@blackbelt-technology/pi-dashboard-extension/src/multiselect-polyfill.ts` — `ctx.ui.multiselect` primary path
- `@blackbelt-technology/pi-dashboard-extension/src/bridge.ts:1330-1482` — ctx.ui patch + `multiselect` PromptBus attach
- `~/.pi/agent/settings.json` — packages array order (dashboard before us)

---

## RESOLUTION — 2026-07-02 (Libin)

Re-verified both claims against the current binary + extension:

- **Claim A (routing) — CONFIRMED & FIXED.** `patchUI()` patched `confirm`/`select`/`input` but **not** `ctx.ui.multiselect`. Dashboard's `polyfillMultiselect` primary path delegates to `ctx.ui.multiselect` when present, so it was falling through to the PromptBus web client (unwatched in terminal sessions) → hang → "No result provided".
  - Fix: `patchUI()` now installs `ui.multiselect` → renders the native `checkbox` control, filters results to known labels in caller order, returns `string[]` on OK / `undefined` on Cancel (matches the polyfill contract). Originals saved for the `/native-dialogs OFF` fall-through.

- **Claim B (binary is a msgbox/inputbox stub) — STALE / NO LONGER TRUE.** The current `swift-cocoadialog 3.0.0-swift` fully implements `radio` / `checkbox` / `dropdown` / `textbox` / `slider` / `progressbar` / file panels / about (see `ControlRegistry.make`). A live `radio`/`checkbox` dialog renders and returns real selections. The agent was misled by **stale `--help` text** that still listed those as "planned".
  - Fix: corrected `Help.swift` CONTROLS list; rebuilt + redeployed the binary.

- **Bonus bug found & fixed:** our own `ask_user` `execute()` referenced `signal` while the param was named `_signal` → `ReferenceError` whenever *we* own the tool with native dialogs on. Renamed param to `signal`.

Our direct `ask_user` handler already mapped `allowMultiple → checkbox` correctly; only the `ctx.ui.multiselect` bridge path needed the patch. `promote.mjs` ordering is now moot for multiselect since we co-route via the patched `ctx.ui` regardless of who owns `ask_user`.
