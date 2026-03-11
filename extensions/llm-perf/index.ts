/**
 * LLM Performance Tracking Extension
 *
 * Passively tracks LLM responsiveness metrics (latency, TTFT, throughput, cost)
 * as you work. Data stored in SQLite for querying via /llm-perf command.
 *
 * Commands:
 *   /llm-perf [time] [filter]  - Show performance stats
 *   /llm-perf purge <duration> - Delete old entries
 *
 * Debug: LLM_PERF_DEBUG=1 enables verbose logging to stderr.
 */

import type { ExtensionAPI, MessageUpdateEvent } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { randomUUID } from "node:crypto";
import { handleTurnStart, handleMessageStart, handleMessageUpdate, handleMessageEnd, type PendingCall } from "./state-machine.js";
import { getDbPath, openDb, insertCall, queryCalls, purgeBefore, getDistinctModels } from "./db.js";
import { computeModelStats, formatReport } from "./stats.js";
import type Database from "better-sqlite3";

const DEBUG = process.env.LLM_PERF_DEBUG === "1";

function debug(...args: unknown[]) {
	if (DEBUG) console.warn("[llm-perf]", ...args);
}

// ── Argument parsing ──

const TIME_RANGES: Record<string, number> = {
	"24h": 24 * 60 * 60 * 1000,
	"week": 7 * 24 * 60 * 60 * 1000,
	"month": 30 * 24 * 60 * 60 * 1000,
};

function parseDuration(s: string): number | null {
	const m = s.match(/^(\d+)([dhm])$/);
	if (!m) return null;
	const n = parseInt(m[1]);
	switch (m[2]) {
		case "d": return n * 24 * 60 * 60 * 1000;
		case "h": return n * 60 * 60 * 1000;
		case "m": return n * 60 * 1000;
		default: return null;
	}
}

interface ParsedArgs {
	timeLabel: string;
	sinceMs: number;
	modelFilter?: string;
	purge?: number;
}

function parseArgs(raw: string): ParsedArgs {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	let timeLabel = "last 24h";
	let sinceMs = Date.now() - TIME_RANGES["24h"];
	let modelFilter: string | undefined;

	if (parts[0] === "purge" && parts[1]) {
		const dur = parseDuration(parts[1]);
		if (dur) return { timeLabel: "", sinceMs: 0, purge: dur };
	}

	for (const p of parts) {
		if (p === "all") {
			timeLabel = "all time";
			sinceMs = 0;
		} else if (TIME_RANGES[p]) {
			timeLabel = `last ${p}`;
			sinceMs = Date.now() - TIME_RANGES[p];
		} else {
			modelFilter = p;
		}
	}

	return { timeLabel, sinceMs, modelFilter };
}

// ── Extension ──

const MSG_TYPE = "llm-perf-report";

export default function (pi: ExtensionAPI) {
	const sessionId = randomUUID();
	let pending: PendingCall | null = null;
	let db: Database.Database | null = null;

	function getDb(): Database.Database | null {
		if (db) return db;
		try {
			db = openDb(getDbPath());
			debug("DB opened:", getDbPath());
			return db;
		} catch (e) {
			console.warn("[llm-perf] ERROR: DB open failed:", e);
			return null;
		}
	}

	// ── Event handlers ──

	pi.on("turn_start", (event, ctx) => {
		const usage = ctx.getContextUsage();
		pending = handleTurnStart(
			pending,
			event.turnIndex,
			event.timestamp,
			usage?.tokens ?? null,
			usage?.contextWindow ?? 0,
		);
		debug(`turn_start turnIndex=${event.turnIndex} timestamp=${event.timestamp}`);
	});

	pi.on("message_start", (event) => {
		const msg = event.message as Partial<AssistantMessage>;
		if (msg.role !== "assistant") return;
		pending = handleMessageStart(pending, msg);
		debug(`message_start provider=${msg.provider} model=${msg.model}`);
	});

	pi.on("message_update", (event: MessageUpdateEvent) => {
		const evtType = event.assistantMessageEvent.type;
		pending = handleMessageUpdate(pending, evtType, Date.now());
	});

	pi.on("message_end", (event) => {
		const msg = event.message as Partial<AssistantMessage>;
		const now = Date.now();
		const result = handleMessageEnd(pending, msg, sessionId, now);
		pending = result.pending;

		if (result.row) {
			const d = getDb();
			if (d) {
				try {
					const id = insertCall(d, result.row);
					debug(
						`INSERT id=${id} provider=${result.row.provider} model=${result.row.model}` +
						` ttft=${result.row.ttft_ms != null ? Math.round(result.row.ttft_ms) + "ms" : "null"}` +
						` dur=${result.row.duration_ms != null ? Math.round(result.row.duration_ms) + "ms" : "null"}`,
					);
				} catch (e) {
					console.warn("[llm-perf] ERROR: DB write failed:", e);
				}
			}
		}
	});

	// ── Message renderer ──

	pi.registerMessageRenderer(MSG_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : message.content[0]?.text || "";
		return new Text(content, 0, 0);
	});

	// ── Command ──

	pi.registerCommand("llm-perf", {
		description: "Show LLM performance stats. Usage: /llm-perf [24h|week|month|all] [model-filter] | purge <duration>",
		getArgumentCompletions(prefix) {
			const items = ["week", "month", "all", "purge"];
			const d = getDb();
			if (d) {
				try {
					items.push(...getDistinctModels(d));
				} catch { /* ignore */ }
			}
			return items
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ label: s, value: s }));
		},
		async handler(args, ctx) {
			const parsed = parseArgs(args);

			if (parsed.purge != null) {
				const d = getDb();
				if (!d) { ctx.ui.notify("DB not available", "error"); return; }
				const cutoff = Date.now() - parsed.purge;
				const deleted = purgeBefore(d, cutoff);
				ctx.ui.notify(`Purged ${deleted} entries`, "info");
				return;
			}

			const d = getDb();
			if (!d) { ctx.ui.notify("DB not available", "error"); return; }

			const rows = queryCalls(d, { sinceMs: parsed.sinceMs, modelFilter: parsed.modelFilter });
			const stats = computeModelStats(rows);
			const report = formatReport(stats, parsed.timeLabel, ctx.ui.theme);

			pi.sendMessage(
				{ customType: MSG_TYPE, content: report, display: true, details: {} },
				{ triggerTurn: false },
			);
		},
	});
}
