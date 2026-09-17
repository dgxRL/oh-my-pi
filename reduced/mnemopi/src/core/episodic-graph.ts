/**
 * Reduced port of packages/mnemopi/src/core/episodic-graph.ts.
 * Keeps only what consolidation needs: the gists/graph_edges tables, gist
 * extraction (id = `gist_<memoryId>`, first-sentence summary), the ctx edge
 * memory→gist, and lexical "related_to"/"ctx" linking between existing
 * memories. Dropped: entity/fact extraction into `facts` (the `facts` table
 * itself still exists — beam schema owns it), entity/temporal overlap scores,
 * traversal APIs.
 */
import type { Database } from "bun:sqlite";
import { openDatabase, type DatabasePath } from "../db";

const DEFAULT_LINK_THRESHOLD = 0.35;

export interface EpisodicGraphOptions {
	readonly db?: Database;
	readonly dbPath?: DatabasePath;
}

export interface IngestOptions {
	readonly sessionId?: string;
	readonly linkExisting?: boolean;
	readonly minLinkScore?: number;
	readonly extractEntities?: boolean;
}

export interface IngestResult {
	readonly memoryId: string;
	readonly gistId: string;
	readonly edges: number;
}

interface EdgeInsert {
	source: string;
	target: string;
	edgeType: string;
	weight: number;
	timestamp: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function contentTokenSet(text: string): Set<string> {
	const out = new Set<string>();
	for (const match of text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)) {
		const token = match[0] ?? "";
		if (token.length >= 3) out.add(token);
	}
	return out;
}

function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const item of left) if (right.has(item)) intersection += 1;
	const union = left.size + right.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

export class EpisodicGraph {
	readonly db: Database;
	readonly dbPath: DatabasePath;
	readonly ownsConnection: boolean;

	constructor(options: EpisodicGraphOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.db = options.db ?? openDatabase(this.dbPath);
		this.ownsConnection = options.db === undefined;
		this.initTables();
	}

	private initTables(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS gists (
				id TEXT PRIMARY KEY,
				text TEXT NOT NULL,
				timestamp TEXT,
				participants_json TEXT,
				location TEXT,
				emotion TEXT,
				time_scope TEXT,
				memory_id TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS graph_edges (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				target TEXT NOT NULL,
				edge_type TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				timestamp TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(source, target, edge_type)
			)
		`);
		this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type)");
	}

	private createSummary(content: string): string {
		const firstSentence = content.split(/[.!?]+/, 1)[0]?.trim() ?? "";
		if (firstSentence.length > 10) return firstSentence.slice(0, 100);
		return content.slice(0, 100).trim();
	}

	private storeGist(gistId: string, text: string, memoryId: string): void {
		this.db.run(
			`INSERT OR REPLACE INTO gists
				(id, text, timestamp, participants_json, location, emotion, time_scope, memory_id)
			 VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
			[gistId, text, nowIso(), memoryId],
		);
	}

	private addEdge(edge: EdgeInsert): void {
		this.db.run(
			`INSERT INTO graph_edges (source, target, edge_type, weight, timestamp)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(source, target, edge_type) DO UPDATE SET
				weight = excluded.weight,
				timestamp = excluded.timestamp`,
			[edge.source, edge.target, edge.edgeType, Math.max(0, Math.min(1, edge.weight)), edge.timestamp],
		);
	}

	private knownMemoryIds(exclude: string): string[] {
		const rows = this.db
			.query("SELECT DISTINCT memory_id FROM gists WHERE memory_id IS NOT NULL AND memory_id != ?")
			.all(exclude) as Array<{ memory_id: string | null }>;
		return rows.map(row => row.memory_id).filter((id): id is string => id !== null);
	}

	private memoryContent(memoryId: string): string {
		try {
			const working = this.db.query("SELECT content FROM working_memory WHERE id = ?").get(memoryId) as
				| { content: string }
				| null;
			if (working !== null) return working.content;
			const episodic = this.db.query("SELECT content FROM episodic_memory WHERE id = ?").get(memoryId) as
				| { content: string }
				| null;
			return episodic?.content ?? "";
		} catch {
			return "";
		}
	}

	ingestMemory(content: string, memoryId: string, options: IngestOptions = {}): IngestResult {
		const linkExisting = options.linkExisting ?? true;
		const minLinkScore = options.minLinkScore ?? DEFAULT_LINK_THRESHOLD;
		const gistId = `gist_${memoryId}`;
		const timestamp = nowIso();
		this.storeGist(gistId, this.createSummary(content), memoryId);
		this.addEdge({ source: memoryId, target: gistId, edgeType: "ctx", weight: 1, timestamp });

		let edgeCount = 1;
		if (linkExisting) {
			const sourceTokens = contentTokenSet(content);
			for (const otherId of this.knownMemoryIds(memoryId)) {
				const lexicalScore = Math.round(jaccard(sourceTokens, contentTokenSet(this.memoryContent(otherId))) * 1000) / 1000;
				if (lexicalScore >= minLinkScore) {
					this.addEdge({ source: memoryId, target: otherId, edgeType: "related_to", weight: lexicalScore, timestamp });
					this.addEdge({ source: memoryId, target: otherId, edgeType: "ctx", weight: lexicalScore, timestamp });
					edgeCount += 2;
				}
			}
		}
		return { memoryId, gistId, edges: edgeCount };
	}

	getStats(): { gists: number; edges: number } {
		const gists = (this.db.query("SELECT COUNT(*) AS count FROM gists").get() as { count: number }).count;
		const edges = (this.db.query("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number }).count;
		return { gists, edges };
	}

	close(): void {
		if (this.ownsConnection) this.db.close();
	}
}
