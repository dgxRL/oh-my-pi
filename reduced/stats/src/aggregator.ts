/**
 * Reduced port of packages/stats/src/aggregator.ts — sync orchestration plus
 * dashboard query assembly. Parsing runs inline (no worker pool in the
 * reduced copy); the whole pass is serialized by a cross-process file lock.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as fs from "node:fs/promises";
import {
	applySessionParseResult,
	completeSessionSync,
	getFileOffset,
	getOverallStats,
	getRecentErrors,
	getRecentRequests,
	getStatsByAgentType,
	getStatsByFolder,
	getStatsByModel,
	getTimeSeries,
	getToolStats,
	getToolStatsByModel,
	getToolTimeSeries,
	initDb,
	prepareSessionSync,
} from "./db";
import { getStatsDbPath } from "./paths";
import { listAllSessionFiles, matchesSessionFile, parseSessionFile } from "./parser";
import type { AggregatedStats, SyncOptions, SyncProgress, ToolDashboardPayload } from "./types";

/**
 * Serialize stats ingestion across processes with a coarse exclusive file lock
 * next to the database.
 */
export async function withStatsSyncLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${dbPath}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	const handle = await fs.open(lockPath, "wx").catch((error: { code?: string }) => {
		if (error.code === "EEXIST") {
			throw new Error(`another stats sync holds ${lockPath}`);
		}
		throw error;
	});
	try {
		return await fn();
	} finally {
		await handle.close();
		await fs.rm(lockPath, { force: true });
	}
}

/** Spawn the stateless parse worker entry. */
function spawnWorker(): Worker {
	return new Worker(new URL("./sync-worker.ts", import.meta.url), { type: "module" });
}

/** Ping one worker and terminate it — proves the worker entry actually loads. */
export async function smokeTestSyncWorker({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<void> {
	// Skip on darwin: spawning the worker there hits a native abort surface, so
	// `omp --smoke-test` stays off it (worker coverage runs on linux CI).
	if (process.platform === "darwin") return;
	const worker = spawnWorker();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error("sync worker ping timeout")), timeoutMs);
	worker.onmessage = (event: MessageEvent<{ ok: boolean; kind?: string; error?: string }>) => {
		const data = event.data;
		if (!data.ok) {
			reject(new Error(data.error));
			return;
		}
		if (data.kind !== "pong") {
			reject(new Error(`sync worker: expected pong, got ${JSON.stringify(data)}`));
			return;
		}
		resolve();
	};
	worker.onerror = (event: ErrorEvent) => {
		reject(event.error instanceof Error ? event.error : new Error(event.message || "worker error"));
	};
	worker.postMessage({ kind: "ping" });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}

/**
 * Sync every session transcript into the database. Files whose persisted
 * cursor still matches (identity, size, mtime, tail checkpoint) are skipped;
 * everything else is parsed from its stored offset.
 */
export async function syncAllSessions(opts?: SyncOptions): Promise<{ processed: number; files: number }> {
	return withStatsSyncLock(getStatsDbPath(), async () => {
		let processed = 0;
		let files = 0;
		while (true) {
			const result = await syncAllPass(opts, processed);
			processed += result.processed;
			files += result.files;
			if (!result.reconcile) return { processed, files };
		}
	});
}

/**
 * One full pass over the session directory. `reconcile` flags that a reset
 * dropped rows another forked file may still reference — the caller repeats
 * the pass so cross-file duplicates re-resolve against the new state.
 */
async function syncAllPass(
	opts: SyncOptions | undefined,
	alreadyProcessed: number,
): Promise<{ processed: number; files: number; reconcile: boolean }> {
	await initDb();
	// A pending reconciliation marker replays EVERY file fully, so forked
	// copies skipped by the cross-lineage dedup re-resolve against new state.
	const replay = prepareSessionSync();
	let reconcile = false;
	const sessionFiles = await listAllSessionFiles();
	let passProcessed = 0;
	let filesProcessed = 0;
	let completed = 0;
	const report = (sessionFile: string): void => {
		completed++;
		const progress: SyncProgress = {
			current: completed,
			total: sessionFiles.length,
			processed: alreadyProcessed + passProcessed,
			sessionFile,
		};
		opts?.onProgress?.(progress);
	};
	for (const sessionFile of sessionFiles) {
		const fileStats = await fs.stat(sessionFile).catch(() => null);
		if (!fileStats) {
			report(sessionFile);
			continue;
		}
		const stored = getFileOffset(sessionFile);
		if (
			!replay &&
			stored?.parserState &&
			stored.lastModified === fileStats.mtimeMs &&
			stored.parserState.size === fileStats.size &&
			matchesSessionFile(stored.parserState, fileStats)
		) {
			report(sessionFile);
			continue;
		}
		const unknownIdentity = stored !== null && !stored.parserState;
		const fromOffset = unknownIdentity ? 0 : (stored?.offset ?? 0);
		const result = await parseSessionFile(sessionFile, fromOffset, stored?.parserState, replay);
		if (unknownIdentity && result.parserState) result.reset = true;
		const applied = applySessionParseResult(sessionFile, result, replay || !stored?.parserState);
		if (applied.reconcile) reconcile = true;
		if (applied.processed > 0) {
			passProcessed += applied.processed;
			filesProcessed++;
		}
		report(sessionFile);
	}
	completeSessionSync(reconcile);
	if (reconcile) console.error(String.raw`[dbg] pass flagged reconcile`);
	return { processed: passProcessed, files: filesProcessed, reconcile };
}

function getTimeRangeConfig(range?: string | null): { cutoff?: number; hours: number } {
	const now = Date.now();
	switch (range) {
		case "1h":
			return { cutoff: now - 1 * 60 * 60 * 1000, hours: 1 };
		case "24h":
			return { cutoff: now - 24 * 60 * 60 * 1000, hours: 24 };
		case "7d":
			return { cutoff: now - 7 * 24 * 60 * 60 * 1000, hours: 24 * 7 };
		case "30d":
			return { cutoff: now - 30 * 24 * 60 * 60 * 1000, hours: 24 * 30 };
		case "90d":
			return { cutoff: now - 90 * 24 * 60 * 60 * 1000, hours: 24 * 90 };
		case 'all':
			return { hours: 24 };
		default:
			// Unknown ranges fall back to the 24h default (never "all").
			return { cutoff: now - 24 * 60 * 60 * 1000, hours: 24 };
	}
}

/** Overall + per-model + per-folder + agent-type + time series in one payload. */
export async function getDashboardStats(range?: string | null): Promise<AggregatedStats> {
	await initDb();
	const { cutoff, hours } = getTimeRangeConfig(range);
	return {
		overall: getOverallStats(cutoff),
		byModel: getStatsByModel(cutoff),
		byFolder: getStatsByFolder(cutoff),
		byAgentType: getStatsByAgentType(cutoff),
		timeSeries: getTimeSeries(hours, cutoff ?? null),
		recentRequests: getRecentRequests(100),
		recentErrors: getRecentErrors(50, cutoff ?? null),
	};
}

export async function getOverviewStats(
	range?: string | null,
): Promise<Pick<AggregatedStats, "overall" | "byAgentType" | "timeSeries">> {
	await initDb();
	const { cutoff, hours } = getTimeRangeConfig(range);
	return {
		overall: getOverallStats(cutoff),
		byAgentType: getStatsByAgentType(cutoff),
		timeSeries: getTimeSeries(hours, cutoff ?? null),
	};
}

export async function getFolderStats(range?: string | null) {
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	return getStatsByFolder(cutoff);
}

/** Tool dashboard payload: per-tool totals, per-(tool, model) breakdown, per-tool series. */
export async function getToolDashboardStats(range?: string | null): Promise<ToolDashboardPayload> {
	await initDb();
	const { cutoff, hours } = getTimeRangeConfig(range);
	return {
		byTool: getToolStats(cutoff),
		byToolModel: getToolStatsByModel(cutoff),
		series: getToolTimeSeries(hours, cutoff ?? null),
	};
}

export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	const row = initDb().prepare("SELECT COUNT(*) as total FROM messages").get() as { total: number };
	return row.total;
}

export async function getErrorsForApi(limit = 50, range?: string | null) {
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	return getRecentErrors(limit, cutoff ?? null);
}
