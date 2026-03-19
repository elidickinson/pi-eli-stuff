/**
 * Capture/Replay Extension for Pi
 *
 * Capture the complete state of a conversation (session + repo state) for replay
 * with different models/providers/settings.
 *
 * Features:
 * - /capture [name]       - Capture current state as tarball
 * - /list-captures        - List all captures
 * - /replay <id>          - Replay capture to a new empty directory
 * - /replay <id> --session-only  - Replay only session (no repo)
 * - /delete-capture <id>  - Delete a capture
 *
 * Safety: Replay only works in empty directories to prevent file clobbering.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { StorageManager } from "./storage.js";
import { captureState } from "./capture.js";
import { replayCapture, promptForReplayDir } from "./replay.js";
import { StorageManager as StorageManagerClass } from "./storage.js";
import { formatSize } from "./utils.js";

export default function (pi: ExtensionAPI) {
	// We need to create StorageManager with cwd, but we only get ctx in handlers
	// So we'll create it lazily

	/**
	 * Get or create StorageManager
	 */
	function getStorageManager(cwd: string): StorageManagerClass {
		return new StorageManagerClass(cwd);
	}

	/**
	 * Capture current state
	 */
	pi.registerCommand("capture", {
		description: "Capture current session and repo state as tarball",
		handler: async (args, ctx) => {
			const storage = getStorageManager(ctx.cwd);

			// Parse name if provided
			const name = args.trim() || undefined;

			ctx.ui?.notify("Capturing...", "info");

			const result = await captureState(storage, name, ctx);

			if (result.success) {
				ctx.ui?.notify(result.message, "success");
			} else {
				ctx.ui?.notify(result.message, "error");
			}
		},
	});

	/**
	 * List all captures
	 */
	pi.registerCommand("list-captures", {
		description: "List all captures with preview",
		handler: async (_args, ctx) => {
			const storage = getStorageManager(ctx.cwd);
			const index = storage.getIndex();

			if (index.captures.length === 0) {
				ctx.ui?.notify("No captures found. Use /capture to create one.", "info");
				return;
			}

			// Sort by date (newest first)
			const sorted = [...index.captures].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

			const lines = [`\n📦 Captures (${sorted.length})`, ""];
			const items: string[] = [];

			for (const capture of sorted) {
				const statusStr = storage.captureExists(capture.id) ? "✓" : "✗";
				const nameStr = capture.name ? `${capture.name} (${capture.id})` : capture.id;
				const dateStr = new Date(capture.createdAt).toLocaleString();
				const sizeStr = formatSize(capture.tarballSize);
				const filesStr = `${capture.fileCount} files`;
				const modelStr = capture.model ? `${capture.model.provider}/${capture.model.id}` : "none";

				items.push(`${statusStr} ${nameStr}`);
				items.push(`    ${dateStr} | ${capture.messageCount} msgs | ${filesStr} | ${sizeStr} | ${modelStr}`);
				items.push(`    "${capture.firstUserMessage}"`);
				items.push("");
			}

			if (ctx.hasUI) {
				const message = lines.join("\n") + items.join("\n");
				// Use notify for short, text editor for long
				if (message.length < 2000) {
					ctx.ui.notify(message, "info");
				} else {
					const edited = await ctx.ui.editor("Captures", message);
					if (!edited) {
						ctx.ui.notify("Listing cancelled", "info");
					}
				}
			} else {
				console.log(lines.join("\n") + items.join("\n"));
			}
		},
	});

	/**
	 * Replay a capture
	 */
	pi.registerCommand("replay", {
		description: "Replay capture to a new empty directory",
		handler: async (args, ctx) => {
			const storage = getStorageManager(ctx.cwd);
			const argsStr = args.trim();

			if (!argsStr) {
				ctx.ui?.notify("Usage: /replay <capture-id> [--session-only]", "error");
				return;
			}

			const parts = argsStr.split(/\s+/);
			const captureId = parts[0];
			const sessionOnly = parts.includes("--session-only");

			// Validate capture exists
			const capture = storage.getCapture(captureId);
			if (!capture) {
				ctx.ui?.notify(`Capture not found: ${captureId}`, "error");
				return;
			}

			// Show capture overview
			const overview = `Capture: ${capture.name || capture.id}\n  Date: ${new Date(capture.createdAt).toLocaleString()}\n  Original dir: ${capture.originalCwd}\n  Files: ${capture.fileCount} (${formatSize(capture.totalSize)})\n  Messages: ${capture.messageCount}\n  Model: ${capture.model ? `${capture.model.provider}/${capture.model.id}` : "none"}\n  Tarball: ${formatSize(capture.tarballSize)}`;

			if (ctx.hasUI) {
				ctx.ui?.notify(overview.replace(/\n/g, " | "), "info");
			}

			// Get target directory
			let targetDir: string;
			if (ctx.hasUI) {
				const dirResult = await promptForReplayDir(ctx);
				if (dirResult.cancelled || !dirResult.path) {
					ctx.ui?.notify("Replay cancelled", "info");
					return;
				}
				targetDir = dirResult.path;
			} else {
				targetDir = `/tmp/pi-replay-${captureId}-${Date.now()}`;
			}

			// Validate directory is empty
			const pathCheck = storage.isDirectoryEmpty(targetDir);
			if (!pathCheck.empty) {
				ctx.ui?.notify(`Directory must be empty: ${targetDir}`, "error");
				return;
			}

			// Perform replay
			ctx.ui?.notify(`Replaying to: ${targetDir}...`, "info");
			const result = await replayCapture(storage, { targetDir, captureId, sessionOnly }, ctx);

			if (result.success) {
				ctx.ui?.notify(result.message, "success");
			} else {
				ctx.ui?.notify(result.message, "error");
			}
		},
	});

	/**
	 * Delete a capture
	 */
	pi.registerCommand("delete-capture", {
		description: "Delete a capture",
		handler: async (args, ctx) => {
			const storage = getStorageManager(ctx.cwd);
			const captureId = args.trim();

			if (!captureId) {
				ctx.ui?.notify("Usage: /delete-capture <capture-id>", "error");
				return;
			}

			const capture = storage.getCapture(captureId);
			if (!capture) {
				ctx.ui?.notify(`Capture not found: ${captureId}`, "error");
				return;
			}

			// Confirm deletion in interactive mode
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm("Delete capture?", `Delete "${capture.name || capture.id}"?`);
				if (!confirmed) {
					ctx.ui?.notify("Deletion cancelled", "info");
					return;
				}
			}

			storage.deleteCapture(captureId);
			ctx.ui?.notify(`Deleted: ${capture.name || captureId}`, "success");
		},
	});
}