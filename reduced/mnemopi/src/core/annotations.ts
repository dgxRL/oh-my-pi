/** Reduced port of packages/mnemopi/src/core/annotations.ts — minimal annotation writer. */
import type { Database } from "bun:sqlite";

export class AnnotationStore {
	readonly db: Database;

	constructor(options: { db: Database }) {
		this.db = options.db;
	}

	add(memoryId: string, kind: string, value: string, source?: string, confidence?: number): void {
		this.db.run(
			`INSERT OR IGNORE INTO annotations (memory_id, kind, value, source, confidence) VALUES (?, ?, ?, ?, ?)`,
			[memoryId, kind, value, source ?? null, confidence ?? 1.0],
		);
	}

	addMany(memoryId: string, kind: string, values: readonly string[], source?: string, confidence?: number): void {
		for (const value of values) this.add(memoryId, kind, value, source, confidence);
	}

	queryByMemory(memoryId: string, kind?: string): Array<{ kind: string; value: string }> {
		if (kind !== undefined) {
			return this.db
				.query("SELECT kind, value FROM annotations WHERE memory_id = ? AND kind = ?")
				.all(memoryId, kind) as Array<{ kind: string; value: string }>;
		}
		return this.db.query("SELECT kind, value FROM annotations WHERE memory_id = ?").all(memoryId) as Array<{
			kind: string;
			value: string;
		}>;
	}

	queryByKind(kind: string, options?: { value?: string }): Array<{ memory_id: string; value: string }> {
		if (options?.value !== undefined) {
			return this.db
				.query("SELECT memory_id, value FROM annotations WHERE kind = ? AND value = ?")
				.all(kind, options.value) as Array<{ memory_id: string; value: string }>;
		}
		return this.db.query("SELECT memory_id, value FROM annotations WHERE kind = ?").all(kind) as Array<{
			memory_id: string;
			value: string;
		}>;
	}

	getDistinctValues(kind: string): string[] {
		const rows = this.db
			.query("SELECT DISTINCT value FROM annotations WHERE kind = ? ORDER BY value")
			.all(kind) as Array<{ value: string }>;
		return rows.map(row => row.value);
	}
}
