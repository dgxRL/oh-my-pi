/**
 * Reduced port of packages/mnemopi/src/core/beam/consolidate.ts.
 * Sleep workflow: claim eligible working rows (older than TTL/2), group by
 * source, compress each group into one episodic row via AAAK text compression,
 * log the consolidation, then tier-degrade old episodes. Also: manual
 * consolidation, contamination listing, episodic stats.
 * Dropped vs the original: LLM/heuristic fact extraction during consolidation,
 * MEMORIA retrieval (memoriaRetrieve), health(), extraction helpers.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { generateId } from "../../util/ids";
import { aaakEncode } from "../aaak";
import { EpisodicGraph } from "../episodic-graph";
import { clampVeracity } from "../veracity-consolidation";
import type { BeamMemoryState, BeamStats, JsonValue, Metadata, SleepResult } from "./types";

type Row = Record<string, unknown>;

type ConsolidateOptions = {
	metadata?: Metadata | null;
	validUntil?: string | null;
	scope?: string;
	veracity?: string | null;
};

const CONTAMINATED_VERACITY: Record<string, true> = {
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
	false: true,
};

const EPISODIC_VERACITY_WEIGHT = {
	true: 1.0,
	stated: 1.0,
	unknown: 0.8,
	inferred: 0.7,
	imported: 0.6,
	tool: 0.5,
	false: 0.0,
} as const;

type EpisodicVeracity = keyof typeof EPISODIC_VERACITY_WEIGHT;

function envInt(name: string, defaultValue: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

const SLEEP_BATCH_SIZE = envInt("MNEMOPI_SLEEP_BATCH", 5000);
const TIER2_DAYS = envInt("MNEMOPI_TIER2_DAYS", 30);
const TIER3_DAYS = envInt("MNEMOPI_TIER3_DAYS", 180);
const DEGRADE_BATCH_SIZE = envInt("MNEMOPI_DEGRADE_BATCH", 100);
const TIER3_MAX_CHARS = envInt("MNEMOPI_TIER3_MAX_CHARS", 300);
const DEFAULT_MAX_EPISODE_CHARS = 100_000;
const SLEEP_SUMMARY_SEPARATOR = " | ";
const SLEEP_TRUNCATION_MARKER = "\n[... sleep_consolidation episode truncated by maxEpisodeChars ...]";

type SleepSummary = {
	summary: string;
	originalChars: number;
	truncated: boolean;
	maxChars: number;
};

type SleepChunk = {
	items: Row[];
	originalChars: number;
};

function normalizedMaxEpisodeChars(beam: BeamMemoryState): number {
	const configured = Math.trunc(beam.config?.maxEpisodeChars ?? DEFAULT_MAX_EPISODE_CHARS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_EPISODE_CHARS;
}

function markTruncated(content: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (maxChars <= SLEEP_TRUNCATION_MARKER.length) return content.slice(0, maxChars);
	const bodyChars = maxChars - SLEEP_TRUNCATION_MARKER.length;
	return `${content.slice(0, bodyChars).trimEnd()}${SLEEP_TRUNCATION_MARKER}`;
}

function splitSleepItems(beam: BeamMemoryState, source: string, items: readonly Row[]): SleepChunk[] {
	const maxChars = normalizedMaxEpisodeChars(beam);
	const prefixChars = `[${source}] `.length;
	const joinedLimit = Math.max(0, maxChars - prefixChars);
	const chunks: SleepChunk[] = [];
	let current: Row[] = [];
	let currentChars = 0;

	for (const item of items) {
		const contentChars = (rowValue(item, "content") ?? "").length;
		const separatorChars = current.length === 0 ? 0 : SLEEP_SUMMARY_SEPARATOR.length;
		if (current.length > 0 && currentChars + separatorChars + contentChars > joinedLimit) {
			chunks.push({ items: current, originalChars: currentChars });
			current = [];
			currentChars = 0;
		}
		current.push(item);
		currentChars += (current.length === 1 ? 0 : SLEEP_SUMMARY_SEPARATOR.length) + contentChars;
	}
	if (current.length > 0) chunks.push({ items: current, originalChars: currentChars });
	return chunks;
}

function buildSleepSummary(beam: BeamMemoryState, source: string, chunk: SleepChunk): SleepSummary {
	const maxChars = normalizedMaxEpisodeChars(beam);
	const prefix = `[${source}] `;
	const joined = chunk.items.map(item => rowValue(item, "content") ?? "").join(SLEEP_SUMMARY_SEPARATOR);
	const uncapped = `${prefix}${aaakEncode(joined)}`;
	const truncated = uncapped.length > maxChars;
	return {
		summary: truncated ? markTruncated(uncapped, maxChars) : uncapped,
		originalChars: chunk.originalChars,
		truncated,
		maxChars,
	};
}

function isoNow(): string {
	return new Date().toISOString();
}

function cutoffIso(amount: number, unitMs: number): string {
	return new Date(Date.now() - amount * unitMs).toISOString();
}

function rowValue(row: Row, key: string): string | null {
	const value = row[key];
	return value == null ? null : String(value);
}

function isEpisodicVeracity(value: string): value is EpisodicVeracity {
	return Object.hasOwn(EPISODIC_VERACITY_WEIGHT, value);
}

function clampEpisodicVeracity(raw: unknown): EpisodicVeracity {
	if (raw === null || raw === undefined) return "unknown";
	const norm = String(raw).trim().toLowerCase();
	if (norm === "") return "unknown";
	if (isEpisodicVeracity(norm)) return norm;
	const clamped = clampVeracity(raw, "consolidateToEpisodic.veracity");
	return isEpisodicVeracity(clamped) ? clamped : "unknown";
}

function aggregateEpisodicVeracity(sourceVeracities: readonly string[]): EpisodicVeracity {
	let winner: EpisodicVeracity | null = null;
	let maxCount = 0;
	const counts = new Map<EpisodicVeracity, number>();
	for (const raw of sourceVeracities) {
		const value = clampEpisodicVeracity(raw);
		if (value === "unknown") continue;
		const count = (counts.get(value) ?? 0) + 1;
		counts.set(value, count);
		if (
			count > maxCount ||
			(count === maxCount && (winner === null || EPISODIC_VERACITY_WEIGHT[value] < EPISODIC_VERACITY_WEIGHT[winner]))
		) {
			winner = value;
			maxCount = count;
		}
	}
	if (winner !== null) return winner;
	for (const raw of sourceVeracities) {
		if (clampEpisodicVeracity(raw) === "unknown") return "unknown";
	}
	return "unknown";
}

function sourceSession(beam: BeamMemoryState): string {
	return beam.sessionId || "default";
}

function asRows(value: unknown): Row[] {
	return Array.isArray(value) ? (value as Row[]) : [];
}

function emitEvent(
	beam: BeamMemoryState,
	type: string,
	memoryId: string,
	content: string,
	source: string,
	importance: number,
	metadata: Metadata,
): void {
	const event = {
		type,
		sessionId: beam.sessionId,
		timestamp: isoNow(),
		memoryId,
		content,
		source,
		importance,
		metadata,
	};
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

/**
 * Populate the episodic graph (gist + ctx edge + lexical links) for a freshly
 * consolidated memory. Best-effort: failures never roll back the consolidation.
 */
function ingestIntoEpisodicGraph(beam: BeamMemoryState, memoryId: string, summary: string): void {
	try {
		const graph = beam.episodicGraph instanceof EpisodicGraph ? beam.episodicGraph : new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(summary, memoryId, {
			sessionId: sourceSession(beam),
			linkExisting: true,
			extractEntities: false,
		});
	} catch {
		// Graph enrichment is best-effort and never blocks consolidation.
	}
}

export function consolidateToEpisodic(
	beam: BeamMemoryState,
	summary: string,
	sourceWmIds: readonly string[],
	source = "consolidation",
	importance = 0.6,
	options: ConsolidateOptions = {},
): string {
	const memoryId = generateId(summary);
	const timestamp = isoNow();
	const scope = options.scope ?? "session";
	const veracity = clampEpisodicVeracity(options.veracity ?? "unknown");
	const metadata = options.metadata ?? {};
	beam.db.run(
		`INSERT INTO episodic_memory
		 (id, content, source, timestamp, session_id, importance, metadata_json, summary_of,
		  valid_until, scope, author_id, author_type, channel_id, memory_type, veracity, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			memoryId,
			summary,
			source,
			timestamp,
			sourceSession(beam),
			importance,
			JSON.stringify(metadata),
			sourceWmIds.join(","),
			options.validUntil ?? null,
			scope,
			beam.authorId,
			beam.authorType,
			beam.channelId,
			"unknown",
			veracity,
			timestamp,
		],
	);
	ingestIntoEpisodicGraph(beam, memoryId, summary);
	emitEvent(beam, "MEMORY_CONSOLIDATED", memoryId, summary, source, importance, {
		summary_of: [...sourceWmIds],
		...metadata,
	});
	return memoryId;
}

export function getEpisodicStats(
	beam: BeamMemoryState,
	authorId: string | null = null,
	authorType: string | null = null,
	channelId: string | null = null,
): BeamStats {
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (authorId) {
		clauses.push("author_id = ?");
		params.push(authorId);
	}
	if (authorType) {
		clauses.push("author_type = ?");
		params.push(authorType);
	}
	if (channelId) {
		clauses.push("channel_id = ?");
		params.push(channelId);
	}
	const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
	const totalRow = beam.db.query(`SELECT COUNT(*) AS count FROM episodic_memory${where}`).get(...params) as {
		count: number;
	};
	const lastRow = beam.db
		.query(`SELECT timestamp FROM episodic_memory${where} ORDER BY timestamp DESC LIMIT 1`)
		.get(...params) as { timestamp: string | null } | null;
	return { count: totalRow.count, total: totalRow.count, last: lastRow?.timestamp ?? null, vectors: 0, vec_type: "none" };
}

function extractKeySignal(content: string, maxChars: number): string {
	const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
	if (sentences.length === 0) return content.slice(0, maxChars);
	const scored = sentences.map((sentence, idx) => {
		const score =
			(sentence.match(/\b[A-Z][a-zA-Z0-9_-]+\b/g)?.length ?? 0) * 2 +
			(sentence.match(/\b(prefer|always|never|deadline|release|version|decided|important|must|should)\b/gi)?.length ?? 0);
		return { sentence, idx, score };
	});
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
	const selected: typeof scored = [];
	let used = 0;
	for (const item of scored) {
		const next = item.sentence.trim();
		if (used + next.length + 1 > maxChars && selected.length > 0) continue;
		selected.push(item);
		used += next.length + 1;
		if (used >= maxChars) break;
	}
	selected.sort((a, b) => a.idx - b.idx);
	const text = selected.map(s => s.sentence.trim()).join(" ");
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 6)).trim()} [...]`;
}

function invalidateEpisodicVectors(beam: BeamMemoryState, memoryId: string): void {
	beam.db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [memoryId]);
}

export function degradeEpisodic(beam: BeamMemoryState, dryRun = false): Record<string, JsonValue> {
	const now = isoNow();
	const tier2Cutoff = cutoffIso(TIER2_DAYS, 24 * 60 * 60 * 1000);
	const tier3Cutoff = cutoffIso(TIER3_DAYS, 24 * 60 * 60 * 1000);
	const tier1Rows = asRows(
		beam.db
			.query(
				`SELECT id, content FROM episodic_memory WHERE tier = 1 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(tier2Cutoff, DEGRADE_BATCH_SIZE),
	);
	const tier2Rows = asRows(
		beam.db
			.query(
				`SELECT id, content FROM episodic_memory WHERE tier = 2 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(tier3Cutoff, Math.max(1, Math.floor(DEGRADE_BATCH_SIZE / 2))),
	);
	const result = {
		status: dryRun ? "dry_run" : "degraded",
		tier1_to_tier2: tier1Rows.length,
		tier2_to_tier3: tier2Rows.length,
	};
	if (dryRun) return result;
	for (const row of tier1Rows) {
		const id = rowValue(row, "id");
		const content = rowValue(row, "content") ?? "";
		if (!id) continue;
		const compressed = content.slice(0, 800);
		beam.db.run("SAVEPOINT degrade_episodic");
		try {
			beam.db.run("UPDATE episodic_memory SET content = ?, tier = 2, degraded_at = ? WHERE id = ?", [
				compressed,
				now,
				id,
			]);
			if (compressed !== content) invalidateEpisodicVectors(beam, id);
			beam.db.run("RELEASE degrade_episodic");
		} catch {
			beam.db.run("ROLLBACK TO degrade_episodic");
			beam.db.run("RELEASE degrade_episodic");
			result.tier1_to_tier2--;
		}
	}
	for (const row of tier2Rows) {
		const id = rowValue(row, "id");
		const content = rowValue(row, "content") ?? "";
		if (!id) continue;
		const compressed = content.length > TIER3_MAX_CHARS ? extractKeySignal(content, TIER3_MAX_CHARS) : content;
		beam.db.run("SAVEPOINT degrade_episodic");
		try {
			beam.db.run("UPDATE episodic_memory SET content = ?, tier = 3, degraded_at = ? WHERE id = ?", [
				compressed,
				now,
				id,
			]);
			if (compressed !== content) invalidateEpisodicVectors(beam, id);
			beam.db.run("RELEASE degrade_episodic");
		} catch {
			beam.db.run("ROLLBACK TO degrade_episodic");
			beam.db.run("RELEASE degrade_episodic");
			result.tier2_to_tier3--;
		}
	}
	return result;
}

export function getContaminated(beam: BeamMemoryState, limit = 50, minImportance = 0.0): Row[] {
	const rows = asRows(
		beam.db
			.query(
				`SELECT id, content, source, veracity, tier, importance, created_at, degraded_at, session_id
		 FROM episodic_memory
		 WHERE veracity IN ('inferred', 'tool', 'imported', 'unknown', 'false') AND importance >= ?
		 ORDER BY importance DESC, created_at DESC LIMIT ?`,
			)
			.all(minImportance, limit),
	);
	return rows.filter(row => CONTAMINATED_VERACITY[rowValue(row, "veracity") ?? "unknown"] === true);
}

function eligibleWorkingRows(beam: BeamMemoryState, sessionId: string): Row[] {
	const ttl = beam.config?.workingMemoryTtlHours ?? 24;
	const cutoff = cutoffIso(Math.floor(ttl / 2), 60 * 60 * 1000);
	return asRows(
		beam.db
			.query(
				`SELECT id, COALESCE(embed_text, content) AS content, source, timestamp, importance, metadata_json, scope, valid_until, veracity
		 FROM working_memory
		 WHERE COALESCE(session_id, 'default') = ? AND timestamp < ? AND consolidated_at IS NULL
		 ORDER BY timestamp ASC LIMIT ?`,
			)
			.all(sessionId, cutoff, SLEEP_BATCH_SIZE),
	);
}

export function sleep(beam: BeamMemoryState, dryRun = false): SleepResult {
	let rows = eligibleWorkingRows(beam, sourceSession(beam));
	if (rows.length === 0)
		return { dry_run: dryRun, status: "no_op", message: "No old working memories to consolidate" };
	if (!dryRun) {
		const claimTs = isoNow();
		const ids = rows.map(row => rowValue(row, "id")).filter((id): id is string => id !== null);
		const placeholders = ids.map(() => "?").join(",");
		beam.db.run(
			`UPDATE working_memory SET consolidated_at = ? WHERE id IN (${placeholders}) AND consolidated_at IS NULL`,
			[claimTs, ...ids],
		);
		const claimed = new Set(
			asRows(
				beam.db
					.query(`SELECT id FROM working_memory WHERE id IN (${placeholders}) AND consolidated_at = ?`)
					.all(...ids, claimTs),
			).map(row => rowValue(row, "id")),
		);
		if (claimed.size === 0)
			return {
				dry_run: false,
				status: "no_op",
				message: "All eligible rows claimed by concurrent sleep",
			};
		rows = rows.filter(row => claimed.has(rowValue(row, "id")));
	}

	const grouped = new Map<string, Row[]>();
	for (const row of rows) {
		const source = rowValue(row, "source") ?? "unknown";
		const group = grouped.get(source);
		if (group) group.push(row);
		else grouped.set(source, [row]);
	}

	const consolidatedIds: string[] = [];
	let summariesCreated = 0;
	for (const [source, items] of grouped) {
		for (const chunk of splitSleepItems(beam, source, items)) {
			const ids = chunk.items.map(item => rowValue(item, "id")).filter((id): id is string => id !== null);
			let scope = "session";
			let validUntil: string | null = null;
			for (const item of chunk.items) {
				if (rowValue(item, "scope") === "global") scope = "global";
				const itemValidUntil = rowValue(item, "valid_until");
				if (itemValidUntil && (validUntil === null || itemValidUntil < validUntil)) validUntil = itemValidUntil;
			}
			const sleepSummary = buildSleepSummary(beam, source, chunk);
			const metadata: Metadata = { original_count: chunk.items.length, source, llm_used: false };
			if (sleepSummary.truncated) {
				metadata.truncated = true;
				metadata.original_chars = sleepSummary.originalChars;
				metadata.max_chars = sleepSummary.maxChars;
			}
			const summary = sleepSummary.summary;
			if (!dryRun) {
				consolidateToEpisodic(beam, summary, ids, "sleep_consolidation", 0.6, {
					scope,
					validUntil,
					veracity: aggregateEpisodicVeracity(chunk.items.map(item => rowValue(item, "veracity") ?? "unknown")),
					metadata,
				});
			}
			consolidatedIds.push(...ids);
			summariesCreated++;
		}
	}
	if (!dryRun) {
		beam.db.run(
			`INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)`,
			[
				sourceSession(beam),
				consolidatedIds.length,
				`${summariesCreated} summaries (aaak) from ${consolidatedIds.length} items`,
				isoNow(),
			],
		);
	}
	const degradation = degradeEpisodic(beam, dryRun);
	return {
		dry_run: dryRun,
		status: dryRun ? "dry_run" : "consolidated",
		items_consolidated: consolidatedIds.length,
		summaries_created: summariesCreated,
		conflicts_resolved: 0,
		llm_used: 0,
		method: "aaak",
		consolidated_ids: consolidatedIds,
		degradation,
	};
}

export function sleepAllSessions(beam: BeamMemoryState, dryRun = false): SleepResult {
	const ttl = beam.config?.workingMemoryTtlHours ?? 24;
	const cutoff = cutoffIso(Math.floor(ttl / 2), 60 * 60 * 1000);
	const sessions = asRows(
		beam.db
			.query(
				`SELECT session_id, COUNT(*) AS eligible FROM working_memory
		 WHERE timestamp < ? AND consolidated_at IS NULL GROUP BY session_id ORDER BY MIN(timestamp) ASC`,
			)
			.all(cutoff),
	);
	if (sessions.length === 0) {
		return {
			dry_run: dryRun,
			status: "no_op",
			message: "No old working memories to consolidate",
			sessions_scanned: 0,
			sessions_consolidated: 0,
			items_consolidated: 0,
			summaries_created: 0,
			llm_used: 0,
			errors: 0,
			session_results: [],
		};
	}
	const originalSession = beam.sessionId;
	const results: Row[] = [];
	let items = 0;
	let summaries = 0;
	let consolidated = 0;
	for (const row of sessions) {
		const sessionId = rowValue(row, "session_id") ?? "default";
		const scoped = Object.create(Object.getPrototypeOf(beam)) as BeamMemoryState;
		Object.assign(scoped, beam, { sessionId, channelId: sessionId });
		const result = sleep(scoped, dryRun) as Row;
		result.session_id = sessionId;
		result.eligible = row.eligible;
		results.push(result);
		if (result.status === "consolidated" || result.status === "dry_run") consolidated++;
		items += Number(result.items_consolidated ?? 0);
		summaries += Number(result.summaries_created ?? 0);
	}
	const degradation = degradeEpisodic(beam, dryRun);
	return {
		dry_run: dryRun,
		status: dryRun ? "dry_run" : items > 0 ? "consolidated" : "no_op",
		sessions_scanned: sessions.length,
		sessions_consolidated: consolidated,
		items_consolidated: items,
		summaries_created: summaries,
		llm_used: 0,
		errors: 0,
		error_details: [],
		session_results: results,
		degradation,
		original_session: originalSession,
	};
}

export function getConsolidationLog(beam: BeamMemoryState, limit = 10): Row[] {
	return asRows(
		beam.db
			.query(
				`SELECT id, session_id, items_consolidated, summary_preview, created_at
		 FROM consolidation_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all(sourceSession(beam), limit),
	);
}

/** Language sniffing used to pick normalization rules; heuristic, no deps. */
export function detectLanguage(_beam: BeamMemoryState, text: string): string {
	if (typeof text !== "string" || text.length === 0) return "en";
	const lower = text.toLowerCase();
	const russianChars = [...lower].filter(c => "абвгдеёжзийклмнопрстуфхцчшщъыьэюя".includes(c)).length;
	if (russianChars >= 5) return "ru";
	if (/[äöüß]/.test(lower)) return "de";
	if (/[ñáéíóúü¿¡]/.test(lower)) return "es";
	return "en";
}
