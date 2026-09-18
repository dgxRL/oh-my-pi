/**
 * Reduced port of packages/mnemopi/src/core/beam/helpers.ts.
 * Shared math/lexical/FTS/vector utilities for the beam engine. Dropped vs the
 * original: sqlite-vec virtual-table paths (vecInsert/vecSearch/vecAvailable —
 * the reduced engine always uses the in-memory exact index over
 * `memory_embeddings` JSON), background embedding scheduling, and the binary
 * vector re-exports.
 */
import type { Database } from "bun:sqlite";
import { parseIsoDateTimeUtc, normalizeDateTimeUtc } from "../../util/datetime";
import { generateId, generateStableId, sha256Hex16 } from "../../util/ids";
import {
	FACT_MATCH_STOPWORDS,
	factMatchTokens,
	ftsQueryTerms,
	RECALL_SYNONYMS,
	recallTokens,
} from "../../util/regex";
import { buildExactVectorIndex, searchExactVectorIndex } from "../vector-index";
import type { BeamMemoryState, JsonValue, Metadata } from "./types";

export { generateId, generateStableId };
export { ftsQueryTerms, recallTokens, sha256Hex16 };

export type Vector = number[];

export type HybridWeights = readonly [vecWeight: number, ftsWeight: number, importanceWeight: number];

export interface VectorDistanceResult {
	rowid: number;
	distance: number;
}

export interface WorkingVectorResult {
	id: string;
	sim: number;
}

const DEFAULT_RECENCY_HALFLIFE_HOURS = 72;
const DEFAULT_WEIGHTS: HybridWeights = [0.5, 0.3, 0.2];
const TS_CACHE_MAX = 2000;
const moduleTimestampCache = new Map<string, Date>();

const SPLIT_TOKEN_RE = /[_:/.-]+/g;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function rowValue<T>(row: unknown, key: string): T | undefined {
	if (row && typeof row === "object" && key in row) return (row as Record<string, T>)[key];
	return undefined;
}

function timestampCacheFor(beam?: Pick<BeamMemoryState, "caches"> | null): Map<string, Date> {
	return beam?.caches?.timestampParse ?? moduleTimestampCache;
}

export function normalizeWeights(
	vecWeight: number | null | undefined,
	ftsWeight: number | null | undefined,
	importanceWeight: number | null | undefined,
): HybridWeights {
	const vw = Math.max(0, vecWeight ?? envNumber("MNEMOPI_VEC_WEIGHT", DEFAULT_WEIGHTS[0]));
	const fw = Math.max(0, ftsWeight ?? envNumber("MNEMOPI_FTS_WEIGHT", DEFAULT_WEIGHTS[1]));
	const iw = Math.max(0, importanceWeight ?? envNumber("MNEMOPI_IMPORTANCE_WEIGHT", DEFAULT_WEIGHTS[2]));
	const total = vw + fw + iw;
	if (total === 0) return DEFAULT_WEIGHTS;
	return [vw / total, fw / total, iw / total];
}

export function normalizeImportance(importance: number | null | undefined, fallback = 0.5): number {
	return clamp01(importance ?? fallback);
}

export function parseTimestampFast(
	ts: string | null | undefined,
	beam?: Pick<BeamMemoryState, "caches"> | null,
): Date | null {
	if (!ts) return null;
	const cache = timestampCacheFor(beam);
	const cached = cache.get(ts);
	if (cached !== undefined) return cached;
	const parsed = new Date(ts);
	if (Number.isNaN(parsed.getTime())) return null;
	if (cache.size >= TS_CACHE_MAX) cache.clear();
	cache.set(ts, parsed);
	return parsed;
}

export function recencyDecay(
	timestamp: string | null | undefined,
	halflifeHours = DEFAULT_RECENCY_HALFLIFE_HOURS,
	now: Date = new Date(),
): number {
	if (!timestamp) return 0.5;
	const ts = parseTimestampFast(timestamp);
	if (ts === null) return 0.5;
	const ageHours = (now.getTime() - ts.getTime()) / 3_600_000;
	return Math.exp(-ageHours / halflifeHours);
}

export function temporalBoost(
	memoryTimestamp: string | null | undefined,
	queryTime: Date | string,
	halflifeHours = 24,
	beam?: Pick<BeamMemoryState, "caches"> | null,
): number {
	const ts = parseTimestampFast(memoryTimestamp, beam);
	if (ts === null) return 0;
	const query = typeof queryTime === "string" ? parseIsoDateTimeUtc(queryTime) : normalizeDateTimeUtc(queryTime);
	const effectiveTs = ts.getTime() > query.getTime() ? query : ts;
	const hoursDelta = (query.getTime() - effectiveTs.getTime()) / 3_600_000;
	return Math.exp(-hoursDelta / halflifeHours);
}

export function lexicalRelevance(queryTokens: readonly string[], content: string, queryLower = ""): number {
	const contentLower = content.toLowerCase();
	if (queryTokens.length === 0) return 0;

	const contentTokens = new Set(recallTokens(contentLower));
	for (const token of Array.from(contentTokens)) {
		for (const part of token.split(SPLIT_TOKEN_RE)) {
			if (part.length >= 3 && FACT_MATCH_STOPWORDS[part] !== true && !/^\d+$/.test(part)) contentTokens.add(part);
		}
	}
	if (contentTokens.size === 0) return 0;

	let exact = 0;
	let partial = 0;
	for (const token of queryTokens) {
		if (contentTokens.has(token)) {
			exact += 1;
			continue;
		}
		const synonyms = RECALL_SYNONYMS[token] ?? [];
		if (synonyms.some(syn => contentTokens.has(syn))) {
			partial += 0.75;
			continue;
		}
		if (
			token.length >= 4 &&
			Array.from(contentTokens).some(
				contentToken => contentToken.length >= 4 && (token.includes(contentToken) || contentToken.includes(token)),
			)
		) {
			partial += 0.4;
		}
	}

	const fullMatch = queryLower !== "" && contentLower.includes(queryLower) ? 1 : 0;
	let score = (exact + partial + fullMatch) / Math.max(queryTokens.length, 1);
	return Math.min(score, 1);
}

export function strictFactMatches(query: string, factText: string): boolean {
	const queryLower = query.toLowerCase().trim();
	const factLower = factText.toLowerCase().trim();
	if (!queryLower || !factLower) return false;
	if (factLower.includes(queryLower)) return true;
	const queryTokens = factMatchTokens(queryLower);
	const factTokens = factMatchTokens(factLower);
	if (queryTokens.size === 0 || factTokens.size === 0) return false;
	const overlap = Array.from(queryTokens).filter(token => factTokens.has(token));
	if (overlap.length >= 2) return true;
	const token = overlap[0];
	if (token === undefined) return false;
	if (token.length >= 8 && /[./:_-]/.test(token)) return true;
	return token.length >= 5;
}

export function buildFtsQuery(query: string): string {
	return ftsQueryTerms(query).join(" OR ");
}





export function encodeVector(embedding: readonly number[]): string {
	return JSON.stringify(embedding);
}

export function decodeVector(value: string | null | undefined): Vector | null {
	if (!value) return null;
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) return null;
	const vector: number[] = [];
	for (const item of parsed) {
		if (typeof item !== "number" || !Number.isFinite(item)) return null;
		vector.push(item);
	}
	return vector;
}

export function inMemoryVecSearch(db: Database, queryEmbedding: readonly number[], k = 20): VectorDistanceResult[] {
	if (queryEmbedding.length === 0) return [];
	const rows = db
		.query(`
			SELECT em.rowid, me.memory_id, me.embedding_json
			FROM memory_embeddings me
			JOIN episodic_memory em ON me.memory_id = em.id
			LIMIT 10000
		`)
		.all() as Record<string, unknown>[];
	const index = buildExactVectorIndex(
		rows.map(row => ({ id: Number(row.rowid), vector: decodeVector(String(row.embedding_json ?? "")) })),
	);
	return searchExactVectorIndex(index, queryEmbedding, k).map(hit => ({ rowid: hit.id, distance: 1 - hit.score }));
}

export function workingMemoryVecSearch(
	db: Database,
	queryEmbedding: readonly number[],
	k = 20,
	now: Date = new Date(),
): WorkingVectorResult[] {
	if (queryEmbedding.length === 0) return [];
	const rows = db
		.query(`
			SELECT wm.id, me.embedding_json
			FROM memory_embeddings me
			JOIN working_memory wm ON me.memory_id = wm.id
			WHERE wm.superseded_by IS NULL
			  AND (wm.valid_until IS NULL OR wm.valid_until > ?)
			LIMIT 50000
		`)
		.all(now.toISOString()) as Record<string, unknown>[];
	const index = buildExactVectorIndex(
		rows.map(row => ({ id: String(row.id), vector: decodeVector(String(row.embedding_json ?? "")) })),
	);
	return searchExactVectorIndex(index, queryEmbedding, k).map(hit => ({ id: hit.id, sim: hit.score }));
}

export function normalizeMetadata(input: unknown): Metadata {
	if (input == null) return {};
	if (typeof input === "string") {
		return normalizeMetadata(JSON.parse(input) as unknown);
	}
	if (typeof input !== "object" || Array.isArray(input)) return {};
	const out: Metadata = {};
	for (const key in input) {
		const normalized = normalizeJsonValue((input as Record<string, unknown>)[key]);
		if (normalized !== undefined) out[key] = normalized;
	}
	return out;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
	if (value == null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const out: JsonValue[] = [];
		for (const item of value) {
			const normalized = normalizeJsonValue(item);
			if (normalized !== undefined) out.push(normalized);
		}
		return out;
	}
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		for (const key in value) {
			const normalized = normalizeJsonValue((value as Record<string, unknown>)[key]);
			if (normalized !== undefined) out[key] = normalized;
		}
		return out;
	}
	return undefined;
}

export function metadataJson(input: unknown): string {
	return JSON.stringify(normalizeMetadata(input));
}

export function memoryRowMetadata(row: unknown): Metadata {
	return normalizeMetadata(rowValue<unknown>(row, "metadata_json") ?? rowValue<unknown>(row, "metadata"));
}

