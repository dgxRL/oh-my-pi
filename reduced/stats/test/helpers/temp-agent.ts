/** Reduced test isolation: point sessions + stats db at a fresh temp dir per test. */
import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb } from "../../src/db";

const SNAPSHOT_KEYS = ["OMP_SESSIONS_DIR", "STATS_DB_PATH", "PI_CONFIG_DIR"] as const;

let activeTempDir: string | null = null;
const savedEnv = new Map<string, string | undefined>();

/** TempDir-like facade so tests can compose paths under the isolation root. */
export interface IsolationTempDir {
	path(): string;
	join(...segments: string[]): string;
}

/** The temp dir backing the current test, or null between tests. */
export function currentTestTempDir(): IsolationTempDir | null {
	return activeTempDir === null ? null : facadeFor(activeTempDir);
}

function facadeFor(dir: string): IsolationTempDir {
	return {
		path: () => dir,
		join: (...segments: string[]) => path.join(dir, ...segments),
	};
}

/**
 * Registers per-file isolation hooks. Called at each test file's module scope —
 * bun binds hooks to the calling file, so every importing file gets its own
 * fresh temp dir and env snapshot.
 */
export function installStatsTestIsolation(_prefix: string): { current(): IsolationTempDir | null } {
	beforeEach(() => {
		activeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-reduced-"));
		for (const key of SNAPSHOT_KEYS) {
			savedEnv.set(key, process.env[key]);
		}
		process.env.OMP_SESSIONS_DIR = path.join(activeTempDir, "sessions");
		process.env.STATS_DB_PATH = path.join(activeTempDir, "stats.db");
		process.env.PI_CONFIG_DIR = path.join(activeTempDir, "config");
	});

	afterEach(async () => {
		closeDb();
		if (activeTempDir !== null) {
			await fsPromises.rm(activeTempDir, { recursive: true, force: true });
		}
		activeTempDir = null;
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		savedEnv.clear();
	});

	return { current: () => currentTestTempDir() };
}
