import { beforeEach, describe, expect, it } from "bun:test";
import { FLAT_RATE_PER_1M, getCostTimeSeries, getMessageCount, initDb, insertMessageStats } from "../src/db";
import type { MessageStatsInput } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-cost-");

beforeEach(() => {
	initDb();
});

function makeStats(overrides: Partial<MessageStatsInput> = {}): MessageStatsInput {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId: `entry-${Math.random().toString(36).slice(2)}`,
		folder: "/tmp/project",
		model: "model-x",
		provider: "provider-x",
		api: "test-api",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2_000_000,
		},
		agentType: "main",
		...overrides,
	};
}

describe("stats cost storage (flat rate)", () => {
	it("estimates cost at the flat rate when the session recorded no price", () => {
		const inserted = insertMessageStats([makeStats()]);
		expect(inserted).toBe(1);

		const row = initDb()
			.prepare("SELECT cost_input, cost_output, cost_total FROM messages")
			.get() as { cost_input: number; cost_output: number; cost_total: number };
		expect(row.cost_input).toBeCloseTo(FLAT_RATE_PER_1M, 6);
		expect(row.cost_output).toBeCloseTo(FLAT_RATE_PER_1M, 6);
		expect(row.cost_total).toBeCloseTo(FLAT_RATE_PER_1M * 2, 6);
	});

	it("prefers the session-recorded cost over the flat estimate", () => {
		insertMessageStats([
			makeStats({
				entryId: "recorded",
				usage: {
					input: 1_000,
					output: 2_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3_000,
					cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				},
			}),
		]);

		const row = initDb()
			.prepare("SELECT cost_total, total_tokens FROM messages WHERE entry_id = 'recorded'")
			.get() as { cost_total: number; total_tokens: number };
		expect(row.cost_total).toBeCloseTo(0.03, 10);
		expect(row.total_tokens).toBe(3_000);
	});

	it("treats malformed recorded cost buckets as absent zeros", () => {
		insertMessageStats([
			makeStats({
				entryId: "garbage-cost",
				usage: {
					input: 1_000_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_000_000,
					cost: { input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN },
				},
			}),
		]);

		const row = initDb()
			.prepare("SELECT cost_total FROM messages WHERE entry_id = 'garbage-cost'")
			.get() as { cost_total: number };
		// A present-but-garbage cost object is authoritative: buckets coerce to 0.
		expect(row.cost_total).toBe(0);
	});
});

describe("stats cost time series", () => {
	it("rolls daily cost per model after ingest", async () => {
		insertMessageStats([
			makeStats({ entryId: "a", model: "model-a", provider: "p1", timestamp: Date.now() - 60_000 }),
			makeStats({ entryId: "b", model: "model-a", provider: "p1", timestamp: Date.now() - 30_000 }),
		]);

		const series = getCostTimeSeries(90);
		expect(series).toHaveLength(1);
		expect(series[0]).toMatchObject({ model: "model-a", provider: "p1", requests: 2 });
		expect(series[0].cost).toBeGreaterThan(0);
		expect(getMessageCount()).toBe(2);
	});
});
