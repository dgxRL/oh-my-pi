// Ported from packages/mnemopi/src/core/token-counter.ts
// Flat estimate: the reduced copy carries no per-model pricing tables.
const DEFAULT_RATE_PER_1M = 3.0;

export interface CostEstimate {
	tokens: number;
	model: string;
	cost_usd: number;
	rate_per_1m: number;
}

export function estimateTokens(text: string, _model = "default"): number {
	if (text.length === 0) return 0;
	return Math.floor(text.length / 4);
}
export function estimateCost(tokens: number, model = "default"): CostEstimate {
	const rate = DEFAULT_RATE_PER_1M;
	const cost = (tokens / 1_000_000) * rate;
	return {
		tokens,
		model,
		cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
		rate_per_1m: rate,
	};
}
