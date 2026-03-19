/**
 * Capture logic for capturing conversation and repository state
 */

import { existsSync, copyFileSync, mkdirSync, writeFileSync, rmSync, unlinkSync, statSync } from "fs";
import { join, basename } from "path";
import { execFileSync } from "child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { StorageManager } from "./storage.js";
import type { CaptureMetadata } from "./types.js";
import { formatSize } from "./utils.js";

const SESSION_FILE_NAME = ".pi-session.jsonl";
const META_FILE_NAME = ".pi-capture-meta.json";

/**
 * Capture current state to tarball (sync)
 */
export function captureState(
	storage: StorageManager,
	name: string | undefined,
	ctx: ExtensionContext,
): { success: boolean; captureId: string; message: string } {
	const sessionManager = ctx.sessionManager;
	const sessionFile = sessionManager.getSessionFile();
	const cwd = ctx.cwd;

	// Validate not ephemeral
	if (!sessionFile) {
		return {
			success: false,
			captureId: "",
			message: "Cannot capture ephemeral session (no session file). Use persistent sessions with `pi` command.",
		};
	}

	// Check session file exists
	if (!existsSync(sessionFile)) {
		return { success: false, captureId: "", message: `Session file not found: ${sessionFile}` };
	}

	// Check we're in a directory with files
	try {
		const files = storage.getDirectoryStats(cwd);
		if (files.fileCount === 0) {
			return { success: false, captureId: "", message: "Cannot capture empty directory" };
		}
	} catch (error) {
		return { success: false, captureId: "", message: `Error checking directory: ${(error as Error).message}` };
	}

	// Generate capture ID
	const captureId = storage.generateId();

	// Copy session file to captures directory
	const targetSessionPath = storage.getSessionPath(captureId);
	mkdirSync(storage.capturesDir, { recursive: true });

	try {
		copyFileSync(sessionFile, targetSessionPath);

		// Get first user message for display
		const entries = sessionManager.getEntries();
		const firstUserMessage = getFirstUserMessage(entries);

		// Get metadata
		const buildCtx = sessionManager.buildSessionContext();
		const model = buildCtx.model ? { provider: buildCtx.model.provider, id: buildCtx.model.modelId } : undefined;
		const thinkingLevel = buildCtx.thinkingLevel;

		// Get directory stats
		const stats = storage.getDirectoryStats(cwd);

		// Create metadata file
		const metadata: CaptureMetadata = {
			id: captureId,
			name,
			createdAt: new Date().toISOString(),
			originalCwd: cwd,
			sessionFile: SESSION_FILE_NAME,
			tarballPath: storage.getTarballPath(captureId),
			tarballSize: 0, // Will update after tar creation
			fileCount: stats.fileCount,
			totalSize: stats.totalSize,
			firstUserMessage: firstUserMessage || "(no messages)",
			messageCount: entries.length,
			model,
			thinkingLevel,
		};

		// Save metadata to index
		storage.saveCapture(metadata);

		// Create tarball
		const tarballResult = createTarball(cwd, storage, captureId, ctx);

		if (!tarballResult.success) {
			// Rollback
			try {
				storage.deleteCapture(captureId);
			} catch {}
			return {
				success: false,
				captureId: "",
				message: tarballResult.message,
			};
		}

		// Update tarball size in metadata
		metadata.tarballSize = tarballResult.size;
		storage.saveCapture(metadata);

		return {
			success: true,
			captureId,
			message: `Captured "${name || captureId}"\n  Files: ${stats.fileCount}, Size: ${formatSize(stats.totalSize)}\n  Tarball: ${metadata.tarballPath}`,
		};
	} catch (error) {
		// Cleanup partial capture
		try {
			storage.deleteCapture(captureId);
		} catch {}
		return {
			success: false,
			captureId: "",
			message: `Capture failed: ${(error as Error).message}`,
		};
	}
}

/**
 * Create tarball of project directory (sync)
 */
function createTarball(
	cwd: string,
	storage: StorageManager,
	captureId: string,
	ctx: ExtensionContext,
): { success: boolean; size: number; message: string } {
	const tarballPath = storage.getTarballPath(captureId);
	const projectDir = basename(cwd);
	const parentDir = join(cwd, "..");
	const tmpSessionPath = storage.getSessionPath(captureId);
	const tmpMetaPath = join(storage.capturesDir, `${captureId}-meta.json`);
	const tempDir = join(storage.capturesDir, `${captureId}-temp`);
	const CAPTURES_DIR = ".pi-captures";

	// Cleanup function (sync, not async)
	const cleanup = () => {
		try {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		} catch {}
		try {
			if (existsSync(tmpMetaPath)) {
				unlinkSync(tmpMetaPath);
			}
		} catch {}
	};

	try {
		// Write metadata file to be included in tarball
		const metadata = storage.getCapture(captureId);
		if (metadata) {
			writeFileSync(tmpMetaPath, JSON.stringify(metadata, null, 2));
		}

		// Build exclude array for tar
		const excludes = storage.buildTarExcludeArray();

		// Create temp directory
		mkdirSync(tempDir, { recursive: true });

		// Create initial tarball (without session file)
		// Use execFileSync with argument array to avoid shell injection
		const initialExcludes = [...excludes, "--exclude=.pi-captures", `--exclude=${projectDir}/.pi-captures`];
		execFileSync("tar", ["czf", tarballPath, "-C", parentDir, ...initialExcludes, projectDir], {
			stdio: "pipe",
		});

		// Extract tarball
		execFileSync("tar", ["xzf", tarballPath, "-C", tempDir], { stdio: "pipe" });

		// Copy session and meta files into the project directory within temp
		const projectInTemp = join(tempDir, projectDir);
		copyFileSync(tmpSessionPath, join(projectInTemp, SESSION_FILE_NAME));
		if (metadata) {
			copyFileSync(tmpMetaPath, join(projectInTemp, META_FILE_NAME));
		}

		// Recreate tarball with session file included
		execFileSync("tar", ["czf", tarballPath, "-C", tempDir, ...excludes, projectDir], {
			stdio: "pipe",
		});

		// Get tarball size
		const actualSize = statSync(tarballPath).size;

		// Cleanup temp directory and files
		cleanup();

		// Check if tarball is large and warn
		if (actualSize > 100 * 1024 * 1024) {
			ctx.ui?.notify(`Large capture: ${formatSize(actualSize)} - consider excluding more files`, "warning");
		}

		return { success: true, size: actualSize, message: "Tarball created" };
	} catch (error) {
		// Cleanup on error
		cleanup();

		return {
			success: false,
			size: 0,
			message: `Tarball creation failed: ${(error as Error).message}`,
		};
	}
}

/**
 * Get first user message from entries
 */
function getFirstUserMessage(entries: any[]): string {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			const content = entry.message.content;
			if (typeof content === "string") {
				return content.slice(0, 100);
			}
			if (Array.isArray(content)) {
				const text = content.find((c) => c.type === "text");
				if (text) {
					return text.text.slice(0, 100);
				}
			}
		}
	}
	return "";
}