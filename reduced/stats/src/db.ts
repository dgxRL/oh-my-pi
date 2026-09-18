/**
 * Reduced port of packages/stats/src/db.ts — SQLite storage + dashboard queries.
 * Flat cost rate instead of catalog rate cards (no per-provider pricing), no
 * premium requests / unpriced markers / cost backfills, no user_messages.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getStatsDbPath } from "./paths";
import { classifyAgentType, type ParseSessionResult, type SessionParserState } from "./parser";
import type {
	AgentType,
	AgentTypeStats,
	CostTimeSeriesPoint,
	StatsSummary,
	FolderStats,
	MessageStats,
	MessageStatsInput,
	ModelStats,
	TimeSeriesPoint,
	ToolCallStats,
	ToolModelStats,
	ToolResultLink,
	ToolTimeSeriesPoint,
	ToolUsageStats,
} from "./types";

/** Flat API-equivalent rate: $3 per 1M tokens for any model. */
export const FLAT_RATE_PER_1M = 3.0;

let db: Database | null = null;

export function initDb(): Database {
	if (db) return db;
	const dbPath = getStatsDbPath();
	mkdirSync(dirname(dbPath), { recursive: true });
	db = new Database(dbPath, { create: true });
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			UNIQUE(session_file, entry_id)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL,
			parser_state TEXT
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			calls_in_turn INTEGER NOT NULL DEFAULT 1,
			args_chars INTEGER NOT NULL DEFAULT 0,
			result_chars INTEGER,
			is_error INTEGER,
			UNIQUE(session_file, tool_call_id)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
	// Legacy offset-only databases: backfill the parser-state cursor column.
	const offsetColumns = db.prepare("PRAGMA table_info(file_offsets)").all() as Array<{ name: string }>;
	if (!offsetColumns.some(column => column.name === "parser_state")) {
		db.exec("ALTER TABLE file_offsets ADD COLUMN parser_state TEXT");
	};
	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp)");
	// Token-usage-by-agent: a pre-existing table without the column gets it
	// (defaulting rows to 'main') plus a one-time path-based reclassification.
	const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
	const hasAgentTypeColumn = messageColumns.some(column => column.name === "agent_type");
	if (!hasAgentTypeColumn) {
		db.exec("ALTER TABLE messages ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'");
		const legacySentinel = db.prepare("SELECT value FROM meta WHERE key = 'agent_type_backfill'").get();
		if (!legacySentinel) {
			db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_type_backfill', 'pending')").run();
		}
	}
	const backfillState = db.prepare("SELECT value FROM meta WHERE key = 'agent_type_backfill'").get() as
		| { value: string }
		| undefined;
	if (backfillState?.value === "pending") {
		const sessionFiles = db
			.prepare("SELECT DISTINCT session_file FROM messages WHERE agent_type = 'main'")
			.all() as Array<{ session_file: string }>;
		const reclassify = db.prepare("UPDATE messages SET agent_type = ? WHERE session_file = ?");
		for (const row of sessionFiles) {
			reclassify.run(classifyAgentType(row.session_file), row.session_file);
		}
		db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_type_backfill', 'complete')").run();
	} else if (backfillState === undefined) {
		db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_type_backfill', 'complete')").run();
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_timestamp_agent_type ON messages(timestamp, agent_type)");
	return db;
}

export function closeDb(): void {
	db?.close();
	db = null;
}

/**
 * Cost for one stored request: the session-recorded cost wins when present
 * (finite); otherwise a flat estimate — every token bucket at
 * `FLAT_RATE_PER_1M`, so the total is `totalTokens / 1e6 * rate`.
 */
function resolveCost(stats: MessageStatsInput, totalTokens: number): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
} {
	const recorded = stats.usage?.cost;
	if (recorded && typeof recorded === "object") {
		// A recorded cost object is authoritative: malformed buckets count as
		// absent (0), and a missing/malformed total is derived from components.
		const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const input = finite(recorded.input);
		const output = finite(recorded.output);
		const cacheRead = finite(recorded.cacheRead);
		const cacheWrite = finite(recorded.cacheWrite);
		const recordedTotal = finite(recorded.total);
		const total = recordedTotal > 0 ? recordedTotal : input + output + cacheRead + cacheWrite;
		return { input, output, cacheRead, cacheWrite, total };
	}
	const rate = (tokens: number): number => (tokens / 1_000_000) * FLAT_RATE_PER_1M;
	return {
		input: rate(finiteTokenCount(stats.usage?.input)),
		output: rate(finiteTokenCount(stats.usage?.output)),
		cacheRead: rate(finiteTokenCount(stats.usage?.cacheRead)),
		cacheWrite: rate(finiteTokenCount(stats.usage?.cacheWrite)),
		total: rate(totalTokens),
	};
}

function finiteTokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Insert message stats. Forked sessions deep-copy parent entries (same
 * entry_id + timestamp under a different session_file), so a
 * `WHERE NOT EXISTS` guard skips cross-lineage duplicates — first write wins.
 * Same-file re-syncs hit the `ON CONFLICT(session_file, entry_id)` upsert,
 * which re-derives the stored cost.
 */
export function insertMessageStats(stats: MessageStatsInput[]): number {
	if (stats.length === 0) return 0;
	const database = initDb();
	const stmt = database.prepare(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			cost_input = excluded.cost_input,
			cost_output = excluded.cost_output,
			cost_cache_read = excluded.cost_cache_read,
			cost_cache_write = excluded.cost_cache_write,
			cost_total = excluded.cost_total
	`);

	let inserted = 0;
	const insert = database.transaction(() => {
		for (const s of stats) {
			const totalTokens = resolveUsageTotalLocal(s.usage);
			const cost = resolveCost(s, totalTokens);
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.model,
				s.provider,
				s.api,
				s.timestamp,
				s.duration,
				s.ttft,
				s.stopReason,
				s.errorMessage,
				finiteTokenCount(s.usage?.input),
				finiteTokenCount(s.usage?.output),
				finiteTokenCount(s.usage?.cacheRead),
				finiteTokenCount(s.usage?.cacheWrite),
				totalTokens,
				cost.input,
				cost.output,
				cost.cacheRead,
				cost.cacheWrite,
				cost.total,
				s.agentType,
				s.entryId,
				s.timestamp,
				s.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

function resolveUsageTotalLocal(usage: unknown): number {
	if (usage && typeof usage === "object") {
		const view = usage as { totalTokens?: unknown };
		if (typeof view.totalTokens === "number" && Number.isFinite(view.totalTokens)) return view.totalTokens;
	}
	return (
		finiteTokenCount((usage as { input?: unknown })?.input) +
		finiteTokenCount((usage as { output?: unknown })?.output) +
		finiteTokenCount((usage as { cacheRead?: unknown })?.cacheRead) +
		finiteTokenCount((usage as { cacheWrite?: unknown })?.cacheWrite)
	);
}

export function insertToolCalls(calls: ToolCallStats[]): number {
	if (calls.length === 0) return 0;
	const database = initDb();
	const stmt = database.prepare(`
		INSERT OR IGNORE INTO tool_calls (
			session_file, entry_id, tool_call_id, folder, tool_name, model, provider,
			timestamp, agent_type, calls_in_turn, args_chars
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM tool_calls
			WHERE entry_id = ? AND timestamp = ? AND tool_call_id = ? AND session_file <> ?
		)
	`);
	let inserted = 0;
	const insert = database.transaction(() => {
		for (const c of calls) {
			const result = stmt.run(
				c.sessionFile,
				c.entryId,
				c.toolCallId,
				c.folder,
				c.toolName,
				c.model,
				c.provider,
				c.timestamp,
				c.agentType,
				c.callsInTurn,
				c.argsChars,
				// Guard binds: first-write-wins across forked lineages, keyed on
				// the assistant entry identity (call ids are not a global namespace).
				c.entryId,
				c.timestamp,
				c.toolCallId,
				c.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

/** Late-arriving results UPDATE the persisted call row (they may land in a later sync). */
export function updateToolResults(results: ToolResultLink[]): void {
	if (results.length === 0) return;
	const database = initDb();
	const stmt = database.prepare(
		"UPDATE tool_calls SET result_chars = ?, is_error = ? WHERE session_file = ? AND tool_call_id = ?",
	);
	const update = database.transaction(() => {
		for (const r of results) {
			stmt.run(r.resultChars, r.isError ? 1 : 0, r.sessionFile, r.toolCallId);
		}
	});
	update();
}

export function getFileOffset(
	sessionFile: string,
): { offset: number; lastModified: number; parserState?: SessionParserState } | null {
	const database = initDb();
	const row = database
		.prepare("SELECT offset, last_modified, parser_state FROM file_offsets WHERE session_file = ?")
		.get(sessionFile) as { offset: number; last_modified: number; parser_state: string | null } | undefined;
	if (!row) return null;
	let parserState: SessionParserState | undefined;
	if (row.parser_state) {
		try {
			const state = JSON.parse(row.parser_state) as SessionParserState;
			if (state?.version === 1 && state.offset === row.offset) parserState = state;
		} catch {
			// A missing cursor is reconstructed from the transcript.
		}
	}
	return { offset: row.offset, lastModified: row.last_modified, parserState };
}

export function setFileOffset(
	sessionFile: string,
	offset: number,
	lastModified: number,
	parserState?: SessionParserState,
): void {
	const database = initDb();
	database
		.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified, parser_state) VALUES (?, ?, ?, ?)")
		.run(sessionFile, offset, lastModified, parserState ? JSON.stringify(parserState) : null);
}

/**
 * Persist one parse result: on reset/rebuild the session's rows are deleted
 * first (detecting removed rows that require cross-file reconciliation), then
 * everything is re-inserted and the cursor advanced.
 */
export function applySessionParseResult(
	sessionFile: string,
	result: ParseSessionResult,
	rebuild = false,
): { processed: number; reconcile: boolean } {
	const parserState = result.parserState;
	if (!parserState) return { processed: 0, reconcile: false };
	const database = initDb();
	return database.transaction(() => {
		let reconcile = result.reset ?? false;
		if (result.reset || rebuild) {
			const retainedMessages = new Set(result.stats.map(row => `${row.entryId}\u0000${row.timestamp}`));
			const retainedTools = new Set(result.toolCalls.map(row => `${row.entryId}\u0000${row.toolCallId}`));
			const messages = database
				.prepare("SELECT entry_id, timestamp FROM messages WHERE session_file = ?")
				.all(sessionFile) as Array<{ entry_id: string; timestamp: number }>;
			const tools = database
				.prepare("SELECT entry_id, timestamp, tool_call_id FROM tool_calls WHERE session_file = ?")
				.all(sessionFile) as Array<{ entry_id: string; timestamp: number; tool_call_id: string }>;
			// A removed owner may have surviving fork copies skipped earlier in this pass.
			reconcile ||=
				messages.some(row => !retainedMessages.has(`${row.entry_id}\u0000${row.timestamp}`)) ||
				tools.some(row => !retainedTools.has(`${row.entry_id}\u0000${row.tool_call_id}`));
			database.prepare("DELETE FROM messages WHERE session_file = ?").run(sessionFile);
			database.prepare("DELETE FROM tool_calls WHERE session_file = ?").run(sessionFile);
		}
		if (reconcile) {
			database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('session_reconciliation', 'pending')").run();
		}
		if (result.stats.length > 0) insertMessageStats(result.stats);
		if (result.toolCalls.length > 0) insertToolCalls(result.toolCalls);
		if (result.toolResults.length > 0) updateToolResults(result.toolResults);
		setFileOffset(sessionFile, result.newOffset, parserState.mtimeMs, parserState);
		return { processed: result.stats.length, reconcile };
	})();
}

/** True when a previous pass flagged rows for cross-file reconciliation. */
export function prepareSessionSync(): boolean {
	return Boolean(initDb().prepare("SELECT 1 FROM meta WHERE key = 'session_reconciliation'").get());
}

export function completeSessionSync(reconcile: boolean): void {
	if (!reconcile) initDb().prepare("DELETE FROM meta WHERE key = 'session_reconciliation'").run();
}

// ---- dashboard queries ------------------------------------------------------

interface StatsRow {
	total_requests: number;
	failed_requests: number | null;
	total_input_tokens: number | null;
	total_output_tokens: number | null;
	total_cache_read_tokens: number | null;
	total_cache_write_tokens: number | null;
	total_cost: number | null;
	avg_duration: number | null;
	avg_ttft: number | null;
	avg_tokens_per_second: number | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

/** Shared aggregation: counts, token sums, cost, latency, throughput. */
function buildAggregatedStats(row: StatsRow | undefined): StatsSummary {
	if (!row) {
		return {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			totalTokens: 0,
			totalCost: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: 0,
			lastTimestamp: 0,
		};
	}
	const totalRequests = row.total_requests || 0;
	const failedRequests = row.failed_requests || 0;
	const totalInputTokens = row.total_input_tokens || 0;
	const totalOutputTokens = row.total_output_tokens || 0;
	const totalCacheReadTokens = row.total_cache_read_tokens || 0;
	const totalCacheWriteTokens = row.total_cache_write_tokens || 0;
	return {
		totalRequests,
		successfulRequests: totalRequests - failedRequests,
		failedRequests,
		errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheWriteTokens,
		totalTokens:
			totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheWriteTokens,
		totalCost: row.total_cost || 0,
		avgDuration: row.avg_duration,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
		firstTimestamp: row.first_timestamp || 0,
		lastTimestamp: row.last_timestamp || 0,
	};
}

const AGGREGATE_SELECT = `
	SELECT
		COUNT(*) as total_requests,
		SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
		SUM(input_tokens) as total_input_tokens,
		SUM(output_tokens) as total_output_tokens,
		SUM(cache_read_tokens) as total_cache_read_tokens,
		SUM(cache_write_tokens) as total_cache_write_tokens,
		SUM(cost_total) as total_cost,
		AVG(duration) as avg_duration,
		AVG(ttft) as avg_ttft,
		AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
		MIN(timestamp) as first_timestamp,
		MAX(timestamp) as last_timestamp
	FROM messages
`;

export function getOverallStats(cutoff?: number) {
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = initDb().prepare(`${AGGREGATE_SELECT} ${hasCutoff ? "WHERE timestamp >= ?" : ""}`);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as StatsRow | undefined;
	return buildAggregatedStats(row);
}

export function getStatsByModel(cutoff?: number): ModelStats[] {
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = initDb().prepare(
		`${AGGREGATE_SELECT.replace("FROM messages", ", model, provider FROM messages")}
		 ${hasCutoff ? "WHERE timestamp >= ?" : ""}
		 GROUP BY model, provider
		 ORDER BY total_requests DESC`,
	);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as Array<StatsRow & { model: string; provider: string }>;
	return rows.map(row => ({ model: row.model, provider: row.provider, ...buildAggregatedStats(row) }));
}

export function getStatsByFolder(cutoff?: number): FolderStats[] {
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = initDb().prepare(
		`${AGGREGATE_SELECT.replace("FROM messages", ", folder FROM messages")}
		 ${hasCutoff ? "WHERE timestamp >= ?" : ""}
		 GROUP BY folder
		 ORDER BY total_requests DESC`,
	);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as Array<StatsRow & { folder: string }>;
	return rows.map(row => ({ folder: row.folder, ...buildAggregatedStats(row) }));
}

export function getStatsByAgentType(cutoff?: number): AgentTypeStats[] {
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = initDb().prepare(
		`SELECT
			agent_type,
			COUNT(*) as total_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(cost_total) as total_cost
		 FROM messages
		 ${hasCutoff ? "WHERE timestamp >= ?" : ""}
		 GROUP BY agent_type`,
	);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as Array<{
		agent_type: string;
		total_requests: number;
		total_input_tokens: number | null;
		total_output_tokens: number | null;
		total_cache_read_tokens: number | null;
		total_cache_write_tokens: number | null;
		total_cost: number | null;
	}>;
	return rows.map(row => ({
		agentType: (row.agent_type as AgentType) ?? "main",
		totalRequests: row.total_requests || 0,
		totalInputTokens: row.total_input_tokens || 0,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens: row.total_cache_read_tokens || 0,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		totalCost: row.total_cost || 0,
	}));
}

export function getTimeSeries(hours = 24, cutoff?: number | null, bucketMs = 60 * 60 * 1000): TimeSeriesPoint[] {
	const hasCutoff = cutoff !== null && cutoff !== undefined;
	const seriesCutoff = hasCutoff ? (cutoff as number) : Date.now() - hours * 60 * 60 * 1000;
	const rows = initDb()
		.prepare(
			`SELECT
				(timestamp / ${bucketMs}) * ${bucketMs} as bucket,
				COUNT(*) as requests,
				SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as errors
			 FROM messages
			 WHERE timestamp >= ?
			 GROUP BY bucket
			 ORDER BY bucket ASC`,
		)
		.all(seriesCutoff) as Array<{ bucket: number; requests: number; errors: number }>;
	return rows.map(row => ({ timestamp: row.bucket, requests: row.requests, errors: row.errors }));
}

function rowToMessageStats(row: Record<string, unknown>): MessageStats {
	return {
		id: row.id as number,
		sessionFile: row.session_file as string,
		entryId: row.entry_id as string,
		folder: row.folder as string,
		model: row.model as string,
		provider: row.provider as string,
		api: row.api as string,
		timestamp: row.timestamp as number,
		duration: (row.duration as number | null) ?? null,
		ttft: (row.ttft as number | null) ?? null,
		stopReason: row.stop_reason as string,
		errorMessage: (row.error_message as string | null) ?? null,
		usage: {
			input: row.input_tokens as number,
			output: row.output_tokens as number,
			cacheRead: row.cache_read_tokens as number,
			cacheWrite: row.cache_write_tokens as number,
			totalTokens: row.total_tokens as number,
			cost: {
				input: row.cost_input as number,
				output: row.cost_output as number,
				cacheRead: row.cost_cache_read as number,
				cacheWrite: row.cost_cache_write as number,
				total: row.cost_total as number,
			},
		},
		agentType: (row.agent_type as AgentType) ?? "main",
	};
}

const MESSAGE_COLUMNS =
	"id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type";

export function getRecentRequests(limit = 100): MessageStats[] {
	const rows = initDb()
		.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY timestamp DESC LIMIT ?`)
		.all(limit) as Array<Record<string, unknown>>;
	return rows.map(rowToMessageStats);
}

export function getRecentErrors(limit = 100, cutoff?: number | null): MessageStats[] {
	const hasCutoff = cutoff !== null && cutoff !== undefined;
	const rows = initDb()
		.prepare(
			`SELECT ${MESSAGE_COLUMNS} FROM messages
			 WHERE stop_reason = 'error' ${hasCutoff ? "AND timestamp >= ?" : ""}
			 ORDER BY timestamp DESC LIMIT ?`,
		)
		.all(...(hasCutoff ? [cutoff as number] : []), limit) as Array<Record<string, unknown>>;
	return rows.map(rowToMessageStats);
}

/** Daily cost rollup per model for the cost dashboard series. */
export function getCostTimeSeries(days = 90, cutoff?: number | null): CostTimeSeriesPoint[] {
	const seriesCutoff = cutoff !== null && cutoff !== undefined ? cutoff : Date.now() - days * 24 * 60 * 60 * 1000;
	const rows = initDb()
		.prepare(
			`SELECT
				timestamp / 86400000 * 86400000 as day,
				model,
				provider,
				SUM(cost_total) as cost,
				SUM(total_tokens) as tokens,
				COUNT(*) as requests
			 FROM messages
			 WHERE timestamp >= ?
			 GROUP BY day, model, provider
			 ORDER BY day ASC`,
		)
		.all(seriesCutoff) as Array<{ day: number; model: string; provider: string; cost: number; tokens: number; requests: number }>;
	return rows.map(row => ({
		day: row.day,
		model: row.model,
		provider: row.provider,
		cost: row.cost || 0,
		tokens: row.tokens || 0,
		requests: row.requests,
	}));
}

const TOOL_AGGREGATE_COLUMNS = `
	COUNT(*) as calls,
	SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) as errors,
	SUM(t.args_chars) as args_chars,
	SUM(COALESCE(t.result_chars, 0)) as result_chars,
	SUM(COALESCE(m.total_tokens, 0) * 1.0 / t.calls_in_turn) as total_tokens_share,
	SUM(COALESCE(m.output_tokens, 0) * 1.0 / t.calls_in_turn) as output_tokens_share,
	SUM(COALESCE(m.cost_total, 0) / t.calls_in_turn) as cost_share,
	MAX(t.timestamp) as last_used
`;

interface ToolAggregateRow {
	tool_name: string;
	model?: string;
	provider?: string;
	calls: number;
	errors: number;
	args_chars: number | null;
	result_chars: number | null;
	total_tokens_share: number | null;
	output_tokens_share: number | null;
	cost_share: number | null;
	last_used: number;
}

function rowToToolUsage(row: ToolAggregateRow): ToolUsageStats {
	return {
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
		argsChars: row.args_chars ?? 0,
		resultChars: row.result_chars ?? 0,
		totalTokensShare: row.total_tokens_share ?? 0,
		outputTokensShare: row.output_tokens_share ?? 0,
		costShare: row.cost_share ?? 0,
		lastUsed: row.last_used,
	};
}

/** Tool usage aggregated per tool; share columns split the turn's request usage. */
export function getToolStats(cutoff?: number): ToolUsageStats[] {
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = initDb().prepare(`
		SELECT t.tool_name, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name
		ORDER BY calls DESC
	`);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ToolAggregateRow[];
	return rows.map(rowToToolUsage);
}

/** Tool usage aggregated by (tool, model, provider). */
export function getToolStatsByModel(cutoff?: number): ToolModelStats[] {
	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = initDb().prepare(`
		SELECT t.tool_name, t.model, t.provider, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name, t.model, t.provider
		ORDER BY calls DESC
	`);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ToolAggregateRow[];
	return rows.map(row => ({
		...rowToToolUsage(row),
		model: row.model ?? "",
		provider: row.provider ?? "",
	}));
}

/** Tool-call time series: one point per bucket per tool. */
export function getToolTimeSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ToolTimeSeriesPoint[] {
	const hasCutoff = cutoff !== null && cutoff !== undefined;
	const seriesCutoff = hasCutoff ? (cutoff as number) : Date.now() - days * 24 * 60 * 60 * 1000;
	const rows = initDb()
		.prepare(
			`SELECT
				(timestamp / ?) * ? as bucket,
				tool_name,
				COUNT(*) as calls,
				SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors
			 FROM tool_calls
			 ${hasCutoff ? "WHERE timestamp >= ?" : ""}
			 GROUP BY bucket, tool_name
			 ORDER BY bucket ASC`,
		)
		.all(...(hasCutoff ? [bucketMs, bucketMs, seriesCutoff] : [bucketMs, bucketMs])) as Array<{
		bucket: number;
		tool_name: string;
		calls: number;
		errors: number;
	}>;
	return rows.map(row => ({
		timestamp: row.bucket,
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
	}));
}

export function getMessageCount(): number {
	return (initDb().prepare("SELECT COUNT(*) as total FROM messages").get() as { total: number }).total;
}
