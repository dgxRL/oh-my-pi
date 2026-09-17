/**
 * Reduced port of packages/mnemopi/src/core/memory.ts — the Mnemopi facade.
 * Wraps BeamMemory with bank-scoped db paths, legacy aliases, and a module-level
 * singleton. Dropped vs the original: AAAK typed-memory/AAAK options, LLM
 * runtime resolution (llm backends), embedding-model reconciliation, BankManager
 * create/delete/rename (kept: listBanks for stats), AnnotationStore-facing
 * extras beyond the annotation seam.
 */
import type { Database } from "bun:sqlite";
import type { BeamStats, Metadata, RecallResult, SleepResult, Veracity } from "./beam/types";
import { dbPath as configuredDbPath } from "../config";
import { closeQuietly } from "../db";
import { BankManager } from "./banks";
import { BeamMemory, initBeam } from "./beam";
import { AnnotationStore } from "./annotations";
import { EpisodicGraph } from "./episodic-graph";
import { withMnemopiRuntimeOptions, type MnemopiRuntimeOptions } from "./runtime-options";

export interface MnemopiOptions {
	sessionId?: string;
	session_id?: string;
	bank?: string;
	dbPath?: string;
	db_path?: string;
	db?: Database;
	authorId?: string | null;
	author_id?: string | null;
	authorType?: string | null;
	author_type?: string | null;
	channelId?: string | null;
	channel_id?: string | null;
	proactiveLinking?: boolean;
	noEmbeddings?: boolean;
	embeddings?: { provider?: (texts: readonly string[]) => AsyncIterable<number[][]> | Promise<AsyncIterable<number[][]>> };
	runtimeOptions?: MnemopiRuntimeOptions;
	reconcile?: boolean;
}

export interface RememberInput {
	content: string;
	source?: string;
	importance?: number;
	metadata?: Metadata | null;
	timestamp?: string;
	embedText?: string;
	embed_text?: string;
	valid_until?: string;
	scope?: string;
	veracity?: Veracity;
	memoryType?: string;
	memory_type?: string;
	trustTier?: string;
	trust_tier?: string;
}

export type RememberFacadeOptions = {
	source?: string;
	importance?: number;
	metadata?: Metadata | null;
	timestamp?: string;
	embedText?: string;
	embed_text?: string;
	validUntil?: string;
	valid_until?: string;
	scope?: string;
	extractEntities?: boolean;
	extract_entities?: boolean;
	trustTier?: string;
	trust_tier?: string;
	veracity?: Veracity;
	memoryType?: string;
	memory_type?: string;
};

export type RecallFacadeOptions = {
	fromDate?: string | null;
	from_date?: string | null;
	toDate?: string | null;
	to_date?: string | null;
	authorId?: string | null;
	authorType?: string | null;
	channelId?: string | null;
	includeWorking?: boolean;
	queryTime?: string | Date | null;
	query_time?: string | Date | null;
	source?: string | null;
	topic?: string | null;
	temporalWeight?: number;
	temporalHalflife?: number;
	vecWeight?: number;
	ftsWeight?: number;
	importanceWeight?: number;
	contentPreviewChars?: number;
	queryEmbedding?: readonly number[] | null;
};

export interface MemoryFacadeStats {
	total_memories: number;
	total_sessions: number;
	sources: Record<string, number>;
	last_memory: string | null;
	database: string;
	mode: "beam";
	banks: string[];
	beam: {
		working_memory: BeamStats;
		episodic_memory: BeamStats;
	};
}

function normalizeDate(value: string | Date | null | undefined): string | null | undefined {
	if (value === null || value === undefined) return value;
	return value instanceof Date ? value.toISOString() : value;
}

function resolveDbPath(options: MnemopiOptions, bank: string): string | undefined {
	const explicit = options.dbPath ?? options.db_path;
	if (explicit !== undefined) return explicit;
	if (options.db !== undefined) return undefined;
	if (bank !== "default") return new BankManager().getBankDbPath(bank);
	return configuredDbPath();
}

function toRememberOptions(input: string | RememberInput, options: RememberFacadeOptions) {
	const memory = typeof input === "string" ? null : input;
	const timestamp = normalizeDate(options.timestamp ?? memory?.timestamp);
	const embedText = options.embedText ?? options.embed_text ?? memory?.embedText ?? memory?.embed_text ?? null;
	const rememberOptions: Record<string, unknown> = {
		source: options.source ?? memory?.source ?? "conversation",
		importance: options.importance ?? memory?.importance ?? 0.5,
		metadata: options.metadata ?? memory?.metadata ?? null,
		validUntil: normalizeDate(options.validUntil ?? options.valid_until ?? memory?.valid_until),
		scope: options.scope ?? memory?.scope ?? "session",
		extractEntities: options.extractEntities ?? options.extract_entities ?? false,
		embedText: embedText ?? undefined,
		trustTier: options.trustTier ?? options.trust_tier ?? memory?.trustTier ?? memory?.trust_tier ?? undefined,
		veracity: options.veracity ?? memory?.veracity ?? undefined,
		memoryType: options.memoryType ?? options.memory_type ?? memory?.memoryType ?? memory?.memory_type ?? undefined,
	};
	if (timestamp !== null && timestamp !== undefined) rememberOptions.timestamp = timestamp;
	return rememberOptions;
}

function toRecallOptions(options: RecallFacadeOptions): Record<string, unknown> {
	const beamOptions: Record<string, unknown> = {
		fromDate: options.fromDate ?? options.from_date ?? null,
		toDate: options.toDate ?? options.to_date ?? null,
		authorId: options.authorId ?? null,
		authorType: options.authorType ?? null,
		channelId: options.channelId ?? null,
		includeWorking: options.includeWorking,
		queryTime: options.queryTime ?? options.query_time ?? null,
		source: options.source ?? null,
		topic: options.topic ?? null,
		temporalWeight: options.temporalWeight,
		temporalHalflife: options.temporalHalflife,
		vecWeight: options.vecWeight,
		ftsWeight: options.ftsWeight,
		importanceWeight: options.importanceWeight,
		contentPreviewChars: options.contentPreviewChars,
	};
	// Preserve the three-state semantics (`undefined` = auto-derive, `null` =
	// explicitly FTS-only, number[] = caller-supplied).
	if ("queryEmbedding" in options) beamOptions.queryEmbedding = options.queryEmbedding;
	return beamOptions;
}

function countRows(db: Database, sql: string, ...params: (string | number | null)[]): number {
	const row = db.prepare(sql).get(...params) as { total?: number; count?: number } | null;
	return row?.total ?? row?.count ?? 0;
}

function dataDirForDbPath(path: string): string | undefined {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (slash < 0) return undefined;
	const parent = path.slice(0, slash);
	const marker = `${parent.includes("\\") ? "\\" : "/"}banks${parent.includes("\\") ? "\\" : "/"}`;
	const bankIndex = parent.lastIndexOf(marker);
	return bankIndex < 0 ? parent : parent.slice(0, bankIndex);
}

function sourceCounts(db: Database): Record<string, number> {
	const counts: Record<string, number> = {};
	const rows = db
		.prepare("SELECT source, COUNT(*) AS total FROM working_memory GROUP BY source")
		.all() as Array<{ source: string | null; total: number }>;
	for (const row of rows) {
		counts[String(row.source ?? "") || "conversation"] = Number(row.total ?? 0);
	}
	return counts;
}

let defaultInstance: Mnemopi | null = null;
let defaultBank = "default";

function defaultFor(bank: string | null | undefined = null): Mnemopi {
	const targetBank = bank ?? defaultBank ?? "default";
	if (defaultInstance === null || defaultInstance.bank !== targetBank) {
		defaultInstance?.close();
		defaultBank = targetBank;
		defaultInstance = new Mnemopi({ bank: targetBank });
	}
	return defaultInstance;
}

export class Mnemopi {
	readonly sessionId: string;
	readonly bank: string;
	readonly dbPath?: string;
	readonly authorId: string | null;
	readonly authorType: string | null;
	readonly channelId: string;
	readonly beam: BeamMemory;
	readonly conn: Database;
	readonly db: Database;
	readonly runtimeOptions?: MnemopiRuntimeOptions;
	#ownsDb: boolean;
	#closed = false;

	constructor(options: MnemopiOptions = {}) {
		this.sessionId = options.sessionId ?? options.session_id ?? "default";
		this.bank = options.bank ?? "default";

		this.authorId = options.authorId ?? options.author_id ?? null;
		this.authorType = options.authorType ?? options.author_type ?? null;
		this.channelId = options.channelId ?? options.channel_id ?? this.sessionId;
		this.dbPath = resolveDbPath(options, this.bank);
		this.runtimeOptions = options.runtimeOptions ??
			(options.noEmbeddings === true || options.embeddings !== undefined
				? {
						embeddings: {
							disabled: options.noEmbeddings === true ? true : undefined,
							provider: options.embeddings?.provider,
						},
					}
				: undefined);

		this.beam = new BeamMemory({
			sessionId: this.sessionId,
			dbPath: options.db === undefined ? this.dbPath : ":memory:",
			authorId: this.authorId,
			authorType: this.authorType,
			channelId: this.channelId,
			proactiveLinking: options.proactiveLinking,
		});
		this.#ownsDb = options.db === undefined;
		if (options.db !== undefined) {
			const opened = this.beam.db;
			initBeam(options.db);
			Object.defineProperty(this.beam, "db", { value: options.db });
			const externalAnnotations = new AnnotationStore({ db: options.db });
			Object.defineProperty(this.beam, "annotations", {
				value: {
					add: (memoryId: string, kind: string, value: string) => externalAnnotations.add(memoryId, kind, value),
				},
			});
			Object.defineProperty(this.beam, "episodicGraph", {
				value: new EpisodicGraph({ db: options.db, dbPath: this.dbPath }),
			});
			closeQuietly(opened);
		}
		this.conn = this.beam.db;
		this.db = this.beam.db;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#ownsDb) this.beam.close();
	}

	remember(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		const content = typeof memory === "string" ? memory : memory.content;
		return this.#withRuntimeOptions(() => this.beam.remember(content, toRememberOptions(memory, options)));
	}

	recall(query: string, topK = 5, options: RecallFacadeOptions = {}): Promise<RecallResult[]> {
		return this.#withRuntimeOptions(() => this.beam.recall(query, topK, toRecallOptions(options)));
	}

	recallEnhanced(
		query: string,
		topK = 5,
		options: RecallFacadeOptions & { includeFacts?: boolean; useCache?: boolean } = {},
	): Promise<RecallResult[]> {
		return this.#withRuntimeOptions(() =>
			this.beam.recallEnhanced(query, topK, {
				...toRecallOptions(options),
				useCache: options.useCache,
				includeFacts: options.includeFacts,
			}),
		);
	}

	getContext(limit = 10): unknown[] {
		return this.#withRuntimeOptions(() => this.beam.getContext(limit));
	}

	getStats(
		authorId: string | null = null,
		authorType: string | null = null,
		channelId: string | null = null,
	): MemoryFacadeStats {
		const working = this.#withRuntimeOptions(() => this.beam.getWorkingStats(authorId, authorType, channelId));
		const episodic = this.#withRuntimeOptions(() => this.beam.getEpisodicStats(authorId, authorType, channelId));
		const totalMemories = countRows(this.conn, "SELECT COUNT(*) AS total FROM working_memory");
		const totalSessions = countRows(this.conn, "SELECT COUNT(DISTINCT session_id) AS total FROM working_memory");
		const lastRow = this.conn.prepare("SELECT timestamp FROM working_memory ORDER BY timestamp DESC LIMIT 1").get() as
			| { timestamp: string | null }
			| null;
		let banks = ["default"];
		if (this.dbPath !== undefined && this.dbPath !== ":memory:") {
			const dataDir = dataDirForDbPath(this.dbPath);
			banks = new BankManager(dataDir).listBanks();
		}
		return {
			total_memories: totalMemories,
			total_sessions: totalSessions,
			sources: sourceCounts(this.conn),
			last_memory: lastRow?.timestamp ?? null,
			database: this.dbPath ?? ":memory:",
			mode: "beam",
			banks,
			beam: { working_memory: working, episodic_memory: episodic },
		};
	}

	get(memoryId: string): unknown | null {
		return this.#withRuntimeOptions(() => this.beam.get(memoryId));
	}

	forget(memoryId: string): boolean {
		return this.#withRuntimeOptions(() => this.beam.forgetWorking(memoryId));
	}

	update(memoryId: string, content: string | null = null, importance: number | null = null): boolean {
		return this.#withRuntimeOptions(() => this.beam.updateWorking(memoryId, content, importance));
	}

	sleep(dryRun = false): SleepResult {
		return this.#withRuntimeOptions(() => this.beam.sleep(dryRun));
	}

	sleepAllSessions(dryRun = false): SleepResult {
		return this.#withRuntimeOptions(() => this.beam.sleepAllSessions(dryRun));
	}

	scratchpadWrite(content: string): string {
		return this.#withRuntimeOptions(() => this.beam.scratchpadWrite(content));
	}

	scratchpadRead(): unknown[] {
		return this.#withRuntimeOptions(() => this.beam.scratchpadRead());
	}

	scratchpadClear(): void {
		this.#withRuntimeOptions(() => this.beam.scratchpadClear());
	}

	addMemory(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		return this.remember(memory, options);
	}

	saveMemory(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		return this.remember(memory, options);
	}

	storeMemory(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		return this.remember(memory, options);
	}

	search(query: string, topK = 5, options: RecallFacadeOptions = {}): Promise<RecallResult[]> {
		return this.recall(query, topK, options);
	}

	query(query: string, topK = 5, options: RecallFacadeOptions = {}): Promise<RecallResult[]> {
		return this.recall(query, topK, options);
	}

	consolidate(dryRun = false): SleepResult {
		return this.sleep(dryRun);
	}

	#withRuntimeOptions<T>(fn: () => T): T {
		return withMnemopiRuntimeOptions(this.runtimeOptions, fn);
	}
}

export function setBank(bank: string): void {
	defaultBank = bank;
}

export function getBank(): string {
	return defaultBank || "default";
}

export function getDefaultInstance(bank: string | null = null): Mnemopi {
	return defaultFor(bank);
}

export function remember(content: string | RememberInput, options: RememberFacadeOptions & { bank?: string } = {}): string {
	return defaultFor(options.bank).remember(content, options);
}

export function recall(query: string, topK = 5, options: RecallFacadeOptions & { bank?: string } = {}): Promise<RecallResult[]> {
	return defaultFor(options.bank).recall(query, topK, options);
}

export function recallEnhanced(
	query: string,
	topK = 5,
	options: RecallFacadeOptions & { bank?: string; includeFacts?: boolean; useCache?: boolean } = {},
): Promise<RecallResult[]> {
	return defaultFor(options.bank).recallEnhanced(query, topK, options);
}

export function getContext(limit = 10, bank: string | null = null): unknown[] {
	return defaultFor(bank).getContext(limit);
}

export function getStats(bank: string | null = null): MemoryFacadeStats {
	return defaultFor(bank).getStats();
}

export function get(memoryId: string, bank: string | null = null): unknown | null {
	return defaultFor(bank).get(memoryId);
}

export function forget(memoryId: string, bank: string | null = null): boolean {
	return defaultFor(bank).forget(memoryId);
}

export function update(
	memoryId: string,
	content: string | null = null,
	importance: number | null = null,
	bank: string | null = null,
): boolean {
	return defaultFor(bank).update(memoryId, content, importance);
}

export function sleep(dryRun = false, bank: string | null = null): SleepResult {
	return defaultFor(bank).sleep(dryRun);
}

export function sleepAllSessions(dryRun = false, bank: string | null = null): SleepResult {
	return defaultFor(bank).sleepAllSessions(dryRun);
}

export function scratchpadWrite(content: string, bank: string | null = null): string {
	return defaultFor(bank).scratchpadWrite(content);
}

export function scratchpadRead(bank: string | null = null): unknown[] {
	return defaultFor(bank).scratchpadRead();
}

export function scratchpadClear(bank: string | null = null): void {
	defaultFor(bank).scratchpadClear();
}

export function resetDefaultInstanceForTests(): void {
	defaultInstance?.close();
	defaultInstance = null;
	defaultBank = "default";
}

export type { MemoryFacadeStats as FacadeStats };
