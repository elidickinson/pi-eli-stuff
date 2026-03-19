/**
 * Storage operations for tarball creation and index management
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import type { CaptureIndex, CaptureMetadata, TarballStats } from "./types.js";

const CAPTURES_DIR = ".pi-captures";
const INDEX_FILE = "index.json";
const SESSION_FILE_NAME = ".pi-session.jsonl";
const META_FILE_NAME = ".pi-capture-meta.json";

export class StorageManager {
	private capturesDirInternal: string;
	private indexPath: string;

	constructor(private cwd: string) {
		this.capturesDirInternal = join(this.cwd, CAPTURES_DIR);
		this.indexPath = join(this.capturesDirInternal, INDEX_FILE);
		this.ensureCapturesDir();
	}

	private ensureCapturesDir(): void {
		if (!existsSync(this.capturesDirInternal)) {
			mkdirSync(this.capturesDirInternal, { recursive: true });
		}
	}

	/**
	 * Get the captures directory path
	 */
	get capturesDir() {
		return this.capturesDirInternal;
	}

	/**
	 * Get all captures from index
	 */
	getIndex(): CaptureIndex {
		if (!existsSync(this.indexPath)) {
			return { version: 1, captures: [] };
		}
		try {
			const content = readFileSync(this.indexPath, "utf8");
			return JSON.parse(content) as CaptureIndex;
		} catch {
			return { version: 1, captures: [] };
		}
	}

	/**
	 * Save capture to index
	 */
	saveCapture(metadata: CaptureMetadata): void {
		const index = this.getIndex();
		const existingIndex = index.captures.findIndex((c) => c.id === metadata.id);

		if (existingIndex >= 0) {
			index.captures[existingIndex] = metadata;
		} else {
			index.captures.push(metadata);
		}

		this.writeIndex(index);
	}

	/**
	 * Remove capture from index
	 */
	deleteCapture(id: string): void {
		const index = this.getIndex();
		index.captures = index.captures.filter((c) => c.id !== id);
		this.writeIndex(index);

		// Delete tarball and session file
		const tarballPath = join(this.capturesDir, `${id}.tar.gz`);
		const sessionPath = join(this.capturesDir, `${id}.jsonl`);

		if (existsSync(tarballPath)) {
			unlinkSync(tarballPath);
		}
		if (existsSync(sessionPath)) {
			unlinkSync(sessionPath);
		}
	}

	/**
	 * Get capture metadata by ID
	 */
	getCapture(id: string): CaptureMetadata | undefined {
		const index = this.getIndex();
		return index.captures.find((c) => c.id === id);
	}

	/**
	 * Generate unique capture ID
	 */
	generateId(): string {
		return `capt-${randomUUID().slice(0, 8)}`;
	}

	/**
	 * Get path for tarball
	 */
	getTarballPath(id: string): string {
		return join(this.capturesDir, `${id}.tar.gz`);
	}

	/**
	 * Get path for session file
	 */
	getSessionPath(id: string): string {
		return join(this.capturesDir, `${id}.jsonl`);
	}

	/**
	 * Check if capture exists
	 */
	captureExists(id: string): boolean {
		return existsSync(this.getTarballPath(id)) && existsSync(this.getSessionPath(id));
	}

	/**
	 * Get statistics about a directory for display (synchronous)
	 */
	getDirectoryStats(dir: string): TarballStats {
		let fileCount = 0;
		let totalSize = 0;

		const traverse = (currentDir: string): void => {
			const entries = readdirSync(currentDir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(currentDir, entry.name);

				if (entry.isDirectory()) {
					// Skip .git and .pi-captures
					if (entry.name === ".git" || entry.name === ".pi-captures") {
						continue;
					}
					traverse(fullPath);
				} else {
					const stats = statSync(fullPath);
					totalSize += stats.size;
					fileCount++;
				}
			}
		};

		traverse(resolve(dir));
		return { fileCount, totalSize };
	}

	/**
	 * Check if a directory is empty or doesn't exist
	 */
	isDirectoryEmpty(dir: string): { empty: boolean; pathExists: boolean } {
		if (!existsSync(dir)) {
			return { empty: true, pathExists: false };
		}

		try {
			const entries = readdirSync(dir);
			// Only ignore OS metadata files - don't filter out all dotfiles!
			const ignorable = new Set([".DS_Store", ".Thumbs.db", ".Trashes"]);
			const meaningful = entries.filter((e) => !ignorable.has(e));

			return { empty: meaningful.length === 0, pathExists: true };
		} catch {
			return { empty: false, pathExists: true };
		}
	}

	/**
	 * Write index data atomically
	 */
	private writeIndex(index: CaptureIndex): void {
		const tmpPath = `${this.indexPath}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(index, null, 2));
		renameSync(tmpPath, this.indexPath); // Atomic on POSIX
	}

	/**
	 * Get git ignore patterns
	 */
	getGitIgnorePatterns(): string[] {
		const patterns = [".git", ".pi-captures*", ".env", "*.log", "node_modules", ".DS_Store"];

		// Try to read .gitignore if it exists
		const gitignorePath = join(this.cwd, ".gitignore");
		if (existsSync(gitignorePath)) {
			const content = readFileSync(gitignorePath, "utf8");
			const lines = content
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !l.startsWith("#"));

			patterns.push(...Array.from(lines));
		}

		return Array.from(new Set(patterns)); // Deduplicate
	}

	/**
	 * Build exclude array for tar (as argument array for execFileSync)
	 */
	buildTarExcludeArray(): string[] {
		const patterns = this.getGitIgnorePatterns();
		return patterns.flatMap((p) => ["--exclude", p]);
	}
}