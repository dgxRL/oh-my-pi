import { EpisodicGraph } from "../episodic-graph";
/**
 * Reduced port of packages/mnemopi/src/core/beam/store.ts.
 * Working-memory CRUD, dedup, trim with artifact cascade, scratchpad,
 * export/import. Dropped vs the original: background embedding scheduling,
 * LLM fact extraction, proactive linking, sqlite-vec import, embedding-model
 * reconciliation, memory_id/extraction option plumbing.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { transaction } from "../../db";
import { generateId } from "../../util/ids";
import { scratchpadMaxItems } from "../../config";
import { metadataJson, normalizeMetadata } from "./helpers";
import type {
	BeamEvent,
	BeamMemoryState,
	BeamStats,
	ImportStats,
	Metadata,
	RememberBatchItem,
	RememberBatchOptions,
	RememberOptions,
	TrustTier,
	Veracity,
} from "./types";

type Row = Record<string, unknown>;
type EventPayload = Omit<BeamEvent, "type" | "sessionId" | "timestamp">;

type StoreRememberOptions = RememberOptions;

const CANONICAL_VERACITY: Record<string, true> = {
	true: true,
	false: true,
	stated: true,
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
};

const TRUST_TIERS: Record<string, true> = {
	STATED: true,
	DERIVED: true,
	EXTERNAL_WRITE: true,
	IMPORTED: true,
};

/** Tables whose rows point back to a `working_memory` id via `source_memory_id`. */
const MEMORIA_SOURCE_TABLES = ["memoria_facts"] as const;

function toUtcIso(date: Date = new Date()): string {
	return date.toISOString();
}

function clampVeracity(value: unknown): Veracity {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase();
	return CANONICAL_VERACITY[normalized] === true ? normalized : "unknown";
}

function sourceToTrustTier(source: string | null | undefined): TrustTier {
	switch ((source ?? "").toLowerCase()) {
		case "conversation":
		case "user":
		case "assistant":
			return "STATED";
		case "tool":
		case "api":
		case "system":
			return "EXTERNAL_WRITE";
		case "import":
		case "imported":
		case "backup":
			return "IMPORTED";
		default:
			return "STATED";
	}
}

function normalizeTrustTier(value: unknown, source: string): TrustTier {
	if (value === null || value === undefined) return sourceToTrustTier(source);
	if (typeof value === "string" && TRUST_TIERS[value] === true) return value;
	return "STATED";
}

function emitEvent(beam: BeamMemoryState, type: string, data: EventPayload): void {
	const event: BeamEvent = {
		...data,
		type,
		sessionId: beam.sessionId,
		timestamp: toUtcIso(),
	};
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

function findDuplicate(beam: BeamMemoryState, content: string): string | null {
	const row = beam.db
		.query("SELECT id FROM working_memory WHERE content = ? AND session_id = ? LIMIT 1")
		.get(content, beam.sessionId) as { id: string } | null;
	return row?.id ?? null;
}

function tableExists(db: BeamMemoryState["db"], table: string): boolean {
	try {
		return (
			db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1").get(table) !==
			null
		);
	} catch {
		return false;
	}
}

function embeddingText(content: string, options: { embedText?: string }): string {
	return options.embedText ?? content;
}

function storedEmbeddingText(content: string, embedText: string): string | null {
	return embedText === content ? null : embedText;
}

function jsonObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isSqlBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean" ||
		value instanceof ArrayBuffer ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}

function sqlBinding(value: unknown, fallback: SQLQueryBindings): SQLQueryBindings {
	return isSqlBinding(value) ? value : fallback;
}

/**
 * Remove every artifact linked to the given `working_memory` ids so no deletion
 * path leaves orphans behind. Schema-tolerant: guarded for optional tables.
 */
function purgeWorkingMemoryArtifacts(db: BeamMemoryState["db"], ids: readonly string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");

	const graphRefs = new Set<string>(ids);
	for (const id of ids) graphRefs.add(`gist_${id}`);
	if (tableExists(db, "facts")) {
		const factRows = db.prepare(`SELECT fact_id FROM facts WHERE source_msg_id IN (${placeholders})`).all(...ids) as {
			fact_id: string;
		}[];
		for (const row of factRows) graphRefs.add(row.fact_id);
		db.run(`DELETE FROM facts WHERE source_msg_id IN (${placeholders})`, [...ids]);
	}

	db.run(`DELETE FROM annotations WHERE memory_id IN (${placeholders})`, [...ids]);
	db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`, [...ids]);
	for (const table of MEMORIA_SOURCE_TABLES) {
		if (tableExists(db, table)) {
			db.run(`DELETE FROM ${table} WHERE source_memory_id IN (${placeholders})`, [...ids]);
		}
	}

	if (tableExists(db, "gists")) {
		db.run(`DELETE FROM gists WHERE memory_id IN (${placeholders})`, [...ids]);
	}
	if (tableExists(db, "graph_edges")) {
		const refs = [...graphRefs];
		const refPlaceholders = refs.map(() => "?").join(", ");
		db.run(`DELETE FROM graph_edges WHERE source IN (${refPlaceholders}) OR target IN (${refPlaceholders})`, [
			...refs,
			...refs,
		]);
	}
}
function addTemporalAnnotations(beam: BeamMemoryState, memoryId: string, timestamp: string, source: string): void {
	try {
		beam.annotations?.add?.(memoryId, "occurred_on", timestamp.slice(0, 10));
		if (source && source !== "conversation" && source !== "user" && source !== "assistant") {
			beam.annotations?.add?.(memoryId, "has_source", source);
		}
	} catch {
		// Annotation enrichment is best-effort, matching Python's non-blocking path.
	}
}

function proactiveLinkingAllowed(beam: BeamMemoryState): boolean {
	const override = process.env.MNEMOPI_PROACTIVE_LINKING;
	return override === undefined ? beam.config.proactiveLinking === true : override === "1";
}

function proactiveLinkIfEnabled(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	extractEntities: boolean,
): void {
	if (!proactiveLinkingAllowed(beam)) return;
	try {
		const graph =
			beam.episodicGraph instanceof EpisodicGraph
				? beam.episodicGraph
				: new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(content, memoryId, {
			sessionId: beam.sessionId,
			linkExisting: true,
			extractEntities,
		});
	} catch {
		// Proactive graph enrichment must never block durable memory storage.
	}
}

/**
 * TTL / overflow trim for transient working memory. `IMPORTED`-tier rows are
 * durable and never trimmed; trimmed rows cascade all linked artifacts
 * (issue #4819).
 */
function trimWorkingMemory(beam: BeamMemoryState): void {
	const limit = beam.config.workingMemoryLimit;
	if (!Number.isFinite(limit) || limit <= 0) return;
	const ttlHours = beam.config.workingMemoryTtlHours;
	const cutoff = toUtcIso(new Date(Date.now() - ttlHours * 3_600_000));
	transaction(beam.db, () => {
		const ids = (
			beam.db
				.prepare(
					`
			SELECT id FROM working_memory
			WHERE session_id = ?
			  AND consolidated_at IS NULL
			  AND trust_tier IS NOT 'IMPORTED'
			  AND (
				timestamp < ? OR
				id NOT IN (
					SELECT id FROM working_memory
					WHERE session_id = ? AND consolidated_at IS NULL AND trust_tier IS NOT 'IMPORTED'
					ORDER BY timestamp DESC
					LIMIT ?
				)
			  )
		`,
				)
				.all(beam.sessionId, cutoff, beam.sessionId, limit) as { id: string }[]
		).map(row => row.id);
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(", ");
		beam.db.run(`DELETE FROM working_memory WHERE id IN (${placeholders}) AND session_id = ?`, [
			...ids,
			beam.sessionId,
		]);
		purgeWorkingMemoryArtifacts(beam.db, ids);
	});
}

function rowToDict(row: Row): Row {
	return { ...row };
}

export function remember(beam: BeamMemoryState, content: string, options: StoreRememberOptions = {}): string {
	const source = options.source ?? "conversation";
	const importance = options.importance ?? 0.5;
	const timestamp = options.timestamp ?? toUtcIso();
	const scope = options.scope ?? "session";
	const veracity = clampVeracity(options.veracity);
	const trustTier = normalizeTrustTier(options.trustTier, source);
	const memoryType = options.memoryType ?? "unknown";
	const authorId = options.authorId ?? beam.authorId;
	const authorType = options.authorType ?? beam.authorType;
	const channelId = options.channelId ?? beam.channelId;
	const metadata = options.metadata ?? null;
	const embedText = embeddingText(content, options);

	const existingId = findDuplicate(beam, content);
	if (existingId !== null) {
		beam.db.run(
			`
				UPDATE working_memory
				SET importance = MAX(importance, ?), timestamp = ?, source = ?,
					valid_until = COALESCE(?, valid_until),
					scope = COALESCE(?, scope),
					author_id = COALESCE(?, author_id),
					author_type = COALESCE(?, author_type),
					channel_id = COALESCE(?, channel_id),
					memory_type = COALESCE(?, memory_type),
					veracity = CASE WHEN ? != 'unknown' THEN ? ELSE veracity END,
					trust_tier = COALESCE(?, trust_tier),
					embed_text = COALESCE(?, embed_text),
					consolidated_at = NULL
				WHERE id = ? AND session_id = ?
			`,
			[
				importance,
				timestamp,
				source,
				options.validUntil ?? null,
				scope,
				authorId,
				authorType,
				channelId,
				memoryType,
				veracity,
				veracity,
				trustTier,
				storedEmbeddingText(content, embedText),
				existingId,
				beam.sessionId,
			],
		);
		emitEvent(beam, "MEMORY_UPDATED", {
			memoryId: existingId,
			content,
			source,
			importance,
			metadata: metadata ?? undefined,
		});
		return existingId;
	}

	const memoryId = generateId(content, new Date(timestamp));
	beam.db.run(
		`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json, valid_until, scope,
			 author_id, author_type, channel_id, veracity, memory_type, trust_tier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		[
			memoryId,
			content,
			storedEmbeddingText(content, embedText),
			source,
			timestamp,
			beam.sessionId,
			importance,
			metadataJson(metadata),
			options.validUntil ?? null,
			scope,
			authorId,
			authorType,
			channelId,
			veracity,
			memoryType,
			trustTier,
		],
	);
	addTemporalAnnotations(beam, memoryId, timestamp, source);
	proactiveLinkIfEnabled(beam, memoryId, content, options.extractEntities === true);
	trimWorkingMemory(beam);
	emitEvent(beam, "MEMORY_ADDED", {
		memoryId,
		content,
		source,
		importance,
		metadata: metadata ?? undefined,
	});
	return memoryId;
}

export function rememberBatch(
	beam: BeamMemoryState,
	items: readonly RememberBatchItem[],
	options: RememberBatchOptions = {},
): string[] {
	const timestamp = toUtcIso();
	const ids: string[] = [];
	const defaultVeracity = clampVeracity(options.veracity);
	const defaultScope = options.scope ?? "session";
	const trustTier = normalizeTrustTier(options.trustTier ?? "IMPORTED", "imported");

	transaction(beam.db, () => {
		const statement = beam.db.prepare(`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json,
			 author_id, author_type, channel_id, memory_type, veracity, trust_tier, scope)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const item of items) {
			const itemTimestamp = item.timestamp ?? timestamp;
			const memoryId = generateId(item.content, new Date(itemTimestamp));
			ids.push(memoryId);
			const source = item.source ?? "conversation";
			const itemVeracity = item.veracity !== undefined ? clampVeracity(item.veracity) : defaultVeracity;
			statement.run(
				memoryId,
				item.content,
				storedEmbeddingText(item.content, embeddingText(item.content, item)),
				source,
				itemTimestamp,
				beam.sessionId,
				item.importance ?? 0.5,
				metadataJson(item.metadata ?? null),
				item.authorId ?? beam.authorId,
				item.authorType ?? beam.authorType,
				item.channelId ?? beam.channelId,
				item.memoryType ?? options.memoryType ?? "unknown",
				itemVeracity,
				trustTier,
				item.scope ?? defaultScope,
			);
			emitEvent(beam, "MEMORY_ADDED", {
				memoryId,
				content: item.content,
				source,
				importance: item.importance ?? 0.5,
				metadata: item.metadata ?? undefined,
			});
		}
		trimWorkingMemory(beam);
	});
	return ids;
}

export function getContext(beam: BeamMemoryState, limit = 10): Row[] {
	const now = toUtcIso();
	const rows = beam.db
		.prepare(
			`
		SELECT id, content, source, timestamp, importance, scope
		FROM working_memory
		WHERE (session_id = ? OR scope = 'global')
		  AND (valid_until IS NULL OR valid_until > ?)
		  AND superseded_by IS NULL
		ORDER BY
			CASE WHEN scope = 'global' THEN 0 ELSE 1 END,
			importance DESC,
			timestamp DESC
		LIMIT ?
	`,
		)
		.all(beam.sessionId, now, limit) as Row[];
	return rows.map(rowToDict);
}

export function invalidate(beam: BeamMemoryState, memoryId: string, replacementId: string | null = null): boolean {
	const now = toUtcIso();
	const working = beam.db.run(
		`
			UPDATE working_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`,
		[now, replacementId, memoryId, beam.sessionId],
	);
	if (working.changes > 0) return true;
	const episodic = beam.db.run(
		`
			UPDATE episodic_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`,
		[now, replacementId, memoryId, beam.sessionId],
	);
	return episodic.changes > 0;
}

export function getWorkingStats(
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
	const totalRow = beam.db.prepare(`SELECT COUNT(*) AS total FROM working_memory${where}`).get(...params) as {
		total: number;
	};
	const lastRow = beam.db
		.prepare(`SELECT timestamp FROM working_memory${where} ORDER BY timestamp DESC LIMIT 1`)
		.get(...params) as { timestamp: string | null } | null;
	return { total: totalRow.total, count: totalRow.total, last: lastRow?.timestamp ?? null };
}

export function getGlobalWorkingStats(beam: BeamMemoryState): BeamStats {
	return getWorkingStats(beam);
}

export function updateWorking(
	beam: BeamMemoryState,
	memoryId: string,
	content: string | null = null,
	importance: number | null = null,
): boolean {
	const assignments: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (content !== null) {
		assignments.push("content = ?", "embed_text = NULL");
		params.push(content);
	}
	if (importance !== null) {
		assignments.push("importance = ?");
		params.push(importance);
	}
	if (assignments.length === 0) return false;
	params.push(memoryId, beam.sessionId);
	const result = beam.db.run(
		`UPDATE working_memory SET ${assignments.join(", ")} WHERE id = ? AND session_id = ?`,
		params,
	);
	return result.changes > 0;
}

export function get(beam: BeamMemoryState, memoryId: string): Row | null {
	const working = beam.db
		.prepare(`
		SELECT id, content, source, timestamp, session_id,
			   importance, metadata_json, veracity, created_at
		FROM working_memory
		WHERE id = ?
	`)
		.get(memoryId) as Row | null;
	if (working != null) return { ...working, metadata: working.metadata_json, memory_store: "working" };

	const episodic = beam.db
		.prepare(`
		SELECT id, content, source, timestamp, session_id,
			   importance, metadata_json, veracity, created_at
		FROM episodic_memory
		WHERE id = ? AND (session_id = ? OR scope = 'global')
	`)
		.get(memoryId, beam.sessionId) as Row | null;
	if (episodic != null) return { ...episodic, metadata: episodic.metadata_json, memory_store: "episodic" };

	return getFact(beam, memoryId);
}

/**
 * Read-only resolution for ids minted from the `facts` table (issue #4725).
 * Visibility mirrors `factRecall`: same-session facts plus explicitly global
 * ones. `memory_store: "fact"` marks the row read-only.
 */
function getFact(beam: BeamMemoryState, memoryId: string): Row | null {
	const fact = beam.db.prepare("SELECT * FROM facts WHERE fact_id = ?").get(memoryId) as
		| (Row & { fact_id?: string; scope?: string; source_msg_id?: string; created_at?: string })
		| null;
	if (fact == null) return null;
	if (fact.session_id !== beam.sessionId && fact.scope !== "global") return null;
	const subject = typeof fact.subject === "string" ? fact.subject : "";
	const predicate = typeof fact.predicate === "string" ? fact.predicate : "";
	const object = typeof fact.object === "string" ? fact.object : "";
	return {
		id: fact.fact_id,
		content: [subject, predicate, object].filter(part => part.length > 0).join(" "),
		source: "facts",
		timestamp: fact.timestamp ?? null,
		session_id: fact.session_id ?? null,
		importance: fact.confidence ?? null,
		metadata: JSON.stringify({
			subject,
			predicate,
			object,
			source_msg_id: fact.source_msg_id ?? null,
		}),
		created_at: fact.created_at ?? null,
		memory_store: "fact",
	};
}

export function forgetWorking(beam: BeamMemoryState, memoryId: string): boolean {
	let deleted = 0;
	transaction(beam.db, () => {
		const result = beam.db.run("DELETE FROM working_memory WHERE id = ? AND session_id = ?", [
			memoryId,
			beam.sessionId,
		]);
		deleted = result.changes;
		if (deleted > 0) {
			purgeWorkingMemoryArtifacts(beam.db, [memoryId]);
		}
	});
	return deleted > 0;
}

export function scratchpadWrite(beam: BeamMemoryState, content: string): string {
	const padId = generateId(content);
	const timestamp = toUtcIso();
	beam.db.run(
		`
			INSERT INTO scratchpad (id, content, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
		`,
		[padId, content, beam.sessionId, timestamp, timestamp],
	);
	return padId;
}

export function scratchpadRead(beam: BeamMemoryState): Row[] {
	const max = Number.isFinite(scratchpadMaxItems()) ? scratchpadMaxItems() : 1000;
	const rows = beam.db
		.prepare(
			`
		SELECT id, content, created_at, updated_at
		FROM scratchpad
		WHERE session_id = ?
		ORDER BY updated_at DESC
		LIMIT ?
	`,
		)
		.all(beam.sessionId, max) as Row[];
	return rows.map(rowToDict);
}

export function scratchpadClear(beam: BeamMemoryState): void {
	beam.db.run("DELETE FROM scratchpad WHERE session_id = ?", [beam.sessionId]);
}

export function exportToDict(beam: BeamMemoryState): Record<string, unknown> {
	const db = beam.db;
	const workingStatement = db.prepare(`
		SELECT id, content, source, timestamp, session_id, importance,
			   embed_text,
			   metadata_json, valid_until, superseded_by, scope,
			   recall_count, last_recalled, created_at, veracity, consolidated_at,
			   memory_type, author_id, author_type, channel_id, trust_tier,
			   event_date, event_date_precision, temporal_tags
		FROM working_memory
		ORDER BY session_id, timestamp
	`);
	const episodicStatement = db.prepare(`
		SELECT rowid, id, content, source, timestamp, session_id, importance,
			   metadata_json, summary_of, valid_until, superseded_by, scope,
			   recall_count, last_recalled, created_at, veracity, memory_type,
			   author_id, author_type, channel_id, trust_tier,
			   event_date, event_date_precision, temporal_tags
		FROM episodic_memory
		ORDER BY session_id, timestamp
	`);
	const scratchpadStatement = db.prepare(`
		SELECT id, content, session_id, created_at, updated_at
		FROM scratchpad
		ORDER BY session_id, updated_at
	`);
	const consolidationStatement = db.prepare(`
		SELECT id, session_id, items_consolidated, summary_preview, created_at
		FROM consolidation_log
		ORDER BY session_id, created_at
	`);
	return {
		mnemopi_export: {
			version: "1.0",
			export_date: toUtcIso(),
			source_db: beam.dbPath ?? ":memory:",
			component: "beam",
		},
		working_memory: workingStatement.all(),
		episodic_memory: episodicStatement.all(),
		episodic_embeddings: [],
		scratchpad: scratchpadStatement.all(),
		consolidation_log: consolidationStatement.all(),
	};
}

export function importFromDict(beam: BeamMemoryState, data: Record<string, unknown>, force = false): ImportStats {
	const stats = {
		working_memory: { inserted: 0, skipped: 0, overwritten: 0 },
		episodic_memory: { inserted: 0, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
		scratchpad: { inserted: 0, updated: 0 },
		consolidation_log: { inserted: 0 },
	} satisfies ImportStats;
	const db: BeamMemoryState["db"] = beam.db;
	// Imported working-memory rows are durable, not scratch: stamp any that
	// arrive unconsolidated so the TTL trim never discards a restored bank
	// (issue #4819).
	const importedAt = toUtcIso();

	transaction(db, () => {
		for (const raw of Array.isArray(data.working_memory) ? data.working_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = db.prepare("SELECT 1 FROM working_memory WHERE id = ?").get(id) !== null;
			if (exists && !force) {
				stats.working_memory.skipped++;
				continue;
			}
			if (exists) {
				db.run("DELETE FROM working_memory WHERE id = ?", [id]);
				purgeWorkingMemoryArtifacts(db, [id]);
				stats.working_memory.overwritten++;
			} else {
				stats.working_memory.inserted++;
			}
			db.run(
				`
				INSERT INTO working_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, consolidated_at, memory_type, embed_text, author_id, author_type, channel_id,
				 trust_tier, event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.source, null),
					sqlBinding(item.timestamp, null),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.importance, 0.5),
					sqlBinding(item.metadata_json, "{}"),
					sqlBinding(item.valid_until, null),
					sqlBinding(item.superseded_by, null),
					sqlBinding(item.scope, "session"),
					sqlBinding(item.recall_count, 0),
					sqlBinding(item.last_recalled, null),
					sqlBinding(item.created_at, null),
					clampVeracity(item.veracity),
					item.consolidated_at == null ? importedAt : sqlBinding(item.consolidated_at, importedAt),
					sqlBinding(item.memory_type, "unknown"),
					sqlBinding(item.embed_text, null),
					sqlBinding(item.author_id, null),
					sqlBinding(item.author_type, null),
					sqlBinding(item.channel_id, null),
					sqlBinding(item.trust_tier, "STATED"),
					sqlBinding(item.event_date, null),
					sqlBinding(item.event_date_precision, "unknown"),
					sqlBinding(item.temporal_tags, "[]"),
				],
			);
		}

		for (const raw of Array.isArray(data.episodic_memory) ? data.episodic_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = db.prepare("SELECT 1 FROM episodic_memory WHERE id = ?").get(id) !== null;
			if (exists && !force) {
				stats.episodic_memory.skipped++;
				continue;
			}
			if (exists) {
				db.run("DELETE FROM episodic_memory WHERE id = ?", [id]);
				stats.episodic_memory.overwritten++;
			} else {
				stats.episodic_memory.inserted++;
			}
			db.run(
				`
				INSERT INTO episodic_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 summary_of, valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, memory_type, author_id, author_type, channel_id, trust_tier,
				 event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.source, null),
					sqlBinding(item.timestamp, null),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.importance, 0.5),
					sqlBinding(item.metadata_json, "{}"),
					sqlBinding(item.summary_of, ""),
					sqlBinding(item.valid_until, null),
					sqlBinding(item.superseded_by, null),
					sqlBinding(item.scope, "session"),
					sqlBinding(item.recall_count, 0),
					sqlBinding(item.last_recalled, null),
					sqlBinding(item.created_at, null),
					clampVeracity(item.veracity),
					sqlBinding(item.memory_type, "unknown"),
					sqlBinding(item.author_id, null),
					sqlBinding(item.author_type, null),
					sqlBinding(item.channel_id, null),
					sqlBinding(item.trust_tier, "STATED"),
					sqlBinding(item.event_date, null),
					sqlBinding(item.event_date_precision, "unknown"),
					sqlBinding(item.temporal_tags, "[]"),
				],
			);
		}

		for (const raw of Array.isArray(data.scratchpad) ? data.scratchpad : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = db.prepare("SELECT 1 FROM scratchpad WHERE id = ?").get(id) !== null;
			if (exists) {
				db.run("UPDATE scratchpad SET content = ?, session_id = ?, created_at = ?, updated_at = ? WHERE id = ?", [
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
					id,
				]);
				stats.scratchpad.updated++;
			} else {
				db.run("INSERT INTO scratchpad (id, content, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
				]);
				stats.scratchpad.inserted++;
			}
		}

		for (const raw of Array.isArray(data.consolidation_log) ? data.consolidation_log : []) {
			const item = jsonObject(raw);
			db.run(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
				[
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.items_consolidated, 0),
					sqlBinding(item.summary_preview, ""),
					sqlBinding(item.created_at, null),
				],
			);
			stats.consolidation_log.inserted++;
		}
	});
	return stats;
}

// Re-exported for callers that need the normalized metadata of a stored row.
export { normalizeMetadata };
