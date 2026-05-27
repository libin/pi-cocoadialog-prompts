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

async function ask(bin: string, params: AskParamsT, signal?: AbortSignal): Promise<AskToolDetails> {
	const options = normalizeOptions(params.options);
	const { header, message } = buildHeader(params.question, params.context);
	const timeoutArgs = timeoutSeconds(params.timeout);
	const allowFreeform = params.allowFreeform ?? true;
	const allowMultiple = params.allowMultiple ?? false;
	const allowComment = params.allowComment ?? false;

	const detailsBase: AskToolDetails = {
		question: params.question,
		context: params.context,
		options,
		response: null,
		cancelled: false,
	};

	// Pure freeform path: no options.
	if (options.length === 0) {
		const r = await runCD(
			bin,
			["inputbox", "--title", "Pi", "--header", header, "--message", message, "--buttons", "OK", "Cancel", ...timeoutArgs],
			signal,
		);
		if (r.button !== "OK") return { ...detailsBase, cancelled: true };
		const text = r.values[0] ?? "";
		const comment = allowComment ? await askComment(bin, signal) : undefined;
		return { ...detailsBase, response: { kind: "freeform", text, comment } };
	}

	// Build display labels (with optional descriptions appended).
	const displayLabels = options.map((o) => (o.description ? `${o.title} — ${o.description}` : o.title));
	if (allowFreeform) displayLabels.push(FREEFORM_LABEL);

	// Pick a control: dropdown when single-select-from-many, checkbox for multi.
	let control: string;
	if (allowMultiple) {
		control = "checkbox";
	} else if (options.length <= 4 && options.some((o) => o.description)) {
		// Few rich options → radio (description is visible inline)
		control = "radio";
	} else {
		control = "dropdown";
	}

	const r = await runCD(
		bin,
		[
			control,
			"--title",
			"Pi",
			"--header",
			header,
			"--message",
			message,
			"--items",
			...displayLabels,
			"--buttons",
			"OK",
			"Cancel",
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
		// values: [index, title]
		const t = r.values[r.values.length - 1] ?? "";
		chosen = t ? [t] : [];
	} else if (control === "radio") {
		// First value is the selected radio label.
		chosen = r.values.slice(0, 1);
	} else {
		// checkbox: list of selected labels.
		chosen = r.values;
	}

	// Freeform fallback was selected → second dialog for the actual text.
	if (chosen.includes(FREEFORM_LABEL)) {
		const f = await runCD(
			bin,
			["inputbox", "--title", "Pi", "--header", header, "--message", message || "Type your answer:", "--buttons", "OK", "Cancel"],
			signal,
		);
		if (f.button !== "OK") return { ...detailsBase, cancelled: true };
		const text = f.values[0] ?? "";
		const comment = allowComment ? await askComment(bin, signal) : undefined;
		return { ...detailsBase, response: { kind: "freeform", text, comment } };
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

	console.error(`[cocoadialog-prompts] ask_user routed to ${bin}`);
}
