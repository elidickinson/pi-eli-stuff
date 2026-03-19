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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";
import { randomUUID } from "node:crypto";
import { handleTurnStart, handleMessageStart, handleMessageUpdate, handleMessageEnd, type PendingCall } from "./state-machine.js";
import { getDbPath, openDb, insertCall, queryCalls, purgeBefore, getDistinctModels } from "./db.js";
import { computeModelStats, computeAggregateStats, formatMs, formatTokS, formatReportHorizontal, type TimeRangeStats } from "./stats.js";
import type Database from "better-sqlite3";

const DEBUG = process.env.LLM_PERF_DEBUG === "1";

function debug(...args: unknown[]) {
	if (DEBUG) console.warn("[llm-perf]", ...args);
}

// ── Argument parsing ──

const MIN15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

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
	let sinceMs = Date.now() - DAY;
	let modelFilter: string | undefined;

	if (parts[0] === "purge" && parts[1]) {
		const dur = parseDuration(parts[1]);
		if (dur) return { timeLabel: "", sinceMs: 0, purge: dur };
	}

	for (const p of parts) {
		if (p === "all") {
			timeLabel = "all time";
			sinceMs = 0;
		} else {
			const dur = parseDuration(p);
			if (dur) {
				timeLabel = `last ${p}`;
				sinceMs = Date.now() - dur;
			} else {
				modelFilter = p;
			}
		}
	}

	return { timeLabel, sinceMs, modelFilter };
}

// ── Extension ──

const WIDGET_KEY = "llm-perf-report";

export default function (pi: ExtensionAPI) {
	const sessionId = randomUUID();
	let pending: PendingCall | null = null;
	let db: Database.Database | null = null;
	let currentModelFilter: string | undefined;

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

	function updateStatusBar(d: Database.Database, ctx: { ui: { setStatus(key: string, text: string | undefined): void; theme: any } }, now: number) {
		try {
			const rows = queryCalls(d, { sinceMs: now - MIN15, modelFilter: currentModelFilter });
			const agg = computeAggregateStats(rows);
			if (agg.ttftP50 == null && agg.tokPerSecP50 == null) {
				ctx.ui.setStatus("llm-perf", undefined);
				return;
			}
			const parts: string[] = [];
			if (agg.ttftP50 != null) parts.push(`TTFT ${formatMs(agg.ttftP50)}`);
			if (agg.tokPerSecP50 != null) parts.push(`${formatTokS(agg.tokPerSecP50)} tok/s`);
			ctx.ui.setStatus("llm-perf", ctx.ui.theme.fg("dim", parts.join("  ")));
		} catch (e) {
			debug("status bar update failed:", e);
		}
	}

	// ── Event handlers ──

	pi.on("input", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return { action: "continue" as const };
	});

	pi.on("turn_start", (event, ctx) => {
		if (!currentModelFilter) currentModelFilter = ctx.model?.id;
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

	pi.on("model_select", (event, ctx) => {
		currentModelFilter = event.model.id;
		debug(`model_select model=${event.model.id}`);
		const d = getDb();
		if (d) updateStatusBar(d, ctx, Date.now());
	});

	pi.on("message_update", (event) => {
		const evtType = event.assistantMessageEvent.type;
		pending = handleMessageUpdate(pending, evtType, Date.now());
	});

	pi.on("message_end", (event, ctx) => {
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
				updateStatusBar(d, ctx, now);
			}
		}
	});

	// ── Command ──

	pi.registerCommand("llm-perf", {
		description: "Show LLM performance stats. Usage: /llm-perf [model-filter] [Xh|Xd|Xm|all] | purge <duration>",
		getArgumentCompletions(prefix) {
			if (!prefix) return [];
			const items = ["all", "purge"];
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

			const now = Date.now();
			const defaultRanges = [
				{ label: "Last Hour", sinceMs: now - HOUR },
				{ label: "Last 24h", sinceMs: now - DAY },
				{ label: "Last Week", sinceMs: now - WEEK },
			];
			// Custom time range (e.g. /llm-perf month) → single group; otherwise show all 3
			const hasTimeArg = parsed.timeLabel !== "last 24h";
			const timeRanges = hasTimeArg
				? [{ label: parsed.timeLabel, sinceMs: parsed.sinceMs }]
				: defaultRanges;
			const ranges: TimeRangeStats[] = timeRanges.map(({ label, sinceMs }) => {
				const rows = queryCalls(d, { sinceMs, modelFilter: parsed.modelFilter });
				const stats = computeModelStats(rows);
				return { label, sinceMs, stats };
			});

			const report = formatReportHorizontal(ranges, ctx.ui.theme);
			ctx.ui.setWidget(WIDGET_KEY, () => {
				const container = new Container();
				for (const line of report.split("\n")) {
					container.addChild(new Text(line, 0, 0));
				}
				return container;
			});
		},
	});
}
