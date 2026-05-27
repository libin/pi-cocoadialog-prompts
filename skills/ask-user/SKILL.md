---
name: ask-user
description: "You MUST use this before high-stakes architectural decisions, irreversible changes, or when requirements are ambiguous. Runs a decision handshake with the ask_user tool: summarize context, present structured options, collect explicit user choice, then proceed. With pi-cocoadialog-prompts the dialog is a native macOS NSPanel that pops to the front so the user never misses it."
metadata:
 short-description: Decision gate for ambiguity and high-stakes choices (native dialog)
---

# Ask User Decision Gate

Use this skill to force explicit user alignment before consequential decisions.

This skill is about **decision control**, not general chit-chat.

When `pi-cocoadialog-prompts` is loaded, `ask_user` opens a native macOS dialog
that activates the app and pops to the front. The user gets a real OS window
even when pi is running in a backgrounded terminal, hidden tmux pane, or a
different Space. This makes the gate harder to miss — but it also means each
call interrupts the user, so apply the question budget below strictly.

## Non-negotiable rule

Invoke `ask_user` before proceeding when **any** of the following is true:

1. The next step changes architecture, schema, API contracts, deployment strategy, or security posture.
2. The work is costly to undo (large refactor, migration, destructive edit, production-facing behavior change).
3. Requirements, constraints, or success criteria are unclear, conflicting, or missing.
4. Multiple valid options exist and the trade-off is preference-dependent.
5. You are about to assume something that can materially change implementation.

Do **not** skip this gate unless the user has already provided a clear,
explicit decision for the exact trade-off.

## Agent Protocol Handshake (required)

### 1) Detect boundary
Classify the current step as `high_stakes`, `ambiguous`, `both`, or `clear`.
If not `clear`, continue.

### 2) Gather evidence first
Use available tools (`read`, `bash`, web search, etc.) to gather context
**before** asking. Never ask the user to decide blind.

### 3) Synthesize context
Prepare a short neutral summary (3–7 bullets) covering:
- current state
- key constraints
- trade-offs
- recommendation (if any)

### 4) Ask one focused question
Call `ask_user` with one decision at a time:
- `question`: concrete decision prompt (rendered as bold header in the dialog)
- `context`: synthesized summary (rendered as message body, supports markdown)
- `options`: 2–5 clear choices when possible; use `{title, description}` form
  to surface trade-offs (these are rendered as radio buttons when descriptions
  are present, otherwise as a dropdown)
- `allowMultiple`: `false` unless independent selections are genuinely needed
- `allowFreeform`: usually `true` — adds a "Type something…" fallback row
- `allowComment`: `true` only when capturing rationale matters
- `timeout`: optional auto-cancel (ms); useful for non-blocking nudges

### 5) Commit the decision
After response:
- restate the decision in plain language
- state what will be done next
- proceed with implementation

### 6) Re-open only on new ambiguity
Ask again only if materially new uncertainty appears. Avoid loops.

## Anti-overasking guardrails (required)

Strict question budget per decision boundary:

- **Max 1** `ask_user` call per boundary in normal cases.
- **Max 2** when the first response was unclear or cancelled.
- Never ask the same trade-off again without new evidence.

Escalation ladder:

1. **Attempt 1**: structured options + concise context.
2. **Attempt 2 (only if needed)**: narrower question with agent recommendation:
   - `Proceed with recommended option`
   - `Choose another option` (freeform)
   - `Stop for now`

After attempt 2:
- If boundary is `high_stakes` or `both`: **stop and mark blocked**.
- If boundary is `ambiguous` only and the user says "your call" (or equivalent),
  proceed with the most reversible default and state assumptions explicitly.

## `ask_user` payload quality standard

### Question quality
Good:
- "Which option should we adopt for X?"
- "Do you want A (fast) or B (safer) for Y?"

Avoid:
- broad/open prompts with no decision boundary
- multiple unrelated decisions in one question
- questions answered by reading code/docs first

### Option quality
Options must be mutually understandable, short, outcome-oriented, and explicit
on trade-offs. Add a `description` when trade-offs are non-obvious — the native
dialog renders it as supporting text.

## Recommended patterns

### Single-select architecture decision

```json
{
  "question": "Which caching strategy should we use for the first release?",
  "context": "Current API has p95 latency issues. Redis is fastest but adds infra complexity; in-memory cache is simpler but not shared across instances.",
  "options": [
    { "title": "In-memory cache", "description": "Simpler rollout, weaker horizontal consistency" },
    { "title": "Redis cache", "description": "Better consistency and scalability, more ops overhead" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

### Multi-select when decisions are independent

```json
{
  "question": "Select the first-wave hardening items to implement now.",
  "context": "We can ship quickly with baseline controls, then add targeted hardening. Budget is limited to 1–2 days.",
  "options": [
    "Rate limiting",
    "Audit logging",
    "Input schema validation",
    "Secrets rotation"
  ],
  "allowMultiple": true,
  "allowFreeform": true
}
```

### Pure freeform when options aren't meaningful

```json
{
  "question": "What should I name the new feature flag?",
  "context": "It guards the new pricing engine rollout."
}
```

(With no `options`, the dialog opens directly as an inputbox.)

## Anti-patterns

- Asking `ask_user` without first gathering context.
- Using it for trivial formatting choices.
- Forcing options when freeform is clearly better.
- Asking the same question repeatedly without new information.
- Proceeding with high-stakes implementation after an unclear or cancelled answer.

## If user cancels or answer is unclear

Pause execution and explain what is blocked. At most one narrower follow-up
`ask_user` question (attempt 2). After that, do **not** continue asking:
- High-stakes decisions: remain blocked until an explicit decision arrives.
- Ambiguity-only: proceed only if the user delegated the choice ("your call").
