/** Reduced port of packages/mnemopi/src/db.ts — database open + transaction helpers. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type DatabasePath = string | ":memory:";

export type SqlitePageSize = number | "os";

export interface OpenDatabaseOptions {
	readonly create?: boolean;
	readonly readwrite?: boolean;
	readonly strict?: boolean;
	readonly pragmas?: boolean;
	readonly pageSize?: SqlitePageSize;
	readonly loadExtension?: string | readonly string[];
}

interface TxState {
	depth: number;
}

const TX_STATE = Symbol("mnemopi.txState");

type TxDatabase = Database & { [TX_STATE]?: TxState };
type ExtensionDatabase = Database & { loadExtension(path: string): void };

export function openDatabase(path: DatabasePath = ":memory:", options: OpenDatabaseOptions = {}): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, {
		create: options.create ?? true,
		readwrite: options.readwrite ?? true,
		strict: options.strict ?? true,
	});
	if (options.pragmas !== false) enablePragmas(db, path, options.pageSize);
	else if (options.readwrite !== false) applyPageSize(db, path, options.pageSize);
	if (options.loadExtension !== undefined) loadExtensions(db, options.loadExtension);
	return db;
}

export function enablePragmas(db: Database, path?: DatabasePath, pageSize?: SqlitePageSize): void {
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	if (path !== ":memory:") {
		applyPageSize(db, path ?? ":memory:", pageSize);
		db.exec("PRAGMA journal_mode=WAL");
	}
}

function applyPageSize(db: Database, path: DatabasePath, requested?: SqlitePageSize): void {
	// Reduced: no getconf system-page-size detection; only an explicit valid size applies.
	if (path === ":memory:") return;
	const size = requested;
	if (typeof size === "number" && Number.isInteger(size) && size >= 512 && size <= 65536 && (size & (size - 1)) === 0) {
		db.exec(`PRAGMA page_size=${size}`);
	}
}

export function loadExtensions(db: Database, extensions: string | readonly string[]): void {
	const list = typeof extensions === "string" ? [extensions] : extensions;
	for (const extension of list) {
		if (extension) (db as ExtensionDatabase).loadExtension(extension);
	}
}

export function transaction<T>(db: Database, fn: () => T): T {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return fn();
		} finally {
			state.depth--;
		}
	}
	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export const deferredTransaction = transaction;

export async function transactionAsync<T>(db: Database, fn: () => Promise<T>): Promise<T> {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return await fn();
		} finally {
			state.depth--;
		}
	}
	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = await fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export function closeQuietly(db: Database | undefined | null): void {
	if (db === undefined || db === null) return;
	try {
		db.close();
	} catch {
		// Best-effort cleanup.
	}
}
