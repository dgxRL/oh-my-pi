/**
 * Reduced port of packages/mnemopi/src/core/embeddings.ts.
 * Embedding seam: injected test providers, OpenAI-compatible HTTP endpoint,
 * and a local-model initializer hook. Dropped vs the original: fastembed/ONNX
 * loading (the reduced copy has no local model — `defaultLocalModelInitializer`
 * throws; hosts inject one via `setLocalModelInitializer`), fetch retry/auth
 * rotation, corrupt-cache quarantine heals, pi-utils logger.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type EmbeddingOutput,
	getMnemopiRuntimeOptions,
	resolveEmbeddingProvider,
	type MnemopiEmbeddingProvider,
} from "./runtime-options";

export type { EmbeddingOutput } from "./runtime-options";

export type Vector = Float32Array;
export type EmbeddingMatrix = Vector[];

export interface EmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface LocalEmbeddingModel {
	embed(texts: string[], batchSize?: number): EmbeddingOutput;
}

export type LocalModelInitOptions = {
	model: string;
	cacheDir?: string;
	showDownloadProgress?: boolean;
};

export type LocalModelInitializer = (options: LocalModelInitOptions) => Promise<LocalEmbeddingModel>;

let providerOverride: EmbeddingProvider | null = null;
let localModelInitializer: LocalModelInitializer = defaultLocalModelInitializer;
let apiCallCount = 0;

/** Tiny LRU over query -> vector (Map preserves insertion order; refresh on hit). */
const queryCache = new Map<string, Vector>();

// Provider identity table for the cache key. Each unique provider object gets a
// stable integer id so two Mnemopi instances with different providers never
// collide on the same query text. `0` = "env-default fallback".
const providerIds = new WeakMap<object, number>();
let nextProviderId = 1;

export function defaultCacheDir(): string {
	return join(homedir(), ".omp", "reduced-mnemopi", "fastembed-cache");
}

/** The real package loads fastembed here; the reduced copy has no local model. */
export async function defaultLocalModelInitializer(_options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	throw new Error("mnemopi-reduced does not bundle fastembed; inject a LocalModelInitializer for local models");
}

function activeEmbeddingOptions() {
	return getMnemopiRuntimeOptions()?.embeddings;
}

function queryCacheKey(text: string): string {
	const provider = activeEmbeddingOptions()?.provider as object | undefined;
	let providerId = 0;
	if (provider !== undefined) {
		const existing = providerIds.get(provider);
		if (existing === undefined) {
			providerId = nextProviderId++;
			providerIds.set(provider, providerId);
		} else {
			providerId = existing;
		}
	}
	return `${providerId}::${defaultModel()}::${activeEmbeddingOptions()?.apiUrl ?? ""}::${text}`;
}

function inTestRuntime(): boolean {
	return process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test";
}

export function embeddingsDisabled(): boolean {
	const active = activeEmbeddingOptions();
	if (active?.disabled !== undefined) {
		return active.disabled;
	}
	return process.env.MNEMOPI_NO_EMBEDDINGS !== undefined && process.env.MNEMOPI_NO_EMBEDDINGS !== "";
}

function embeddingApiKey(): string {
	const active = activeEmbeddingOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return process.env.MNEMOPI_EMBEDDING_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
}

function embeddingBaseUrl(): string {
	const active = activeEmbeddingOptions();
	if (active?.apiUrl !== undefined) {
		return active.apiUrl;
	}
	return process.env.MNEMOPI_EMBEDDING_API_URL || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
}

function defaultModel(): string {
	const active = activeEmbeddingOptions();
	if (active?.model !== undefined) {
		return active.model;
	}
	return process.env.MNEMOPI_EMBEDDING_MODEL || "BAAI/bge-small-en-v1.5";
}

export function currentEmbeddingModel(): string {
	return defaultModel();
}

function isOpenRouterHost(baseUrl: string): boolean {
	const host = new URL(baseUrl).hostname;
	return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

export function isApiModel(modelName: string): boolean {
	if (
		modelName.startsWith("openai/") ||
		modelName.includes("text-embedding") ||
		modelName.startsWith("text-embedding")
	) {
		return true;
	}
	const baseUrl = activeEmbeddingOptions()?.apiUrl ?? (process.env.MNEMOPI_EMBEDDING_API_URL || process.env.OPENROUTER_BASE_URL);
	if (baseUrl !== undefined && baseUrl !== "" && !isOpenRouterHost(baseUrl)) {
		return true;
	}
	return process.env.MNEMOPI_EMBEDDINGS_VIA_API === "1" || process.env.MNEMOPI_EMBEDDINGS_VIA_API === "true";
}

/** Drain an embedding stream (a custom provider) into a Float32Array matrix. */
async function collectMatrix(batches: EmbeddingOutput): Promise<EmbeddingMatrix> {
	const rows: Vector[] = [];
	for await (const batch of batches) {
		for (const row of batch) {
			rows.push(new Float32Array(row));
		}
	}
	return rows;
}

async function embedApi(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	const baseUrl = embeddingBaseUrl();
	const isCustom = !isOpenRouterHost(baseUrl);
	const apiKey = embeddingApiKey();
	if (!isCustom && apiKey === "") {
		return null;
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"user-agent": `omp/${VERSION}`,
		"http-referer": "https://omp.sh/",
		"x-openrouter-title": "omp",
		"x-openrouter-categories": "cli-agent",
	};
	if (apiKey !== "") {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: defaultModel(), input: texts }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		return null;
	}
	const { data: rows } = (await response.json()) as { data?: Array<{ embedding: number[] }> };
	if (rows === undefined) {
		return null;
	}
	apiCallCount += 1;
	return rows.map(row => new Float32Array(row.embedding));
}

const VERSION = "18.2.1"; // kept in sync with reduced/mnemopi/package.json

const KNOWN_MODEL_NAMES: Record<string, string> = {
	"BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
	"BAAI/bge-base-en-v1.5": "fast-bge-base-en-v1.5",
	"intfloat/multilingual-e5-small": "fast-multilingual-e5-small",
};

function fastembedModelName(modelName: string): string | null {
	return KNOWN_MODEL_NAMES[modelName] ?? null;
}

async function getLocalModel(): Promise<LocalEmbeddingModel | null> {
	if (isApiModel(defaultModel()) || embeddingsDisabled() || inTestRuntime()) {
		return null;
	}
	const modelName = fastembedModelName(defaultModel());
	if (modelName === null) {
		return null;
	}
	const cacheDir = defaultCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	// No promise caching: a failing initializer throws straight through; hosts
	// that need warm caching wrap their own initializer.
	return localModelInitializer({
		model: modelName,
		cacheDir,
		showDownloadProgress: false,
	});
}

async function providerAvailable(provider: EmbeddingProvider): Promise<boolean> {
	if (provider.available === undefined) {
		return true;
	}
	return await provider.available();
}

export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
	providerOverride = provider ?? null;
	queryCache.clear();
}

export const setEmbeddingProvider = setEmbeddingProviderForTests;

export function setLocalModelInitializerForTests(initializer: LocalModelInitializer | null | undefined): void {
	localModelInitializer = initializer ?? defaultLocalModelInitializer;
	queryCache.clear();
}

export const setLocalModelInitializer = setLocalModelInitializerForTests;

export function resetEmbeddingProviderForTests(): void {
	providerOverride = null;
	localModelInitializer = defaultLocalModelInitializer;
	apiCallCount = 0;
	queryCache.clear();
}

export const resetEmbeddingStateForTests = resetEmbeddingProviderForTests;

export async function available(): Promise<boolean> {
	if (embeddingsDisabled()) {
		return false;
	}
	const active = activeEmbeddingOptions();
	const activeProvider = resolveEmbeddingProvider(active?.provider);
	if (activeProvider !== undefined) {
		return providerAvailable(activeProvider);
	}
	if (providerOverride !== null) {
		return providerAvailable(providerOverride);
	}
	if (isApiModel(defaultModel())) {
		const baseUrl = active?.apiUrl ?? (process.env.MNEMOPI_EMBEDDING_API_URL || process.env.OPENROUTER_BASE_URL);
		if (baseUrl !== undefined && baseUrl !== "" && !isOpenRouterHost(baseUrl)) {
			return true;
		}
		return process.env.MNEMOPI_EMBEDDING_API_KEY !== undefined || isOpenRouterHost(embeddingBaseUrl());
	}
	if (inTestRuntime()) {
		return false;
	}
	return fastembedModelName(defaultModel()) !== null;
}

export function availableApi(): boolean {
	return embeddingApiKey() !== "";
}

export async function embedQuery(text: string): Promise<Vector | null> {
	if (text === "" || embeddingsDisabled()) {
		return null;
	}
	const key = queryCacheKey(text);
	const cached = queryCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const vectors = await embed([text]);
	const vector = vectors?.[0] ?? null;
	if (vector !== null) {
		queryCache.set(key, vector);
	}
	return vector;
}

export async function embed(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	if (texts.length === 0 || embeddingsDisabled()) {
		return null;
	}
	const activeProvider = resolveEmbeddingProvider(activeEmbeddingOptions()?.provider) ?? providerOverride ?? undefined;
	if (activeProvider !== undefined) {
		return await collectMatrix(await activeProvider.embed(texts));
	}
	if (isApiModel(defaultModel())) {
		return embedApi(texts);
	}
	if (texts.length === 1) {
		const key = queryCacheKey(texts[0] ?? "");
		const cached = queryCache.get(key);
		if (cached !== undefined) {
			return [cached];
		}
	}
	const model = await getLocalModel();
	if (model === null) {
		return null;
	}
	const vectors = await collectMatrix(model.embed([...texts]));
	if (vectors.length === 1) {
		const vector = vectors[0];
		if (vector !== undefined) {
			queryCache.set(queryCacheKey(texts[0] ?? ""), vector);
		}
	}
	return vectors;
}

export function getEmbeddingApiCallCountForTests(): number {
	return apiCallCount;
}
