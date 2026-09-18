/** Reduced port of packages/stats/src/index.ts — CLI entry: sync once, print summary, or serve. */
import { parseArgs } from "node:util";
import { getDashboardStats, getTotalMessageCount, syncAllSessions } from "./aggregator";
import { closeDb } from "./db";
import { formatStatsDashboardUrl, startServer } from "./server";
import type { AggregatedStats, SyncProgress } from "./types";

export {
	getDashboardStats,
	getOverviewStats,
	getToolDashboardStats,
	getTotalMessageCount,
	smokeTestSyncWorker,
	syncAllSessions,
} from "./aggregator";
export { closeDb, initDb } from "./db";
export { formatStatsDashboardUrl, startServer } from "./server";
export { classifyAgentType, extractFolderFromPath, matchesSessionFile, parseSessionFile, resolveUsageTotal } from "./parser";

/** Format a cost estimate in dollars. */
function formatCost(n: number): string {
	return `$${n.toFixed(2)}`;
}

/** Print the console summary shown by `omp-stats --summary`-style runs. */
export async function printStats(): Promise<void> {
	const stats = await getDashboardStats();
	const overall = stats.overall;
	console.log("=== Stats Summary ===");
	console.log(
		`Total requests: ${overall.totalRequests} (${overall.failedRequests} failed, ${(overall.errorRate * 100).toFixed(1)}% error rate)`,
	);
	console.log(
		`Total tokens: ${overall.totalTokens.toLocaleString()} (input ${overall.totalInputTokens.toLocaleString()}, output ${overall.totalOutputTokens.toLocaleString()})`,
	);
	console.log(`Estimated cost: ${formatCost(overall.totalCost)}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`Avg tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}
	if (overall.avgTtft !== null) {
		console.log(`Avg TTFT: ${Math.round(overall.avgTtft)}ms`);
	}
	console.log(`Messages stored: ${await getTotalMessageCount()}`);
	console.log("\nBy model:");
	for (const model of stats.byModel.slice(0, 10)) {
		console.log(
			`  ${model.model}: ${model.totalRequests} requests, ${model.totalTokens.toLocaleString()} tokens, ${formatCost(model.totalCost)}`,
		);
	}
}

/** Parsed arguments for the standalone entry point. */
export interface StandaloneStatsArgs {
	port: number;
	host: string;
	json: boolean;
	sync: boolean;
	help: boolean;
}

/** Parse the standalone arguments used by the production entry point. */
export function parseStandaloneStatsArgs(args: string[]): StandaloneStatsArgs {
	const parsed = parseArgs({
		args,
		options: {
			port: { type: "string", default: "3847" },
			host: { type: "string", default: "127.0.0.1" },
			json: { type: "boolean", default: false },
			sync: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});
	return {
		port: Number(parsed.values.port) || 3847,
		host: parsed.values.host ?? "127.0.0.1",
		json: parsed.values.json ?? false,
		sync: parsed.values.sync ?? false,
		help: parsed.values.help ?? false,
	};
}

function onSyncProgress(progress: SyncProgress): void {
	process.stderr.write(`\rSyncing ${progress.current}/${progress.total} files...`);
}

async function syncOnce(): Promise<void> {
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: onSyncProgress });
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);
}

async function main(): Promise<void> {
	const args = parseStandaloneStatsArgs(process.argv.slice(2));
	if (args.help) {
		console.log("Usage: omp-stats [--port N] [--host H] [--json] [--sync]");
		console.log("  --port N    dashboard port (default 3847)");
		console.log("  --host H    bind host (default 127.0.0.1, loopback-only)");
		console.log("  --json      print summary as JSON and exit");
		console.log("  --sync      sync once and exit (no dashboard)");
		process.exit(0);
	}
	await syncOnce();
	if (args.sync) {
		closeDb();
		return;
	}
	if (args.json) {
		console.log(JSON.stringify(await getDashboardStats(), null, 2));
		closeDb();
		return;
	}
	const server = startServer({ port: args.port, host: args.host });
	console.log(`Stats dashboard: ${formatStatsDashboardUrl(args.host, args.port)}`);
	console.log("Press Ctrl+C to stop");
	const stopped = Promise.withResolvers<void>();
	process.on("SIGINT", () => {
		server.stop(true);
		closeDb();
		stopped.resolve();
	});
	await stopped.promise;
}

// Run if executed directly.
if (import.meta.main) {
	main();
}

// Keep AggregatedStats referenced for consumers typing the summary.
export type { AggregatedStats };
