/**
 * Reduced port of packages/mnemopi/src/core/vector-index.ts.
 * The original delegates scoring to a native kernel (vectorIndexTopK from
 * @oh-my-pi/pi-natives); the reduced copy uses a plain TS loop with the same
 * contract: vectors are L2-normalized on insert, queries score by cosine.
 */

export interface ExactVectorSearchHit<TId> {
	id: TId;
	score: number;
}

export interface ExactVectorIndex<TId> {
	readonly ids: readonly TId[];
	readonly matrix: Float32Array;
	readonly dimensions: number;
	readonly count: number;
}

export interface VectorIndexRow<TId> {
	id: TId;
	vector: readonly number[] | null | undefined;
}

export function buildExactVectorIndex<TId>(rows: readonly VectorIndexRow<TId>[]): ExactVectorIndex<TId> {
	const valid: Array<{ id: TId; vector: readonly number[]; norm: number }> = [];
	let dimensions = 0;
	for (const row of rows) {
		const vector = row.vector;
		if (!vector || vector.length === 0) continue;
		let normSq = 0;
		for (let i = 0; i < vector.length; i += 1) {
			const value = vector[i] ?? 0;
			if (!Number.isFinite(value)) {
				normSq = 0;
				break;
			}
			normSq += value * value;
		}
		if (normSq <= 0) continue;
		valid.push({ id: row.id, vector, norm: Math.sqrt(normSq) });
		if (vector.length > dimensions) dimensions = vector.length;
	}

	const matrix = new Float32Array(valid.length * dimensions);
	const ids: TId[] = [];
	for (let row = 0; row < valid.length; row += 1) {
		const item = valid[row];
		ids.push(item.id);
		const offset = row * dimensions;
		for (let col = 0; col < item.vector.length; col += 1) {
			matrix[offset + col] = (item.vector[col] ?? 0) / item.norm;
		}
	}

	return { ids, matrix, dimensions, count: ids.length };
}

export function searchExactVectorIndex<TId>(
	index: ExactVectorIndex<TId>,
	query: readonly number[],
	limit: number,
): ExactVectorSearchHit<TId>[] {
	const k = Math.max(0, Math.trunc(limit));
	if (k === 0 || index.count === 0 || index.dimensions === 0 || query.length === 0) return [];

	let queryNormSq = 0;
	for (const value of query) {
		if (!Number.isFinite(value)) return [];
		queryNormSq += value * value;
	}
	if (queryNormSq <= 0) return [];
	const queryNorm = Math.sqrt(queryNormSq);

	const hits: ExactVectorSearchHit<TId>[] = [];
	for (let row = 0; row < index.count; row += 1) {
		let dot = 0;
		const offset = row * index.dimensions;
		for (let col = 0; col < query.length && col < index.dimensions; col += 1) {
			dot += (index.matrix[offset + col] ?? 0) * (query[col] ?? 0);
		}
		hits.push({ id: index.ids[row] as TId, score: dot / queryNorm });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, k);
}
