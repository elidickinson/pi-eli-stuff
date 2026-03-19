/**
 * Benchmark Capture Extension
 *
 * Captures conversation state + repo state for replaying with different
 * models/providers/settings.
 *
 * Commands:
 *   /benchmark-capture [description]  - Capture current state
 *   /benchmark-list                   - List captures
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// Benchmarks live next to the src/ dir
const BENCHMARKS_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../benchmarks");

interface CaptureJson {
	description: string;
	timestamp: string;
	git_ref: string;
	cwd: string;
	model?: string;
	thinking_level?: string;
	message_count: number;
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

function gitRef(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function gitDiff(cwd: string): string {
	try {
		return execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function lastUserMessage(entries: any[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message?.role === "user") {
			const content = entry.message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content.find((c: any) => c.type === "text");
				if (text) return text.text;
			}
		}
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("benchmark-capture", {
		description: "Capture session + repo state for benchmark replay",
		async handler(args, ctx) {
			const description = args?.trim();
			if (!description) {
				ctx.ui.notify("Usage: /benchmark-capture <description>", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot capture ephemeral session", "error");
				return;
			}

			// Build slug, dedup if needed
			let slug = slugify(description);
			let captureDir = join(BENCHMARKS_DIR, slug);
			if (existsSync(captureDir)) {
				const ts = Date.now().toString(36);
				slug = `${slug}-${ts}`;
				captureDir = join(BENCHMARKS_DIR, slug);
			}
			mkdirSync(captureDir, { recursive: true });

			const cwd = ctx.cwd;
			const entries = ctx.sessionManager.getEntries();

			// prompt.md — last user message
			const prompt = lastUserMessage(entries);
			writeFileSync(join(captureDir, "prompt.md"), prompt + "\n");

			// context.jsonl — full session history
			copyFileSync(sessionFile, join(captureDir, "context.jsonl"));

			// repo.patch — uncommitted changes
			const patch = gitDiff(cwd);
			if (patch) {
				writeFileSync(join(captureDir, "repo.patch"), patch + "\n");
			}

			// capture.json — metadata
			const model = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;

			const meta: CaptureJson = {
				description,
				timestamp: new Date().toISOString(),
				git_ref: gitRef(cwd),
				cwd,
				model,
				thinking_level: pi.getThinkingLevel(),
				message_count: entries.length,
			};
			writeFileSync(join(captureDir, "capture.json"), JSON.stringify(meta, null, 2) + "\n");

			ctx.ui.notify(`Captured: ${slug}\n  ${captureDir}`, "info");
		},
	});

	pi.registerCommand("benchmark-list", {
		description: "List benchmark captures",
		async handler(_args, ctx) {
			if (!existsSync(BENCHMARKS_DIR)) {
				ctx.ui.notify("No benchmarks directory found", "info");
				return;
			}

			const dirs = readdirSync(BENCHMARKS_DIR, { withFileTypes: true })
				.filter(d => d.isDirectory())
				.map(d => d.name)
				.sort();

			if (dirs.length === 0) {
				ctx.ui.notify("No captures found", "info");
				return;
			}

			const lines: string[] = [];
			for (const dir of dirs) {
				const metaPath = join(BENCHMARKS_DIR, dir, "capture.json");
				if (!existsSync(metaPath)) continue;
				try {
					const meta: CaptureJson = JSON.parse(readFileSync(metaPath, "utf8"));
					const date = new Date(meta.timestamp).toLocaleDateString();
					const ref = meta.git_ref.slice(0, 8);
					const hasPatch = existsSync(join(BENCHMARKS_DIR, dir, "repo.patch"));
					lines.push(`${dir}  ${date}  ${ref}${hasPatch ? "+patch" : ""}  ${meta.model || "?"}`);
				} catch {
					lines.push(`${dir}  (invalid capture.json)`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
