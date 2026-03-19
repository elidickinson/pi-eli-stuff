/**
 * Replay logic for restoring captured state
 */

import { existsSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { join, resolve, basename } from "path";
import { execFileSync } from "child_process";
import type { ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { StorageManager } from "./storage.js";
import type { ReplayOptions, CaptureMetadata } from "./types.js";

const SESSION_FILE_NAME = ".pi-session.jsonl";
const META_FILE_NAME = ".pi-capture-meta.json";

/**
 * Replay a capture to a specified directory
 */
export async function replayCapture(
	storage: StorageManager,
	options: ReplayOptions,
	ctx: ExtensionCommandContext,
): Promise<{ success: boolean; message: string; sessionPath?: string }> {
	const { targetDir, captureId, sessionOnly } = options;

	// Validate capture exists
	if (!storage.captureExists(captureId)) {
		return {
			success: false,
			message: `Capture not found: ${captureId}\nUse /list-captures to see available captures`,
		};
	}

	// Validate target directory
	const pathCheck = storage.isDirectoryEmpty(targetDir);
	if (!pathCheck.empty) {
		return {
			success: false,
			message: `Target directory must be empty or new: ${targetDir}`,
		};
	}

	// Get capture metadata
	const metadata = storage.getCapture(captureId);
	if (!metadata) {
		return { success: false, message: `Capture metadata not found: ${captureId}` };
	}

	try {
		// Create target directory if it doesn't exist
		if (!pathCheck.pathExists) {
			mkdirSync(targetDir, { recursive: true });
		}

		if (sessionOnly) {
			// Skip repo restore, just copy session file
			const sessionPath = storage.getSessionPath(captureId);
			if (!existsSync(sessionPath)) {
				return { success: false, message: `Session file not found: ${sessionPath}` };
			}

			const targetSessionPath = join(targetDir, SESSION_FILE_NAME);

			try {
				// Use copyFileSync instead of shell command (avoids shell injection)
				copyFileSync(sessionPath, targetSessionPath);

				return {
					success: true,
					message: `Session-only replay: ${SESSION_FILE_NAME} copied to ${targetDir}\nRun: pi --session ${SESSION_FILE_NAME}`,
					sessionPath: targetSessionPath,
				};
			} catch (error) {
				return {
					success: false,
					message: `Failed to copy session file: ${(error as Error).message}`,
				};
			}
		} else {
			// Full replay: extract tarball
			const tarballPath = storage.getTarballPath(captureId);
			if (!existsSync(tarballPath)) {
				return { success: false, message: `Tarball not found: ${tarballPath}` };
			}

			// Extract tarball using execFileSync (avoids shell injection)
			try {
				execFileSync("tar", ["xzf", tarballPath, "-C", targetDir], { stdio: "pipe" });

				// The tarball contains a "project/" directory (the basename of the original cwd)
				// The session file should be inside that directory
				const projectDir = join(targetDir, basename(metadata.originalCwd));
				const sessionInProject = join(projectDir, SESSION_FILE_NAME);

				if (!existsSync(sessionInProject)) {
					return {
						success: false,
						message: `Session file not found in extracted tarball at ${sessionInProject}`,
					};
				}

				// Copy session file to root of target dir for easy access
				const rootSessionPath = join(targetDir, SESSION_FILE_NAME);
				try {
					copyFileSync(sessionInProject, rootSessionPath);
				} catch {
					// If copy fails, use the path inside project
				}

				return {
					success: true,
					message: `Replay complete:\n  Project extracted to: ${projectDir}\n  Session: ${SESSION_FILE_NAME}\n\nRun: cd ${projectDir} && pi --session ${SESSION_FILE_NAME}`,
					sessionPath: sessionInProject,
				};
			} catch (error) {
				// Cleanup on extraction failure - use sync rmSync
				try {
					rmSync(targetDir, { recursive: true, force: true });
				} catch {}

				return {
					success: false,
					message: `Tarball extraction failed: ${(error as Error).message}`,
				};
			}
		}
	} catch (error) {
		return {
			success: false,
			message: `Replay failed: ${(error as Error).message}`,
		};
	}
}

/**
 * Prompt user for replay directory
 */
export async function promptForReplayDir(ctx: ExtensionCommandContext): Promise<{ cancelled: boolean; path?: string }> {
	if (!ctx.hasUI) {
		return {
			cancelled: false,
			path: process.env.HOME ? `${process.env.HOME}/pi-replay-${Date.now()}` : `/tmp/pi-replay-${Date.now()}`,
		};
	}

	const path = await ctx.ui.input("Enter path for replay (must be empty or new directory):", "/tmp/pi-replay-");

	if (!path) {
		return { cancelled: true };
	}

	const resolvedPath = resolve(path.trim());
	return { cancelled: false, path: resolvedPath };
}

/**
 * Show capture info before replaying
 */
export async function showCapturePreview(captureId: string, ctx: ExtensionCommandContext): Promise<boolean> {
	// This would be shown before prompting for directory
	// Return true to proceed, false to cancel
	return true;
}