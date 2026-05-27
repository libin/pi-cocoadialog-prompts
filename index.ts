/**
 * pi-cocoadialog-prompts
 * --------------------------------------------------------------------------
 * Drop-in alternate for pi-ask-user that routes prompts to native macOS
 * NSPanel dialogs (via swift-cocoadialog) instead of the in-terminal TUI.
 *
 * Use when pi runs in a backgrounded terminal, hidden tmux pane, or another
 * desktop — a native dialog pops to the front and you never miss it.
 *
 * Schema is intentionally compatible with pi-ask-user (edlsh/pi-ask-user).
 *
 * Install:  pi -e ./cocoadialog-prompts.ts
 * Requires: swift-cocoadialog binary on PATH or COCOADIALOG_BIN.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

const DEFAULT_BINS = [
	process.env.COCOADIALOG_BIN,
	"/usr/local/bin/cocoadialog",
	"/opt/homebrew/bin/cocoadialog",
	`${process.env.HOME}/Library/Application Support/TextMate/Managed/Bundles/Bundle Support.tmbundle/Support/shared/bin/CocoaDialog.app/Contents/MacOS/CocoaDialog`,
].filter((p): p is string => !!p);

function resolveBinary(): string | null {
	for (const p of DEFAULT_BINS) if (existsSync(p)) return p;
	return null;
}

// ---------------------------------------------------------------------------
// Cocoadialog runner
// ---------------------------------------------------------------------------

interface CDResult {
	button: string;
	buttonIndex: number;
	values: string[];
	exit: number;
}

function runCD(bin: string, args: string[], signal?: AbortSignal): Promise<CDResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			bin,
			[...args],
			{ encoding: "utf8", env: { ...process.env, COCOADIALOG_JSON: "1" } },
			(err, stdout) => {
				if (err && (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
					reject(new Error("aborted"));
					return;
				}
				try {
					resolve(JSON.parse(stdout || "{}"));
				} catch (e) {
					reject(new Error(`cocoadialog parse error: ${(e as Error).message}\n${stdout}`));
				}
			},
		);
		signal?.addEventListener("abort", () => child.kill("SIGTERM"));
	});
}

// ---------------------------------------------------------------------------
// Tool schema (matches pi-ask-user shape)
// ---------------------------------------------------------------------------

const OptionWithDesc = Type.Object({
	title: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Optional description" })),
});

const AskParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	context: Type.Optional(Type.String({ description: "Relevant context summary shown before the question" })),
	options: Type.Optional(
		Type.Array(Type.Union([Type.String(), OptionWithDesc]), {
			description: "Multiple-choice options",
			default: [],
		}),
	),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Enable multi-select", default: false })),
	allowFreeform: Type.Optional(Type.Boolean({ description: "Add a 'Type something' freeform fallback", default: true })),
	allowComment: Type.Optional(Type.Boolean({ description: "Collect optional extra-context comment", default: false })),
	freeformMultiline: Type.Optional(Type.Boolean({ description: "Use a multi-line text box for the freeform answer (default: single-line input)", default: false })),
	timeout: Type.Optional(Type.Number({ description: "Auto-dismiss after N ms; returns null on timeout" })),
});

type AskParamsT = typeof AskParams.static;

interface QuestionOption {
	title: string;
	description?: string;
}

type AskResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string; comment?: string };

interface AskToolDetails {
	question: string;
	context?: string;
	options: QuestionOption[];
	response: AskResponse | null;
	cancelled: boolean;
}

function normalizeOptions(opts: AskParamsT["options"]): QuestionOption[] {
	const arr = opts ?? [];
	return arr.map((o) => (typeof o === "string" ? { title: o } : { title: o.title, description: o.description }));
}

// ---------------------------------------------------------------------------
// Dialog flow
// ---------------------------------------------------------------------------

function buildHeader(question: string, context?: string): { header: string; message: string } {
	if (context && context.trim()) {
		return { header: question, message: context };
	}
	return { header: question, message: "" };
}

function timeoutSeconds(ms?: number): string[] {
	if (!ms || ms <= 0) return [];
	const s = Math.max(1, Math.round(ms / 1000));
	return ["--timeout", String(s), "--timeout-default-button", "Cancel"];
}

const FREEFORM_LABEL = "Type something…";
const COMMENT_LABEL = "Comment (optional)";

async function freeformInput(
	bin: string,
	header: string,
	message: string,
	multiline: boolean,
	timeoutArgs: string[],
	signal?: AbortSignal,
): Promise<{ ok: boolean; text: string }> {
	const control = multiline ? "textbox" : "inputbox";
	const args = [
		control,
		"--title", "Pi",
		"--header", header,
		"--message", message || "Type your answer:",
		"--buttons", "OK", "Cancel",
		...timeoutArgs,
	];
	const r = await runCD(bin, args, signal);
	if (r.button !== "OK") return { ok: false, text: "" };
	// inputbox: values=[text]; textbox: values=[buttonLabel?, text] depending on shape.
	const text = r.values[r.values.length - 1] ?? "";
	return { ok: true, text };
}

async function ask(bin: string, params: AskParamsT, signal?: AbortSignal): Promise<AskToolDetails> {
	const options = normalizeOptions(params.options);
	const { header, message } = buildHeader(params.question, params.context);
	const timeoutArgs = timeoutSeconds(params.timeout);
	const allowFreeform = params.allowFreeform ?? true;
	const allowMultiple = params.allowMultiple ?? false;
	const allowComment = params.allowComment ?? false;
	const freeformMultiline = params.freeformMultiline ?? false;

	const detailsBase: AskToolDetails = {
		question: params.question,
		context: params.context,
		options,
		response: null,
		cancelled: false,
	};

	// Pure freeform path: no options.
	if (options.length === 0) {
		const f = await freeformInput(bin, header, message, freeformMultiline, timeoutArgs, signal);
		if (!f.ok) return { ...detailsBase, cancelled: true };
		const comment = allowComment ? await askComment(bin, signal) : undefined;
		return { ...detailsBase, response: { kind: "freeform", text: f.text, comment } };
	}

	// Build display labels (with optional descriptions appended).
	const displayLabels = options.map((o) => (o.description ? `${o.title} — ${o.description}` : o.title));

	// Pick a control: radio for short single-select lists, dropdown for many,
	// checkbox for multi-select.
	let control: string;
	if (allowMultiple) {
		control = "checkbox";
	} else if (displayLabels.length <= 8) {
		control = "radio";
	} else {
		control = "dropdown";
	}

	// For radio with freeform, use the swift-cocoadialog --with-input flag
	// so options + freeform input live in one dialog.
	const inlineFreeform = allowFreeform && control === "radio";
	const extraArgs: string[] = [];
	if (inlineFreeform) {
		extraArgs.push("--with-input", FREEFORM_LABEL);
		if (freeformMultiline) extraArgs.push("--with-input-multiline");
	}

	const r = await runCD(
		bin,
		[
			control,
			"--title", "Pi",
			"--header", header,
			"--message", message,
			"--items", ...displayLabels,
			...extraArgs,
			"--buttons", "OK", "Cancel",
			...timeoutArgs,
		],
		signal,
	);
	if (r.button !== "OK") return { ...detailsBase, cancelled: true };

	// Map back from display labels to original titles.
	const resolveTitles = (labels: string[]): string[] =>
		labels
			.map((label) => {
				if (label === FREEFORM_LABEL) return FREEFORM_LABEL;
				const idx = displayLabels.indexOf(label);
				if (idx >= 0 && idx < options.length) return options[idx].title;
				return label;
			})
			.filter((s) => !!s);

	let chosen: string[];
	if (control === "dropdown") {
		const t = r.values[r.values.length - 1] ?? "";
		chosen = t ? [t] : [];
	} else if (control === "radio") {
		// values: [selectedLabel] or [labelOrFreeformText] when --with-input
		chosen = r.values.slice(0, 1);
	} else {
		chosen = r.values;
	}

	// Inline-freeform path: when radio's selected value isn't one of the
	// known display labels, treat it as the freeform answer.
	if (inlineFreeform && chosen.length === 1 && !displayLabels.includes(chosen[0])) {
		const comment = allowComment ? await askComment(bin, signal) : undefined;
		return { ...detailsBase, response: { kind: "freeform", text: chosen[0], comment } };
	}

	// Legacy path: --with-input not supported (dropdown / multi-select with freeform).
	if (allowFreeform && !inlineFreeform && displayLabels.length === 0) {
		// (handled above by zero-options branch)
	}

	const titles = resolveTitles(chosen);
	const comment = allowComment ? await askComment(bin, signal) : undefined;
	return { ...detailsBase, response: { kind: "selection", selections: titles, comment } };
}

async function askComment(bin: string, signal?: AbortSignal): Promise<string | undefined> {
	const r = await runCD(
		bin,
		["inputbox", "--title", "Pi", "--header", COMMENT_LABEL, "--message", "Add an optional comment (or leave blank):", "--buttons", "Done", "Skip"],
		signal,
	);
	if (r.button !== "Done") return undefined;
	const txt = r.values[0] ?? "";
	return txt || undefined;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatText(d: AskToolDetails): string {
	if (d.cancelled) return "(cancelled)";
	if (!d.response) return "(no response)";
	if (d.response.kind === "freeform") {
		return d.response.comment ? `${d.response.text}\n\n[comment] ${d.response.comment}` : d.response.text;
	}
	const sel = d.response.selections.join(", ");
	return d.response.comment ? `${sel}\n\n[comment] ${d.response.comment}` : sel;
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const bin = resolveBinary();
	if (!bin) {
		console.error(
			"[cocoadialog-prompts] cocoadialog binary not found on PATH. " +
				"Install swift-cocoadialog or set COCOADIALOG_BIN to the binary path.",
		);
		return;
	}

	pi.registerTool({
		name: "ask_user",
		label: "Ask User (native dialog)",
		description:
			"Ask the user a question via a native macOS dialog (NSPanel). " +
			"Pops to the front so the prompt is never missed, regardless of where pi runs. " +
			"Schema-compatible with pi-ask-user.",
		parameters: AskParams,

		async execute(_id, params, signal) {
			try {
				const details = await ask(bin, params, signal);
				return {
					content: [{ type: "text", text: formatText(details) }],
					details,
				};
			} catch (e) {
				const msg = (e as Error).message;
				return {
					content: [{ type: "text", text: `ask_user failed: ${msg}` }],
					isError: true,
				};
			}
		},
	});

	registerPermissionGate(pi, bin);
}

// ---------------------------------------------------------------------------
// Permission gate: prompts before risky tool calls via native dialog.
// Opt-in via PI_COCOADIALOG_PERMISSIONS env var.
//   '0'/'off'/unset → disabled (default)
//   '1'/'all'      → every bash/edit/write/find/grep call
//   'dangerous'    → only patterns matching rm -rf, sudo, chmod 777, curl|sh, etc.
//   'bash,write'   → only the named tools
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: RegExp[] = [
	/\brm\s+(-rf?|--recursive)\b/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
	/\bdd\s+if=/i,
	/\bmkfs\b/i,
	/^\s*>\s*\/dev\/(sd|hd|nvme)/i,
];

type GateMode = "off" | "all" | "dangerous" | "named";

function parseGateConfig(): { mode: GateMode; tools: Set<string> } {
	const raw = (process.env.PI_COCOADIALOG_PERMISSIONS || "").trim().toLowerCase();
	// Default: gate dangerous patterns (rm -rf, sudo, curl|sh, etc.). Users can
	// opt out with `off`, escalate to `all`, or pick named tools.
	if (!raw) return { mode: "dangerous", tools: new Set() };
	if (raw === "0" || raw === "off" || raw === "false") return { mode: "off", tools: new Set() };
	if (raw === "1" || raw === "all" || raw === "true") return { mode: "all", tools: new Set() };
	if (raw === "dangerous") return { mode: "dangerous", tools: new Set() };
	return { mode: "named", tools: new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)) };
}

function shouldGate(cfg: { mode: GateMode; tools: Set<string> }, toolName: string, command: string): boolean {
	if (cfg.mode === "off") return false;
	if (cfg.mode === "dangerous") return DANGEROUS_PATTERNS.some((p) => p.test(command));
	if (cfg.mode === "all") return ["bash", "edit", "write", "find", "grep"].includes(toolName);
	return cfg.tools.has(toolName);
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return String(input.command ?? "");
		case "edit":
			return `${String(input.path ?? "")}\n\n${String(input.oldText ?? "").slice(0, 80)}\n→\n${String(input.newText ?? "").slice(0, 80)}`;
		case "write":
			return `${String(input.path ?? "")} (${String(input.content ?? "").length} bytes)`;
		default:
			return JSON.stringify(input).slice(0, 200);
	}
}

function registerPermissionGate(pi: ExtensionAPI, bin: string): void {
	const cfg = parseGateConfig();
	if (cfg.mode === "off") return;

	pi.on("tool_call", async (event: any) => {
		const toolName: string = event.toolName;
		const input: Record<string, unknown> = event.input ?? {};
		const summary = summarizeToolCall(toolName, input);
		if (!shouldGate(cfg, toolName, summary)) return undefined;

		try {
			const r = await new Promise<CDResult>((resolve, reject) => {
				execFile(
					bin,
					[
						"msgbox",
						"--title", "Pi permission",
						"--header", `Allow ${toolName}?`,
						"--message", summary,
						"--icon", "caution",
						"--buttons", "Allow", "Deny",
						"--default-button", "Deny",
						"--cancel-button", "Deny",
					],
					{ encoding: "utf8", env: { ...process.env, COCOADIALOG_JSON: "1" } },
					(_err, stdout) => {
						try {
							resolve(JSON.parse(stdout || "{}"));
						} catch (e) {
							reject(e);
						}
					},
				);
			});
			if (r.button !== "Allow") {
				return { block: true, reason: "Denied via native permission dialog" };
			}
		} catch {
			return { block: true, reason: "Permission dialog failed; blocking by default" };
		}
		return undefined;
	});
}
