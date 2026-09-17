/** Reduced port of packages/mnemopi/src/config.ts — only knobs the reduced modules use. */
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
export const DEFAULT_EMBEDDING_API_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_DATA_DIR = join(homedir(), ".omp", "reduced-mnemopi", "data");

export function dataDir(env: Env = process.env): string {
	return env.MNEMOPI_DATA_DIR || DEFAULT_DATA_DIR;
}

export function dbPath(env: Env = process.env): string {
	return join(dataDir(env), "mnemopi.db");
}

function envFloat(name: string, fallback: number, env: Env = process.env): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function envInt(name: string, fallback: number, env: Env = process.env): number {
	return Math.trunc(envFloat(name, fallback, env));
}

function envString(name: string, fallback: string, env: Env = process.env): string {
	return env[name] ?? fallback;
}

export function embeddingModel(env: Env = process.env): string {
	return envString("MNEMOPI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL, env);
}

export function embeddingApiKey(env: Env = process.env): string {
	return envString(
		"MNEMOPI_EMBEDDING_API_KEY",
		envString("OPENROUTER_API_KEY", envString("OPENAI_API_KEY", "", env), env),
		env,
	);
}

export function embeddingApiUrl(env: Env = process.env): string {
	return envString("MNEMOPI_EMBEDDING_API_URL", envString("OPENROUTER_BASE_URL", DEFAULT_EMBEDDING_API_URL, env), env);
}

export function embeddingsDisabled(env: Env = process.env): boolean {
	return env.MNEMOPI_NO_EMBEDDINGS !== undefined && env.MNEMOPI_NO_EMBEDDINGS !== "";
}

export function maxEpisodeChars(env: Env = process.env): number {
	return Math.max(1, envInt("MNEMOPI_MAX_EPISODE_CHARS", 100_000, env));
}

export function scratchpadMaxItems(env: Env = process.env): number {
	return envInt("MNEMOPI_SP_MAX", 1000, env);
}

export function vectorWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_VEC_WEIGHT", 0.5, env);
}

export function ftsWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_FTS_WEIGHT", 0.3, env);
}

export function importanceWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_IMPORTANCE_WEIGHT", 0.2, env);
}
/** Normalize the hybrid recall weights to sum to 1, falling back to [0.5, 0.3, 0.2]. */
export function normalizedRecallWeights(
	vec = vectorWeight(),
	fts = ftsWeight(),
	importance = importanceWeight(),
): readonly [number, number, number] {
	const vw = Math.max(0, vec);
	const fw = Math.max(0, fts);
	const iw = Math.max(0, importance);
	const total = vw + fw + iw;
	if (total === 0) {
		return [0.5, 0.3, 0.2];
	}
	const epsilon = 1e-10;
	if (Math.abs(total - 1) < epsilon) {
		return [vw, fw, iw];
	}
	return [vw / total, fw / total, iw / total];
}

export function temporalHalflifeHours(env: Env = process.env): number {
	return envFloat("MNEMOPI_TEMPORAL_HALFLIFE_HOURS", 24, env);
}

export function tier2Days(env: Env = process.env): number {
	return envInt("MNEMOPI_TIER2_DAYS", 30, env);
}

export function tier3Days(env: Env = process.env): number {
	return envInt("MNEMOPI_TIER3_DAYS", 180, env);
}
