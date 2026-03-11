import type { LlmCallRow } from "./state-machine.js";

export interface ModelStats {
	provider: string;
	model: string;
	calls: number;
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

		const ttfts = modelRows.map((r) => r.ttft_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
		const durations = modelRows.map((r) => r.duration_ms).filter((v): v is number => v != null).sort((a, b) => a - b);

		const tokPerSecValues = modelRows
			.filter((r) => r.output_tokens != null && r.duration_ms != null && r.duration_ms > 0)
			.map((r) => r.output_tokens! / (r.duration_ms! / 1000))
			.sort((a, b) => a - b);

		stats.push({
			provider,
			model,
			calls: modelRows.length,
			ttftP50: ttfts.length > 0 ? percentile(ttfts, 0.5) : null,
			durationP50: durations.length > 0 ? percentile(durations, 0.5) : null,
			tokPerSec: tokPerSecValues.length > 0 ? percentile(tokPerSecValues, 0.5) : null,
			totalCost: modelRows.reduce((sum, r) => sum + (r.cost_total ?? 0), 0),
		});
	}

	return stats.sort((a, b) => b.calls - a.calls);
}

// ── Report formatting ──

function formatMs(ms: number | null): string {
	if (ms == null) return "   —";
	if (ms < 1000) return `${Math.round(ms)}ms`.padStart(7);
	return `${(ms / 1000).toFixed(1)}s`.padStart(7);
}

function formatTokS(v: number | null): string {
	if (v == null) return "  —";
	return v.toFixed(1).padStart(6);
}

function formatCost(v: number): string {
	if (v === 0) return "    —";
	if (v < 0.01) return `$${v.toFixed(4)}`.padStart(8);
	return `$${v.toFixed(2)}`.padStart(8);
}

function truncModel(provider: string, model: string, maxLen: number): string {
	const full = `${provider}/${model}`;
	return full.length > maxLen ? full.substring(0, maxLen - 1) + "…" : full.padEnd(maxLen);
}

export function formatReport(stats: ModelStats[], timeLabel: string, theme: any): string {
	if (stats.length === 0) return theme.fg("dim", `No LLM calls recorded (${timeLabel})`);

	const hdr = ` ${"Model".padEnd(26)} ${"Calls".padStart(5)}  ${"TTFT p50".padStart(7)}  ${"Dur p50".padStart(7)}  ${"Tok/s".padStart(6)}  ${"Cost".padStart(8)}`;
	const sep = "─".repeat(hdr.length);

	let text = theme.fg("accent", `LLM Perf (${timeLabel})`) + "\n";
	text += theme.fg("dim", sep) + "\n";
	text += theme.fg("dim", hdr) + "\n";
	text += theme.fg("dim", sep) + "\n";

	let totalCost = 0;
	let totalCalls = 0;
	for (const s of stats) {
		const line =
			` ${truncModel(s.provider, s.model, 26)} ${String(s.calls).padStart(5)}  ${formatMs(s.ttftP50)}  ${formatMs(s.durationP50)}  ${formatTokS(s.tokPerSec)}  ${formatCost(s.totalCost)}`;
		text += line + "\n";
		totalCost += s.totalCost;
		totalCalls += s.calls;
	}

	text += theme.fg("dim", sep) + "\n";
	text += theme.bold(` ${"Total".padEnd(26)} ${String(totalCalls).padStart(5)}  ${"".padStart(7)}  ${"".padStart(7)}  ${"".padStart(6)}  ${formatCost(totalCost)}`);

	return text;
}
