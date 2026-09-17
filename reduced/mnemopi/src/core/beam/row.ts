/** Shared row accessors for SQLite result rows in the beam modules. */
export type Row = Record<string, unknown>;

export function asNumber(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function asRows(value: unknown): Row[] {
	return Array.isArray(value) ? (value as Row[]) : [];
}

export function rowValue(row: Row, key: string): string | null {
	const value = row[key];
	return value == null ? null : String(value);
}

/** Shared author/type/channel WHERE-fragment builder for stats queries. */
export function scopeFilterClauses(
	authorId: string | null,
	authorType: string | null,
	channelId: string | null,
): { clauses: string[]; params: (string | null)[] } {
	const clauses: string[] = [];
	const params: (string | null)[] = [];
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
	return { clauses, params };
}
