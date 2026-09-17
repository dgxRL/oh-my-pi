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
	cjkFtsTerms,
	containsSpacelessCjk,
	factMatchTokens,
	ftsQueryTerms,
	hasCjk,
	isCjkChar,
	RECALL_SYNONYMS,
	recallTokens,
} from "../../util/regex";
import { buildExactVectorIndex, searchExactVectorIndex } from "../vector-index";
import type { BeamMemoryState, JsonValue, Metadata } from "./types";

export { generateId, generateStableId };
export { cjkFtsTerms, containsSpacelessCjk, ftsQueryTerms, recallTokens, sha256Hex16 };

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

export interface FtsRankResult {
	rowid: number;
	rank: number;
}

export interface WorkingFtsRankResult {
	id: string;
	rank: number;
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
	const queryCjk = new Set(Array.from(queryLower).filter(isCjkChar));
	if (queryTokens.length === 0 && queryCjk.size === 0) return 0;

	const contentTokens = new Set(recallTokens(contentLower));
	for (const token of Array.from(contentTokens)) {
		for (const part of token.split(SPLIT_TOKEN_RE)) {
			if (part.length >= 3 && FACT_MATCH_STOPWORDS[part] !== true && !/^\d+$/.test(part)) contentTokens.add(part);
		}
	}
	if (contentTokens.size === 0 && queryCjk.size === 0) return 0;

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
	if (score === 0 && queryCjk.size > 0) {
		const contentCjk = new Set(Array.from(contentLower).filter(isCjkChar));
		let overlap = 0;
		for (const ch of queryCjk) if (contentCjk.has(ch)) overlap += 1;
		score = overlap / queryCjk.size;
	}
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

function cjkCharsForSearch(query: string): string[] {
	return Array.from(new Set(Array.from(query).filter(isCjkChar))).sort();
}

export function cjkLikeSearch(
	db: Database,
	query: string,
	k = 20,
	working = false,
): Array<FtsRankResult | WorkingFtsRankResult> {
	const cjkChars = cjkCharsForSearch(query);
	if (cjkChars.length === 0) return [];
	const table = working ? "working_memory" : "episodic_memory";
	const idColumn = working ? "id" : "rowid";
	const conditions = cjkChars.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
	const rows = db
		.query(
			`SELECT ${idColumn}, content FROM ${table} WHERE superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?)
			   AND (${conditions}) LIMIT ?`,
		)
		.all(new Date().toISOString(), ...cjkChars.map(ch => `%${ch}%`), k * 5) as Record<string, unknown>[];
	const scored: Array<{ id: string | number; score: number }> = [];
	for (const row of rows) {
		const content = String(row.content ?? "");
		let hits = 0;
		for (const ch of cjkChars) if (content.includes(ch)) hits += 1;
		const score = hits / Math.max(cjkChars.length, 1);
		if (score > 0) scored.push({ id: row[idColumn] as string | number, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored
		.slice(0, Math.max(0, Math.trunc(k)))
		.map(row =>
			working ? { id: String(row.id), rank: -row.score } : { rowid: Number(row.id), rank: -row.score },
		);
}

export function ftsSearch(db: Database, query: string, k = 20): FtsRankResult[] {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return hasCjk(query) ? (cjkLikeSearch(db, query, k, false) as FtsRankResult[]) : [];
	const rows = db
		.query(
			`SELECT f.rowid, f.rank FROM fts_episodes f
			 WHERE f.fts_episodes MATCH ?
			   AND EXISTS (SELECT 1 FROM episodic_memory e WHERE e.rowid = f.rowid AND e.superseded_by IS NULL
		       AND (e.valid_until IS NULL OR e.valid_until > ?))
			 ORDER BY f.rank, f.rowid LIMIT ?`,
		)
		.all(ftsQuery, new Date().toISOString(), k) as Record<string, unknown>[];
	if (rows.length === 0 && hasCjk(query)) return cjkLikeSearch(db, query, k, false) as FtsRankResult[];
	return rows.map(row => ({ rowid: Number(row.rowid), rank: Number(row.rank) }));
}

export function ftsSearchWorking(db: Database, query: string, k = 20): WorkingFtsRankResult[] {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return hasCjk(query) ? (cjkLikeSearch(db, query, k, true) as WorkingFtsRankResult[]) : [];
	const rows = db
		.query(
			`SELECT f.id, f.rank FROM fts_working f
			 WHERE f.fts_working MATCH ?
			   AND EXISTS (SELECT 1 FROM working_memory w WHERE w.id = f.id AND w.superseded_by IS NULL
			       AND (w.valid_until IS NULL OR w.valid_until > ?))
			 ORDER BY f.rank, f.id LIMIT ?`,
		)
		.all(ftsQuery, new Date().toISOString(), k) as Record<string, unknown>[];
	if (rows.length === 0 && hasCjk(query)) return cjkLikeSearch(db, query, k, true) as WorkingFtsRankResult[];
	return rows.map(row => ({ id: String(row.id), rank: Number(row.rank) }));
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

export function detectLanguage(text: string): string {
	if (!text) return "en";
	const lower = text.toLowerCase();
	const cyrillic = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";
	let russianChars = 0;
	for (const ch of lower) if (cyrillic.includes(ch)) russianChars += 1;
	if (russianChars >= 5) return "ru";
	if (russianChars >= 2 && intersectionCount(words(lower), RU_MARKERS) >= 2) return "ru";
	if (["ä", "ö", "ü", "ß"].some(ch => lower.includes(ch))) return "de";
	if (intersectionCount(words(lower), GERMAN_MARKERS) >= 2) return "de";
	if (["ñ", "á", "é", "í", "ó", "ú", "ü", "¿", "¡"].some(ch => lower.includes(ch))) return "es";
	if (intersectionCount(words(lower), SPANISH_MARKERS) >= 2) return "es";
	if (["à", "è", "é", "ì", "ò", "ù"].some(ch => lower.includes(ch))) {
		if (intersectionCount(words(lower), ITALIAN_MARKERS) >= 2) return "it";
	}
	return "en";
}

const RU_MARKERS: Record<string, true> = {
	я: true,
	ты: true,
	он: true,
	она: true,
	оно: true,
	мы: true,
	вы: true,
	они: true,
	не: true,
	на: true,
	в: true,
	с: true,
	по: true,
	для: true,
	что: true,
	как: true,
	это: true,
	так: true,
	но: true,
	да: true,
	нет: true,
	уже: true,
	ещё: true,
	мой: true,
	твой: true,
	наш: true,
	ваш: true,
	этот: true,
	тот: true,
};

const GERMAN_MARKERS: Record<string, true> = {
	ich: true,
	du: true,
	wir: true,
	ist: true,
	nicht: true,
	für: true,
	und: true,
	der: true,
	die: true,
	das: true,
	ein: true,
	eine: true,
	kein: true,
	keine: true,
	mein: true,
	meine: true,
	dann: true,
	auch: true,
	immer: true,
	nie: true,
	niemals: true,
	mag: true,
	will: true,
	möchte: true,
	kann: true,
	kannst: true,
	können: true,
	habe: true,
	hast: true,
	hat: true,
	haben: true,
	bin: true,
	bist: true,
	sind: true,
	seid: true,
	einen: true,
	einer: true,
	eines: true,
	dem: true,
	den: true,
	beim: true,
	zum: true,
	zur: true,
	nach: true,
	mit: true,
	von: true,
	bei: true,
	aus: true,
	auf: true,
	vor: true,
	aber: true,
	oder: true,
	weil: true,
	denn: true,
	dass: true,
	sehr: true,
	schon: true,
	noch: true,
	mal: true,
	man: true,
	nur: true,
	wenn: true,
	wie: true,
	als: true,
	doch: true,
	gerne: true,
	gern: true,
	lieber: true,
	einfach: true,
	eigentlich: true,
	vielleicht: true,
	natürlich: true,
	genau: true,
	bereits: true,
	eben: true,
};

const SPANISH_MARKERS: Record<string, true> = {
	y: true,
	de: true,
	por: true,
	con: true,
	para: true,
	que: true,
	qué: true,
	como: true,
	el: true,
	la: true,
	lo: true,
	los: true,
	las: true,
	un: true,
	una: true,
	del: true,
	este: true,
	esta: true,
	esto: true,
	ese: true,
	esa: true,
	eso: true,
	aquel: true,
	mi: true,
	mis: true,
	tu: true,
	tus: true,
	su: true,
	sus: true,
	es: true,
	está: true,
	son: true,
	hay: true,
	tiene: true,
	puede: true,
	más: true,
	no: true,
	también: true,
	si: true,
	ya: true,
	nunca: true,
	he: true,
	se: true,
	me: true,
	te: true,
	le: true,
	a: true,
	yo: true,
	ante: true,
	bajo: true,
	contra: true,
	desde: true,
	en: true,
	entre: true,
	hacia: true,
	hasta: true,
	según: true,
	sin: true,
	sobre: true,
	tras: true,
	todo: true,
	toda: true,
	cada: true,
	muy: true,
	pero: true,
	siempre: true,
	usa: true,
	hacer: true,
	antes: true,
	recuerda: true,
	evita: true,
};

const ITALIAN_MARKERS: Record<string, true> = {
	e: true,
	il: true,
	la: true,
	i: true,
	le: true,
	di: true,
	che: true,
	non: true,
	un: true,
	una: true,
	per: true,
	è: true,
	in: true,
	sono: true,
	mi: true,
	ha: true,
	ma: true,
	lo: true,
	se: true,
	su: true,
	con: true,
	da: true,
	come: true,
	questo: true,
	quello: true,
	anche: true,
	o: true,
	ho: true,
	ci: true,
	si: true,
	perché: true,
	perche: true,
	quando: true,
	chi: true,
	dove: true,
	molto: true,
	del: true,
	della: true,
	delle: true,
	dei: true,
	degli: true,
	nel: true,
	nella: true,
	sul: true,
	sulla: true,
	sui: true,
	sulle: true,
	al: true,
	alla: true,
	agli: true,
	alle: true,
};

function words(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(WORD_RE), match => match[0] ?? ""));
}

function intersectionCount(left: ReadonlySet<string>, right: Record<string, true>): number {
	let count = 0;
	for (const token of left) if (right[token] === true) count += 1;
	return count;
}
