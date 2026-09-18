/** Reduced type vocabulary for the stats engine. */

export type AgentType = "main" | "subagent" | "advisor";
export type StopReason = string;

/** Token buckets as persisted in session JSONL (outside-controlled shapes). */
export interface UsageBucketView {
	totalTokens?: unknown;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	orchestration?: { input?: unknown; output?: unknown; cacheRead?: unknown } | null;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface Usage extends UsageBucketView {
	totalTokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: Partial<UsageCost>;
}

/** Extracted stats from an assistant message. */
export interface MessageStats {
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: StopReason;
	errorMessage: string | null;
	usage: Usage;
	agentType: AgentType;
}

/** Session-recorded usage before pricing (counters may be malformed). */
export interface MessageStatsInput extends Omit<MessageStats, "usage"> {
	usage: UsageBucketView & { cost?: Partial<UsageCost> };
}

/** Session JSONL entry shapes the parser matches on. */
export interface SessionHeader {
	type: "session";
	id?: string;
	timestamp?: string;
}

export interface SessionMessageEntry {
	type: "message";
	id?: string;
	parentId?: string;
	timestamp?: string;
	message: {
		role: string;
		content?: unknown;
		synthetic?: boolean;
		model?: unknown;
		provider?: unknown;
		api?: unknown;
		usage?: unknown;
		duration?: unknown;
		ttft?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
		timestamp?: unknown;
		toolCallId?: unknown;
		isError?: unknown;
	};
}

export interface SessionModelUsageEntry {
	type: "model_usage";
	id?: string;
	timestamp?: string;
	api?: string;
	provider?: string;
	model?: string;
	usage?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

export interface SessionCustomEntry {
	type: string;
}

export type SessionEntry =
	| SessionHeader
	| SessionMessageEntry
	| SessionModelUsageEntry
	| SessionCustomEntry
	| { type: string };

export interface ToolCallStats {
	sessionFile: string;
	entryId: string;
	toolCallId: string;
	folder: string;
	toolName: string;
	model: string;
	provider: string;
	timestamp: number;
	agentType: AgentType;
	callsInTurn: number;
	argsChars: number;
}

export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	resultChars: number;
	isError: boolean;
}

/** Incremental parser cursor: file identity + tail checkpoint. */
export interface SessionParserState {
	version: 1;
	offset: number;
	dev: number;
	ino: number;
	birthtimeMs: number;
	size: number;
	mtimeMs: number;
	checkpoint: string;
}

export interface ParseSessionResult {
	stats: MessageStatsInput[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	newOffset: number;
	parserState?: SessionParserState;
	reset?: boolean;
}

// ---- dashboard query result shapes -----------------------------------------

/** Aggregate summary shared by overall stats and every GROUP BY view. */
export interface StatsSummary {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	totalCost: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}

export interface TimeSeriesPoint {
	timestamp: number;
	requests: number;
	errors: number;
}

export interface ModelStats extends StatsSummary {
	model: string;
	provider: string;
}

/** One tool-call aggregate row; share columns split turn usage across callsInTurn. */
export interface ToolUsageStats {
	tool: string;
	calls: number;
	errors: number;
	argsChars: number;
	resultChars: number;
	totalTokensShare: number;
	outputTokensShare: number;
	costShare: number;
	lastUsed: number;
}

export interface ToolModelStats extends ToolUsageStats {
	model: string;
	provider: string;
}

export interface ToolTimeSeriesPoint {
	timestamp: number;
	tool: string;
	calls: number;
	errors: number;
}

export interface ToolDashboardPayload {
	byTool: ToolUsageStats[];
	byToolModel: ToolModelStats[];
	series: ToolTimeSeriesPoint[];
}

export interface FolderStats extends StatsSummary {
	folder: string;
}

export interface RequestDetails extends MessageStats {}

export interface AgentTypeStats {
	agentType: AgentType;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}

export interface AggregatedStats {
	overall: StatsSummary;
	byModel: ModelStats[];
	byFolder: FolderStats[];
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
	recentRequests: MessageStats[];
	recentErrors: MessageStats[];
}

export interface CostTimeSeriesPoint {
	day: number;
	model: string;
	provider: string;
	cost: number;
	tokens: number;
	requests: number;
}

export interface SyncOptions {
	workers?: number;
	onProgress?: (progress: SyncProgress) => void;
}

export interface SyncProgress {
	current: number;
	total: number;
	processed: number;
	sessionFile: string;
}
