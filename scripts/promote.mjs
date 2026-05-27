#!/usr/bin/env node
/**
 * Promote pi-cocoadialog-prompts to the first position in
 * ~/.pi/agent/settings.json's `packages` array, so its `ask_user`
 * registration wins over any other extension that also registers it.
 *
 * Pi's tool registry uses first-wins ordering when multiple extensions
 * register the same tool name. By default `pi install` appends to the
 * end of the array, which lets earlier extensions silently shadow ours.
 *
 * Safe to run repeatedly. No-op when already first.
 *
 * Triggered automatically by `npm install` (postinstall hook) when this
 * package is installed via `pi install`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SETTINGS = path.join(os.homedir(), ".pi", "agent", "settings.json");

function isUs(entry) {
	const s = typeof entry === "string" ? entry : entry?.source ?? "";
	return /pi-cocoadialog-prompts(?:[/\\]|$)/.test(s);
}

try {
	if (!fs.existsSync(SETTINGS)) {
		// Settings doesn't exist yet — first pi run will create it; nothing to do.
		process.exit(0);
	}
	const raw = fs.readFileSync(SETTINGS, "utf8");
	const data = JSON.parse(raw);
	const pkgs = Array.isArray(data.packages) ? data.packages : [];
	const idx = pkgs.findIndex(isUs);
	if (idx <= 0) {
		// Either not present yet (idx=-1: pi will add us shortly), or already first.
		process.exit(0);
	}
	const [ours] = pkgs.splice(idx, 1);
	pkgs.unshift(ours);
	data.packages = pkgs;
	fs.writeFileSync(SETTINGS, JSON.stringify(data, null, 2) + "\n");
	console.error(`[pi-cocoadialog-prompts] promoted to top of ${SETTINGS}`);
} catch (e) {
	// Never fail the install over reordering — print and exit clean.
	console.error(`[pi-cocoadialog-prompts] could not promote in settings: ${e.message}`);
	process.exit(0);
}
