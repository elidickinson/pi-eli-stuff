import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LlmCallRow } from "./state-machine.js";

const SCHEMA_VERSION = 1;

export function getDbPath(): string {
	return join(homedir(), ".pi", "agent", "llm-perf.db");
}

export function openDb(dbPath: string): Database.Database {
	const dir = dirname(dbPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 1000");

	const version = db.pragma("user_version", { simple: true }) as number;
	if (version < SCHEMA_VERSION) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS llm_calls (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp_ms    INTEGER NOT NULL,
				session_id      TEXT,
				turn_index      INTEGER,
				provider        TEXT NOT NULL,
				model           TEXT NOT NULL,
				api             TEXT,
				ttft_ms         REAL,
				duration_ms     REAL,
				input_tokens    INTEGER,
				output_tokens   INTEGER,
				cache_read      INTEGER,
				cache_write     INTEGER,
				cost_input      REAL,
				cost_output     REAL,
				cost_cache_read REAL,
				cost_cache_write REAL,
				cost_total      REAL,
				context_tokens  INTEGER,
				context_window  INTEGER,
				stop_reason     TEXT,
				error_message   TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_timestamp ON llm_calls(timestamp_ms);
			CREATE INDEX IF NOT EXISTS idx_provider_model ON llm_calls(provider, model);
			CREATE INDEX IF NOT EXISTS idx_session ON llm_calls(session_id);
		`);
		db.pragma(`user_version = ${SCHEMA_VERSION}`);
	}

	return db;
}

export function insertCall(db: Database.Database, row: LlmCallRow): number {
	const stmt = db.prepare(`
		INSERT INTO llm_calls (
			timestamp_ms, session_id, turn_index, provider, model, api,
			ttft_ms, duration_ms,
			input_tokens, output_tokens, cache_read, cache_write,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
			context_tokens, context_window, stop_reason, error_message
		) VALUES (
			?, ?, ?, ?, ?, ?,
			?, ?,
			?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?
		)
	`);
	const result = stmt.run(
		row.timestamp_ms, row.session_id, row.turn_index, row.provider, row.model, row.api,
		row.ttft_ms, row.duration_ms,
		row.input_tokens, row.output_tokens, row.cache_read, row.cache_write,
		row.cost_input, row.cost_output, row.cost_cache_read, row.cost_cache_write, row.cost_total,
		row.context_tokens, row.context_window, row.stop_reason, row.error_message,
	);
	return result.lastInsertRowid as number;
}

export interface QueryOptions {
	sinceMs: number;
	modelFilter?: string;
}

export function queryCalls(db: Database.Database, opts: QueryOptions): LlmCallRow[] {
	let sql = "SELECT * FROM llm_calls WHERE timestamp_ms >= ?";
	const params: unknown[] = [opts.sinceMs];
	if (opts.modelFilter) {
		sql += " AND model LIKE ?";
		params.push(`%${opts.modelFilter}%`);
	}
	sql += " ORDER BY timestamp_ms ASC";
	return db.prepare(sql).all(...params) as LlmCallRow[];
}

export function purgeBefore(db: Database.Database, beforeMs: number): number {
	const result = db.prepare("DELETE FROM llm_calls WHERE timestamp_ms < ?").run(beforeMs);
	return result.changes;
}

export function getDistinctModels(db: Database.Database): string[] {
	const rows = db.prepare("SELECT DISTINCT model FROM llm_calls ORDER BY model").all() as { model: string }[];
	return rows.map((r) => r.model);
}
