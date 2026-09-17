/** Reduced port of packages/mnemopi/src/core/runtime-options.ts — AsyncLocalStorage runtime scope. */
import { AsyncLocalStorage } from "node:async_hooks";

export type EmbeddingOutput = AsyncIterable<number[][]>;

export interface MnemopiEmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface MnemopiEmbeddingRuntimeOptions {
	provider?: MnemopiEmbeddingProvider | ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>);
	model?: string;
	apiUrl?: string;
	apiKey?: string;
	disabled?: boolean;
	maxInputChars?: number;
}

export interface MnemopiRuntimeOptions {
	embeddings?: MnemopiEmbeddingRuntimeOptions;
	debug?: boolean;
}

export type ResolvedMnemopiRuntimeOptions = MnemopiRuntimeOptions;

const runtimeOptionsStorage = new AsyncLocalStorage<MnemopiRuntimeOptions>();

export function withMnemopiRuntimeOptions<T>(
	options: ResolvedMnemopiRuntimeOptions | undefined,
	fn: () => T,
): T {
	if (options === undefined) return fn();
	return runtimeOptionsStorage.run(options, fn);
}

export function getMnemopiRuntimeOptions(): MnemopiRuntimeOptions | undefined {
	return runtimeOptionsStorage.getStore();
}

/** Whether the active runtime scope requested verbose diagnostics. */
export function mnemopiDebugEnabled(): boolean {
	return runtimeOptionsStorage.getStore()?.debug === true;
}

export function resolveEmbeddingProvider(
	provider:
		| MnemopiEmbeddingProvider
		| ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>)
		| undefined,
): MnemopiEmbeddingProvider | undefined {
	if (provider === undefined) return undefined;
	if (typeof provider === "function") return { embed: provider };
	return provider;
}
