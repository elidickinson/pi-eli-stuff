/**
 * StatusNote Extension
 *
 * Track what you're working on with a custom status displayed in the footer.
 * Persists across session forks and resumes.
 *
 * Commands:
 *   /status <text>  - Set custom status text
 *   /status         - Clear the status
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const CUSTOM_TYPE = "statusnote";

interface StatusNote {
	text: string;
}

export default function (pi: ExtensionAPI) {
	let currentStatus = "";

	// Restore status from session entries
	function restoreStatus(ctx: ExtensionContext) {
		currentStatus = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as StatusNote | undefined;
				currentStatus = data?.text ?? "";
			}
		}
		updateStatus(ctx);
	}

	// Update the footer status
	function updateStatus(ctx: ExtensionContext) {
		if (currentStatus) {
			ctx.ui.setStatus("statusnote", ctx.ui.theme.fg("success", "◆ ") + ctx.ui.theme.fg("muted", currentStatus) + ctx.ui.theme.fg("success", " ◆"));
		} else {
			ctx.ui.setStatus("statusnote", undefined);
		}
	}

	// Restore on session events
	pi.on("session_start", async (_event, ctx) => restoreStatus(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreStatus(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreStatus(ctx));

	// Register the /status command
	pi.registerCommand("status", {
		description: "Set custom status text shown in footer. Usage: /status <text> to set, /status to clear",
		async handler(args, ctx) {
			const text = args?.trim();

			if (!text) {
				currentStatus = "";
				pi.appendEntry(CUSTOM_TYPE, { text: "" });
				ctx.ui.notify("Status cleared", "info");
			} else if (text === "clear") {
				currentStatus = "";
				pi.appendEntry(CUSTOM_TYPE, { text: "" });
				ctx.ui.notify("Status cleared", "info");
			} else {
				currentStatus = text;
				pi.appendEntry(CUSTOM_TYPE, { text });
				ctx.ui.notify(`Status: ${text}`, "info");
			}

			updateStatus(ctx);
		},
	});
}
