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
	recommended: Type.Optional(Type.Boolean({ description: "Mark this option as recommended (shows a ★ badge)" })),
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
	recommended?: boolean;
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
	return arr.map((o) =>
		typeof o === "string"
			? { title: o }
			: { title: o.title, description: o.description, recommended: o.recommended },
	);
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
	// swift-cocoadialog handles the recommendation styling (pre-check + muted suffix).
	const recommendedIdx = options.findIndex((o) => o.recommended);

	// Pick a control: radio for single-select (any length), checkbox for
	// multi-select. Dropdown is deliberately NOT used: an NSPopUpButton sizes
	// itself to its widest item, so long labels (e.g. browser tab titles from
	// chrome-tab) stretched the window past the screen and pushed the buttons out
	// of view. Radio wraps long labels and the native control scrolls when the
	// list is long, so it degrades gracefully in both dimensions.
	let control: string;
	if (allowMultiple) {
		control = "checkbox";
	} else {
		control = "radio";
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
			...(recommendedIdx >= 0 ? ["--recommended", String(recommendedIdx)] : []),
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
	if (control === "radio") {
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

async function fallbackViaCtxUI(params: AskParamsT, ctx: any) {
	const options = normalizeOptions(params.options);
	const title = params.question;
	const message = params.context ?? "";
	const details: AskToolDetails = { question: title, context: message, options, response: null, cancelled: false };

	try {
		if (options.length === 0) {
			const text: string | undefined = await ctx.ui.input?.(title, message);
			if (text === undefined) {
				details.cancelled = true;
			} else {
				details.response = { kind: "freeform", text };
			}
		} else {
			const labels = options.map((o) => o.title);
			const pick: string | undefined = await ctx.ui.select?.(title, labels);
			if (pick === undefined) {
				details.cancelled = true;
			} else {
				details.response = { kind: "selection", selections: [pick] };
			}
		}
	} catch {
		details.cancelled = true;
	}

	return {
		content: [{ type: "text" as const, text: formatText(details) }],
		details,
	};
}

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

	// Defer ask_user registration to session_start so we can yield to other
	// extensions (e.g. OpenCandle) that ship their own ask_user. Pi's
	// load-time conflict check only sees tools registered during the
	// extension factory call, so registering later avoids the
	// `Tool "ask_user" conflicts with ...` error and lets both extensions
	// coexist. When another extension already owns ask_user, our ctx.ui
	// patch below still routes its prompts through native dialogs.
	pi.on("session_start" as any, (async (_event: any, ctx: any) => {
		if (ctx?.ui) patchUI(ctx.ui, bin);

		if (askUserRegistered) return;
		const all = (pi as any).getAllTools?.() ?? [];
		const owned = all.find((t: any) => t?.name === "ask_user");
		if (owned) {
			console.error(
				`[cocoadialog-prompts] another extension already registered ask_user (${owned?.sourceInfo?.path ?? "unknown"}); skipping our registration. ctx.ui.* still routed through native dialogs.`,
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

			async execute(_id, params, signal, _onUpdate, ctx: any) {
				// When the native toggle is off, render via ctx.ui.* — those are
				// patched by us and fall through to the original TUI when off.
				if (!nativeDialogsEnabled && ctx?.ui) {
					return await fallbackViaCtxUI(params, ctx);
				}
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
		askUserRegistered = true;
	}) as any);

	// Slash command to toggle the native-dialog override on/off at runtime.
	pi.registerCommand?.("native-dialogs", {
		description: "Toggle pi-cocoadialog-prompts native dialog override on/off (default: on)",
		handler: async (_args: any, ctx: any) => {
			nativeDialogsEnabled = !nativeDialogsEnabled;
			const msg = `pi-cocoadialog-prompts: native dialogs ${nativeDialogsEnabled ? "ON" : "OFF"} (TUI fallback active when OFF)`;
			ctx?.ui?.notify?.(msg, "info");
		},
	});
}

let nativeDialogsEnabled = true;
let askUserRegistered = false;

interface PatchedUI {
	confirm?: (...args: any[]) => Promise<boolean>;
	select?: (...args: any[]) => Promise<string | undefined>;
	input?: (...args: any[]) => Promise<string | undefined>;
	multiselect?: (...args: any[]) => Promise<string[] | undefined>;
	__cocoaPatched?: boolean;
	__cocoaOriginals?: {
		confirm?: (...args: any[]) => Promise<boolean>;
		select?: (...args: any[]) => Promise<string | undefined>;
		input?: (...args: any[]) => Promise<string | undefined>;
		multiselect?: (...args: any[]) => Promise<string[] | undefined>;
	};
}

function splitPrompt(title: string): { header: string; message: string } {
	// Approval gates pass the whole command as the prompt, e.g.
	// "Confirm: rm -rf …". Put the short label in --header and the (possibly
	// long) command in --message so the native dialog renders it in its
	// scrollable, syntax-highlighted, height-capped body with the buttons pinned
	// on-screen.
	const t = title || "";
	const m = t.match(/^\s*([^\n:]{1,40}):\s*([\s\S]+)$/);
	if (m) return { header: m[1].trim(), message: m[2].trim() };
	if (t.length > 60 || t.includes("\n")) return { header: "Select", message: t };
	return { header: t, message: "" };
}

function patchUI(ui: any, bin: string): void {
	const u: PatchedUI = ui;
	if (u.__cocoaPatched) return;
	u.__cocoaPatched = true;
	u.__cocoaOriginals = {
		confirm: ui.confirm?.bind(ui),
		select: ui.select?.bind(ui),
		input: ui.input?.bind(ui),
		multiselect: ui.multiselect?.bind(ui),
	};

	ui.confirm = async (title: string, message: string, opts?: any): Promise<boolean> => {
		if (!nativeDialogsEnabled) {
			return u.__cocoaOriginals?.confirm ? u.__cocoaOriginals.confirm(title, message, opts) : false;
		}
		try {
			const r = await runCD(bin, [
				"msgbox",
				"--title", "Pi",
				"--header", title || "Confirm",
				"--message", message || "",
				"--buttons", "Yes", "No",
			]);
			return r.button === "Yes";
		} catch {
			return false;
		}
	};

	ui.select = async (title: string, opts: string[], extra?: any): Promise<string | undefined> => {
		if (!nativeDialogsEnabled) {
			return u.__cocoaOriginals?.select ? u.__cocoaOriginals.select(title, opts, extra) : undefined;
		}
		try {
			const items = (opts || []).map(String);
			if (items.length === 0) return undefined;
			// Route the (possibly long) prompt/command into --message so the native
			// dialog renders it in a scrollable, syntax-highlighted, height-capped
			// body with the choices + buttons pinned on-screen. Approval gates call
			// select("Confirm: <command>", ["Allow","Block"]).
			const { header, message } = splitPrompt(title || "Pick one");
			const r = await runCD(bin, [
				// Always radio: it wraps long labels and scrolls when the list is long.
				// Dropdown would size itself to its widest item and push the buttons
				// off-screen (chrome-tab titles are the pathological case).
				"radio",
				"--title", "Pi",
				"--header", header,
				...(message ? ["--message", message] : []),
				"--items", ...items,
				"--buttons", "OK", "Cancel",
			]);
			if (r.button !== "OK") return undefined;
			const pick = r.values[r.values.length - 1] ?? "";
			return items.includes(pick) ? pick : undefined;
		} catch {
			return undefined;
		}
	};

	ui.input = async (title: string, placeholder?: string, extra?: any): Promise<string | undefined> => {
		if (!nativeDialogsEnabled) {
			return u.__cocoaOriginals?.input ? u.__cocoaOriginals.input(title, placeholder, extra) : undefined;
		}
		try {
			const args = [
				"inputbox",
				"--title", "Pi",
				"--header", title || "Input",
				"--message", "",
				"--buttons", "OK", "Cancel",
			];
			if (placeholder) args.push("--placeholder", placeholder);
			const r = await runCD(bin, args);
			if (r.button !== "OK") return undefined;
			return r.values[0] ?? "";
		} catch {
			return undefined;
		}
	};

	// Multi-select: the dashboard's ask_user advertises `multiselect` and its
	// polyfill's primary path delegates to `ctx.ui.multiselect` when present.
	// pi core does NOT provide this method, so without patching it dashboard
	// routes multiselect to its (often unwatched) web client and the tool hangs
	// with "No result provided". Render it natively with the checkbox control.
	ui.multiselect = async (title: string, opts: string[], extra?: any): Promise<string[] | undefined> => {
		if (!nativeDialogsEnabled) {
			return u.__cocoaOriginals?.multiselect ? u.__cocoaOriginals.multiselect(title, opts, extra) : undefined;
		}
		try {
			const items = (opts || []).map(String);
			if (items.length === 0) return [];
			const explicit = typeof extra?.message === "string" ? extra.message : "";
			const split = splitPrompt(title || "Select any");
			const header = explicit ? title || "Select any" : split.header;
			const message = explicit || split.message;
			const r = await runCD(bin, [
				"checkbox",
				"--title", "Pi",
				"--header", header,
				...(message ? ["--message", message] : []),
				"--items", ...items,
				"--buttons", "OK", "Cancel",
			]);
			if (r.button !== "OK") return undefined;
			// Keep only known labels, preserving the caller's option order.
			const picked = new Set(r.values.map(String));
			return items.filter((it) => picked.has(it));
		} catch {
			return undefined;
		}
	};
}
