/**
 * Reduced port of packages/mnemopi/src/core/beam/index.ts — BeamMemory hub.
 * Same constructor options and method surface as the original, minus dropped
 * features (memoria extraction/retrieval, health, reconcile, flushExtractions,
 * proactive linking).
 */
import type { Database } from "bun:sqlite";
import { maxEpisodeChars, ftsWeight, importanceWeight, vectorWeight } from "../../config";
import { closeQuietly, openDatabase } from "../../db";
import { AnnotationStore } from "../annotations";
import { EpisodicGraph } from "../episodic-graph";
import {
	consolidateToEpisodic,
	degradeEpisodic,
	getConsolidationLog,
	getContaminated,
	getEpisodicStats,
	sleep,
	sleepAllSessions,
} from "./consolidate";
import { detectLanguage } from "./helpers";
import { factRecall, formatContext, recall, recallEnhanced } from "./recall";
import { initBeam } from "./schema";
import {
	exportToDict,
	forgetWorking,
	get,
	getContext,
	getGlobalWorkingStats,
	getWorkingStats,
	importFromDict,
	invalidate,
	remember,
	rememberBatch,
	scratchpadClear,
	scratchpadRead,
	scratchpadWrite,
	updateWorking,
} from "./store";
import type {
	BeamConfig,
	BeamEvent,
	BeamMemoryOptions,
	BeamMemoryState,
	BeamStats,
	ImportStats,
	Metadata,
	RecallEnhancedOptions,
	RecallOptions,
	RecallResult,
	RememberBatchItem,
	RememberBatchOptions,
	RememberOptions,
	SleepResult,
} from "./types";

export { initBeam } from "./schema";
export type * from "./types";

const DEFAULT_CONFIG: BeamConfig = {
	workingMemoryLimit: 1000,
	workingMemoryTtlHours: 24,
	recencyHalflifeHours: 72,
	vecWeight: 0.5,
	ftsWeight: 0.3,
	importanceWeight: 0.2,
	useCloud: false,
	localLlmEnabled: false,
	maxEpisodeChars: 100_000,
	proactiveLinking: false,
};

function normalizeConfig(options: BeamMemoryOptions): BeamConfig {
	const configured = options.config ?? {};
	const useCloud = options.useCloud ?? configured.useCloud ?? DEFAULT_CONFIG.useCloud;
	return {
		workingMemoryLimit: configured.workingMemoryLimit ?? DEFAULT_CONFIG.workingMemoryLimit,
		workingMemoryTtlHours: configured.workingMemoryTtlHours ?? DEFAULT_CONFIG.workingMemoryTtlHours,
		recencyHalflifeHours: configured.recencyHalflifeHours ?? DEFAULT_CONFIG.recencyHalflifeHours,
		vecWeight: configured.vecWeight ?? vectorWeight(),
		ftsWeight: configured.ftsWeight ?? ftsWeight(),
		importanceWeight: configured.importanceWeight ?? importanceWeight(),
		useCloud,
		localLlmEnabled: configured.localLlmEnabled ?? DEFAULT_CONFIG.localLlmEnabled,
		maxEpisodeChars: configured.maxEpisodeChars ?? maxEpisodeChars(),
		proactiveLinking: options.proactiveLinking ?? configured.proactiveLinking ?? DEFAULT_CONFIG.proactiveLinking,
	};
}

export class BeamMemory implements BeamMemoryState {
	readonly db: Database;
	readonly dbPath?: string;
	readonly sessionId: string;
	readonly authorId: string | null;
	readonly authorType: string | null;
	readonly channelId: string;
	readonly useCloud: boolean;
	readonly eventEmitter?: (event: BeamEvent) => void;
	readonly pluginManager: BeamMemoryState["pluginManager"];
	readonly annotations: BeamMemoryState["annotations"];
	readonly triples: BeamMemoryState["triples"];
	readonly episodicGraph: EpisodicGraph;
	readonly veracityConsolidator: null = null;
	readonly caches: BeamMemoryState["caches"];
	readonly config: BeamConfig;
	#closed = false;

	constructor(options?: BeamMemoryOptions);
	constructor(
		sessionId?: string,
		dbPath?: string,
		authorId?: string | null,
		authorType?: string | null,
		channelId?: string | null,
		useCloud?: boolean,
		eventEmitter?: (event: BeamEvent) => void,
	);
	constructor(
		optionsOrSessionId: BeamMemoryOptions | string = {},
		dbPath?: string,
		authorId?: string | null,
		authorType?: string | null,
		channelId?: string | null,
		useCloud?: boolean,
		eventEmitter?: (event: BeamEvent) => void,
	) {
		const options: BeamMemoryOptions =
			typeof optionsOrSessionId === "string"
				? {
						sessionId: optionsOrSessionId,
						dbPath,
						authorId,
						authorType,
						channelId,
						useCloud,
						eventEmitter,
					}
				: optionsOrSessionId;
		this.sessionId = options.sessionId ?? "default";
		this.authorId = options.authorId ?? null;
		this.authorType = options.authorType ?? null;
		this.channelId = options.channelId ?? this.sessionId;
		this.dbPath = options.dbPath;
		this.config = normalizeConfig(options);
		this.useCloud = this.config.useCloud;
		this.pluginManager = options.pluginManager ?? null;
		this.db = openDatabase(this.dbPath);
		initBeam(this.db);
		this.episodicGraph = new EpisodicGraph({ db: this.db, dbPath: this.dbPath });
		const annotationStore = new AnnotationStore({ db: this.db });
		this.annotations = options.annotations ?? {
			add: (memoryId, kind, value, writeOptions) =>
				annotationStore.add(memoryId, kind, value, writeOptions?.source, writeOptions?.confidence),
			addMany: (memoryId, kind, values, writeOptions) =>
				annotationStore.addMany(memoryId, kind, values, writeOptions?.source, writeOptions?.confidence),
			queryByMemory: (memoryId, kind) => annotationStore.queryByMemory(memoryId, kind),
			queryByKind: (kind, value) => annotationStore.queryByKind(kind, { value }),
			getDistinctValues: kind => annotationStore.getDistinctValues(kind),
		};
		this.triples = options.triples ?? null;
		this.caches = {
			timestampParse: new Map(),
			extractionBuffer: [],
		};
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		closeQuietly(this.db);
	}

	remember(content: string, options: RememberOptions = {}): string {
		return remember(this, content, options);
	}

	rememberBatch(items: readonly RememberBatchItem[], options: RememberBatchOptions = {}): string[] {
		return rememberBatch(this, items, options);
	}

	getContext(limit = 10): unknown[] {
		return getContext(this, limit);
	}

	invalidate(memoryId: string, replacementId: string | null = null): boolean {
		return invalidate(this, memoryId, replacementId);
	}

	getWorkingStats(
		authorId: string | null = null,
		authorType: string | null = null,
		channelId: string | null = null,
	): BeamStats {
		return getWorkingStats(this, authorId, authorType, channelId);
	}

	getGlobalWorkingStats(): BeamStats {
		return getGlobalWorkingStats(this);
	}

	updateWorking(memoryId: string, content: string | null = null, importance: number | null = null): boolean {
		return updateWorking(this, memoryId, content, importance);
	}

	get(memoryId: string): unknown | null {
		return get(this, memoryId);
	}

	forgetWorking(memoryId: string): boolean {
		return forgetWorking(this, memoryId);
	}

	consolidateToEpisodic(
		summary: string,
		sourceWmIds: readonly string[],
		source = "consolidation",
		importance = 0.6,
		options?: {
			metadata?: Metadata | null;
			validUntil?: string | null;
			scope?: string;
			veracity?: string | null;
		},
	): string {
		return consolidateToEpisodic(this, summary, sourceWmIds, source, importance, options);
	}

	detectLanguage(text: string): string {
		return detectLanguage(text);
	}

	recall(query: string, topK = 40, options: RecallOptions = {}): Promise<RecallResult[]> {
		return recall(this, query, topK, options);
	}

	recallEnhanced(query: string, topK = 40, options: RecallEnhancedOptions = {}): Promise<RecallResult[]> {
		return recallEnhanced(this, query, topK, options);
	}

	formatContext(results: readonly RecallResult[], format = "bullet"): string {
		return formatContext(this, results, format);
	}

	factRecall(query: string, topK = 30): RecallResult[] {
		return factRecall(this, query, topK);
	}

	getEpisodicStats(
		authorId: string | null = null,
		authorType: string | null = null,
		channelId: string | null = null,
	): BeamStats {
		return getEpisodicStats(this, authorId, authorType, channelId);
	}

	degradeEpisodic(dryRun = false): Record<string, unknown> {
		return degradeEpisodic(this, dryRun);
	}

	getContaminated(limit = 50, minImportance = 0.0): unknown[] {
		return getContaminated(this, limit, minImportance);
	}

	sleep(dryRun = false): SleepResult {
		return sleep(this, dryRun);
	}

	sleepAllSessions(dryRun = false): SleepResult {
		return sleepAllSessions(this, dryRun);
	}

	getConsolidationLog(limit = 10): unknown[] {
		return getConsolidationLog(this, limit);
	}

	scratchpadWrite(content: string): string {
		return scratchpadWrite(this, content);
	}

	scratchpadRead(): unknown[] {
		return scratchpadRead(this);
	}

	scratchpadClear(): void {
		scratchpadClear(this);
	}

	exportToDict(): Record<string, unknown> {
		return exportToDict(this);
	}

	importFromDict(data: Record<string, unknown>, force = false): ImportStats {
		return importFromDict(this, data, force);
	}
}
