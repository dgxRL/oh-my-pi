/** Reduced path resolution for the stats engine — env-overridable for tests. */
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory scanned for `<project>/<file>.jsonl` session transcripts. */
export function getSessionsDir(): string {
	return process.env.OMP_SESSIONS_DIR || join(homedir(), ".omp", "agent", "sessions");
}

/** SQLite database backing the dashboard. */
export function getStatsDbPath(): string {
	return process.env.STATS_DB_PATH || join(homedir(), ".omp", "reduced-stats", "stats.db");
}

/** Config root honored for parity with the real package's tests. */
export function getConfigRootDir(): string {
	return process.env.PI_CONFIG_DIR || homedir();
}
