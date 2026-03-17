import type { LlmCallRow } from "./state-machine.js";

export interface ModelStats {
	provider: string;
	model: string;
	calls: number;
	aborts: number;
	inputTokP50: number | null;
	ttftP50: number | null;
	durationP50: number | null;
	tokPerSec: number | null;
	totalCost: number;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.floor(sorted.length * p);
	return sorted[Math.min(idx, sorted.length - 1)];
}

export function computeModelStats(rows: LlmCallRow[]): ModelStats[] {
	const byModel = new Map<string, LlmCallRow[]>();
	for (const row of rows) {
		const key = `${row.provider}/${row.model}`;
		const list = byModel.get(key) || [];
		list.push(row);
		byModel.set(key, list);
	}

	const stats: ModelStats[] = [];
	for (const [key, modelRows] of byModel) {
		const [provider, ...modelParts] = key.split("/");
		const model = modelParts.join("/");

		const completed = modelRows.filter((r) => r.stop_reason !== "aborted" && r.stop_reason !== "error");
		const aborts = modelRows.length - completed.length;

		// Total input context = input_tokens + cache_read + cache_write.
		// Providers split these differently: some report the full context in input_tokens,
		// others (e.g. MiniMax) report only non-cached tokens there (often single digits)
		// with the bulk in cache_read/cache_write. Summing all three gives the true context size.
		const inputToks = completed
			.map((r) => {
				const t = (r.input_tokens ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
				return t > 0 ? t : null;
			})
			.filter((v): v is number => v != null)
			.sort((a, b) => a - b);
		const ttfts = completed.map((r) => r.ttft_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
		const durations = completed.map((r) => r.duration_ms).filter((v): v is number => v != null).sort((a, b) => a - b);

		const tokPerSecValues = completed
			.filter((r) => r.output_tokens != null && r.duration_ms != null && r.duration_ms > 0)
			.map((r) => r.output_tokens! / (r.duration_ms! / 1000))
			.sort((a, b) => a - b);

		stats.push({
			provider,
			model,
			calls: completed.length,
			aborts,
			inputTokP50: inputToks.length > 0 ? percentile(inputToks, 0.5) : null,
			ttftP50: ttfts.length > 0 ? percentile(ttfts, 0.5) : null,
			durationP50: durations.length > 0 ? percentile(durations, 0.5) : null,
			tokPerSec: tokPerSecValues.length > 0 ? percentile(tokPerSecValues, 0.5) : null,
			totalCost: modelRows.reduce((sum, r) => sum + (r.cost_total ?? 0), 0),
		});
	}

	return stats.sort((a, b) => b.calls - a.calls);
}

export interface AggregateStats {
	ttftP50: number | null;
	tokPerSecP50: number | null;
}

export function computeAggregateStats(rows: LlmCallRow[]): AggregateStats {
	const completed = rows.filter((r) => r.stop_reason !== "aborted" && r.stop_reason !== "error");
	const ttfts = completed.map((r) => r.ttft_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
	const tokPerSecValues = completed
		.filter((r) => r.output_tokens != null && r.duration_ms != null && r.duration_ms > 0)
		.map((r) => r.output_tokens! / (r.duration_ms! / 1000))
		.sort((a, b) => a - b);

	return {
		ttftP50: ttfts.length > 0 ? percentile(ttfts, 0.5) : null,
		tokPerSecP50: tokPerSecValues.length > 0 ? percentile(tokPerSecValues, 0.5) : null,
	};
}

// ── Report formatting ──

export interface TimeRangeStats {
	label: string;
	sinceMs: number;
	stats: ModelStats[];
}

function formatTokK(v: number | null): string {
	if (v == null) return " —";
	if (v < 1000) return String(Math.round(v));
	return `${(v / 1000).toFixed(0)}k`;
}

export function formatMs(ms: number | null): string {
	if (ms == null) return "  —";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokS(v: number | null): string {
	if (v == null) return " —";
	return v.toFixed(0);
}

function formatCost(v: number): string {
	if (v === 0) return " —";
	if (v < 0.01) return `$${v.toFixed(3)}`;
	return `$${v.toFixed(2)}`;
}

function truncModel(provider: string, model: string, maxLen: number): string {
	const full = `${provider}/${model}`;
	return full.length > maxLen ? full.substring(0, maxLen - 1) + "…" : full;
}

// Horizontal layout: three time ranges side by side
export function formatReportHorizontal(ranges: TimeRangeStats[], theme: any): string {
	if (ranges.every((r) => r.stats.length === 0)) {
		return theme.fg("dim", "No LLM calls recorded");
	}

	// Get all unique model keys across all ranges
	const allModels = new Map<string, { provider: string; model: string }>();
	for (const r of ranges) {
		for (const s of r.stats) {
			const key = `${s.provider}/${s.model}`;
			if (!allModels.has(key)) {
				allModels.set(key, { provider: s.provider, model: s.model });
			}
		}
	}

	// Sort models by total calls across all ranges
	const sortedModels = Array.from(allModels.entries()).sort((a, b) => {
		const aCalls = ranges.reduce((sum, r) => sum + (r.stats.find((s) => `${s.provider}/${s.model}` === a[0])?.calls ?? 0), 0);
		const bCalls = ranges.reduce((sum, r) => sum + (r.stats.find((s) => `${s.provider}/${s.model}` === b[0])?.calls ?? 0), 0);
		return bCalls - aCalls;
	});

	// Column structure:
	// Model (24 chars) | Section (24 chars) | Section (24 chars) | Section (24 chars)
	// Section: space + "Last Hour" (9) + space + Calls + space + TTFT + space + Dur
	// Or just: space + "Last Hour" (9) + space + "Calls  TTFT   Dur"
	const modelW = 24;
	const colW = 5;

	// Build output
	const lines: string[] = [];

	// Title
	lines.push("LLM Performance");

	// Column header - defines the structure
	const groupSep = "  │ ";
	let headerLine = "Model".padEnd(modelW);
	for (const range of ranges) {
		headerLine += " " + "Calls".padEnd(colW) + " " + "Abrt".padEnd(colW) + " " + "InTok".padEnd(colW) + "  " + "TTFT".padEnd(colW) + " " + "Tok/s".padEnd(colW);
		if (range !== ranges[ranges.length - 1]) {
			headerLine += groupSep;
		}
	}

	// Build range label line, aligning each label with its "Calls" column
	let rangeLine = " ".repeat(modelW);
	let searchFrom = modelW;
	for (const range of ranges) {
		const pos = headerLine.indexOf("Calls", searchFrom);
		rangeLine = rangeLine.padEnd(pos) + range.label;
		searchFrom = pos + 10;
	}
	rangeLine = rangeLine.padEnd(headerLine.length);
	lines.push(rangeLine);

	// Separator
	lines.push("─".repeat(headerLine.length));

	// Column header
	lines.push(headerLine);

	// Separator
	lines.push("─".repeat(headerLine.length));

	// Data rows
	for (const [key, { provider, model }] of sortedModels) {
		let row = truncModel(provider, model, modelW).padEnd(modelW);
		for (const range of ranges) {
			const stat = range.stats.find((s) => `${s.provider}/${s.model}` === key);
			row += " " + String(stat?.calls ?? "—").padEnd(colW);
			row += " " + String(stat?.aborts ?? "—").padEnd(colW);
			row += " " + formatTokK(stat?.inputTokP50 ?? null).padEnd(colW);
			row += "  " + formatMs(stat?.ttftP50 ?? null).padEnd(colW);
			row += " " + formatTokS(stat?.tokPerSec ?? null).padEnd(colW);
			if (range !== ranges[ranges.length - 1]) {
				row += groupSep;
			}
		}
		lines.push(row);
	}


	// Apply colors
	let result = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isTitle = i === 0;
		const isRangeHeader = i === 1;
		const isSeparator = line.includes("────");
		const isColumnHeader = i === 3;
		if (isTitle) {
			result += theme.fg("accent", line);
		} else if (isRangeHeader) {
			result += theme.bold(line);
		} else if (isColumnHeader || isSeparator) {
			result += theme.fg("dim", line);
		} else {
			// Data/total rows - dim the │ pipes
			result += line.split("│").join(theme.fg("dim", "│"));
		}
		if (i < lines.length - 1) result += "\n";
	}

	return result;
}