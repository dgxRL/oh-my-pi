/**
 * Reduced port of packages/stats/src/parser.ts — session JSONL parsing.
 * English-only data pass-through; no service tiers, no premium requests,
 * no user-metrics extraction. Malformed JSONL lines are skipped (tested
 * contract); every other failure propagates.
 */
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "./paths";
import type {
	AgentType,
	MessageStatsInput,
	SessionEntry,
	SessionMessageEntry,
	SessionModelUsageEntry,
	ToolCallStats,
	ToolResultLink,
	UsageBucketView,
} from "./types";

/** Basename of an advisor agent's transcript inside a session artifacts dir. */
const ADVISOR_TRANSCRIPT_BASENAME = "__advisor.jsonl";

/** Characters a persisted tool name may consist of without sanitization. */
const TOOL_NAME_PATTERN = /^[\w.:-]+$/;

/**
 * Classify which agent produced a transcript from its path:
 * `<project>/<file>.jsonl` is `main`; anything nested deeper is a `subagent`;
 * `__advisor*.jsonl` at any depth is `advisor`.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	const base = path.basename(sessionPath);
	if (base === ADVISOR_TRANSCRIPT_BASENAME || (base.startsWith("__advisor.") && base.endsWith(".jsonl"))) {
		return "advisor";
	}
	const rel = path.relative(getSessionsDir(), sessionPath);
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/** `<project>/<file>.jsonl` -> project dir with `--` restored as path separators. */
export function extractFolderFromPath(sessionPath: string): string {
	const rel = path.relative(getSessionsDir(), sessionPath);
	const projectDir = rel.split(path.sep)[0];
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

function isModelUsage(entry: SessionEntry): entry is SessionModelUsageEntry {
	if (entry.type !== "model_usage") return false;
	const usageEntry = entry as SessionModelUsageEntry;
	return typeof usageEntry.id === "string" && usageEntry.id.length > 0;
}

function isToolResultMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	return (entry as SessionMessageEntry).message?.role === "toolResult";
}

/**
 * Token counters in persisted JSONL are whatever was written, not what the
 * type declares: a non-numeric or non-finite bucket counts as absent.
 */
function finiteTokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Total tokens for one usage payload: a present finite provider total stays
 * authoritative; a missing or malformed one is derived from the buckets.
 */
export function resolveUsageTotal(usage: UsageBucketView | null | undefined): number {
	if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	if (!usage || typeof usage !== "object") return 0;
	const orchestration =
		usage.orchestration && typeof usage.orchestration === "object" ? usage.orchestration : undefined;
	return (
		finiteTokenCount(usage.input) +
		finiteTokenCount(usage.output) +
		finiteTokenCount(usage.cacheRead) +
		finiteTokenCount(usage.cacheWrite) +
		finiteTokenCount(orchestration?.input) +
		finiteTokenCount(orchestration?.output) +
		finiteTokenCount(orchestration?.cacheRead)
	);
}

/** Message timestamp, falling back to the entry's ISO timestamp, then 0. */
function coerceEntryTimestamp(timestamp: unknown, entry: SessionMessageEntry): number {
	if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) return timestamp;
	const ts = Date.parse(String(entry.timestamp ?? ""));
	return Number.isFinite(ts) ? ts : 0;
}

/**
 * Extract stats from an assistant message entry. Malformed persisted entries
 * are coerced (missing stopReason, token counts, timestamp) or skipped
 * (missing model/provider/api/usage) instead of crashing the sync — every
 * field feeds a NOT NULL column.
 */
function extractStats(sessionFile: string, folder: string, entry: SessionMessageEntry, agentType: AgentType): MessageStatsInput | null {
	const msg = entry.message;
	if (msg?.role !== "assistant") return null;
	if (typeof msg.model !== "string" || typeof msg.provider !== "string" || typeof msg.api !== "string") return null;
	const rawUsage = msg.usage as UsageBucketView | undefined;
	if (!rawUsage || typeof rawUsage !== "object") return null;

	const usage: UsageBucketView = {
		...rawUsage,
		input: finiteTokenCount(rawUsage.input),
		output: finiteTokenCount(rawUsage.output),
		cacheRead: finiteTokenCount(rawUsage.cacheRead),
		cacheWrite: finiteTokenCount(rawUsage.cacheWrite),
		totalTokens: resolveUsageTotal(rawUsage),
	};

	return {
		sessionFile,
		entryId: entry.id as string,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: coerceEntryTimestamp(msg.timestamp, entry),
		duration: typeof msg.duration === "number" ? msg.duration : null,
		ttft: typeof msg.ttft === "number" ? msg.ttft : null,
		// A message persisted without a terminal stop reason never completed normally.
		stopReason: typeof msg.stopReason === "string" ? msg.stopReason : msg.errorMessage ? "error" : "aborted",
		errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : null,
		usage,
		agentType,
	};
}

/** Same extraction for `model_usage` journal entries, shaped as a message. */
function extractModelUsageStats(
	sessionFile: string,
	folder: string,
	entry: SessionModelUsageEntry,
	agentType: AgentType,
): MessageStatsInput | null {
	const timestamp = Date.parse(String(entry.timestamp));
	return extractStats(
		sessionFile,
		folder,
		{
			type: "message",
			id: entry.id,
			timestamp: entry.timestamp,
			message: {
				role: "assistant",
				content: [],
				api: entry.api,
				provider: entry.provider,
				model: entry.model,
				usage: entry.usage,
				stopReason: entry.stopReason ?? "stop",
				errorMessage: entry.errorMessage,
				timestamp: Number.isFinite(timestamp) ? timestamp : 0,
			},
		},
		agentType,
	);
}

/**
 * Extract one ToolCallStats per `toolCall` content block of an assistant
 * message; `callsInTurn` records the turn's block count so aggregation can
 * split real provider usage evenly per call.
 */
function extractToolCalls(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	agentType: AgentType,
): ToolCallStats[] {
	const msg = entry.message;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
	if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];

	const blocks = msg.content.filter(
		(block): block is { type: "toolCall"; id: string; name: string; arguments?: unknown } =>
			block !== null && typeof block === "object" && block.type === "toolCall" && typeof block.id === "string",
	);
	const calls: ToolCallStats[] = [];
	for (const block of blocks) {
		const toolName = sanitizeToolName(block.name);
		if (toolName === null) continue;
		calls.push({
			sessionFile,
			entryId: entry.id as string,
			toolCallId: block.id,
			folder,
			toolName,
			model: msg.model,
			provider: msg.provider,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry),
			agentType,
			callsInTurn: blocks.length,
			argsChars: JSON.stringify(block.arguments ?? {}).length,
		});
	}
	return calls;
}

/**
 * Tool names as persisted can carry provider-side parse garbage; reduce to the
 * leading identifier token, or null when nothing identifies the tool.
 */
function sanitizeToolName(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length === 0) return null;
	if (TOOL_NAME_PATTERN.test(trimmed)) return trimmed;
	const candidate = trimmed.split(/[^\w.:-]/)[0] ?? "";
	return candidate.length > 0 ? candidate : null;
}

/** Result linkage for a `toolResult` entry, keyed to the originating call. */
function extractToolResultLink(sessionFile: string, entry: SessionMessageEntry): ToolResultLink | null {
	const msg = entry.message;
	if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return null;
	let resultChars = 0;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				resultChars += block.text.length;
			}
		}
	}
	return {
		sessionFile,
		toolCallId: msg.toolCallId,
		resultChars,
		isError: msg.isError === true,
	};
}

const LF = 0x0a;
const CR = 0x0d;
const jsonLineDecoder = new TextDecoder();

/** Parse one JSONL line; malformed lines (truncated turns, foreign writers) are skipped. */
function parseJsonLine(bytes: Uint8Array, start: number, end: number): SessionEntry | null {
	while (end > start && bytes[end - 1] === CR) end--;
	if (end <= start) return null;
	try {
		return JSON.parse(jsonLineDecoder.decode(bytes.subarray(start, end))) as SessionEntry;
	} catch {
		return null;
	}
}

function parseSessionEntriesLenient(bytes: Uint8Array): { entries: SessionEntry[]; read: number } {
	const entries: SessionEntry[] = [];
	let cursor = 0;
	let read = 0;
	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseJsonLine(bytes, cursor, lineEnd);
		if (entry) {
			entries.push(entry);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			read = newline + 1;
		} else {
			break;
		}
		cursor = hasNewline ? newline + 1 : lineEnd;
	}
	return { entries, read };
}

/** Parse every well-formed entry in a transcript buffer (malformed lines skipped). */
export function parseAllSessionEntries(bytes: Uint8Array): SessionEntry[] {
	return parseSessionEntriesLenient(bytes).entries;
}

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

const CHECKPOINT_BYTES = 256;

async function readCheckpoint(handle: fs.FileHandle, end: number): Promise<Uint8Array> {
	const start = Math.max(0, end - CHECKPOINT_BYTES);
	const bytes = new Uint8Array(end - start);
	let read = 0;
	while (read < bytes.length) {
		const result = await handle.read(bytes, read, bytes.length - read, start + read);
		if (result.bytesRead === 0) break;
		read += result.bytesRead;
	}
	return bytes.subarray(0, read);
}

export function matchesSessionFile(state: SessionParserState, info: nodeFs.Stats): boolean {
	return state.dev === info.dev && state.ino === info.ino && state.birthtimeMs === info.birthtimeMs;
}

/**
 * Parse a session transcript incrementally: with a persisted cursor that
 * matches the file (identity, size, mtime, tail checkpoint) only the appended
 * tail is read; any mismatch resets to a full parse. `replay` forces a full
 * re-parse.
 */
export async function parseSessionFile(
	sessionPath: string,
	fromOffset = 0,
	state?: SessionParserState,
	replay = false,
): Promise<ParseSessionResult> {
	const handle = await fs.open(sessionPath, "r");
	let info: nodeFs.Stats;
	let checkpoint: string;
	let read: number;
	let entries: SessionEntry[];
	let start = Math.max(0, fromOffset);
	let reset = false;
	try {
		info = await handle.stat();
		const file = Bun.file(handle.fd);
		let resume = state?.version === 1 && state.offset === fromOffset;
		if (resume && state) {
			reset =
				!matchesSessionFile(state, info) ||
				info.size < state.size ||
				(info.size === state.size && info.mtimeMs !== state.mtimeMs);
			if (!reset) {
				const previous = await readCheckpoint(handle, fromOffset);
				reset = Bun.hash(previous).toString(16) !== state.checkpoint;
			}
			resume = !reset;
		}
		if (fromOffset > info.size) reset = true;
		if (replay) resume = false;
		start = reset || replay ? 0 : Math.max(0, fromOffset);
		const readStart = resume ? start : 0;
		const bytes = await file.slice(readStart, info.size).bytes();
		({ entries, read } = parseSessionEntriesLenient(bytes.subarray(start - readStart)));
		const newOffset = start + read;
		const checkpointStart = Math.max(0, newOffset - CHECKPOINT_BYTES);
		const previous =
			checkpointStart >= readStart
				? bytes.subarray(checkpointStart - readStart, newOffset - readStart)
				: await readCheckpoint(handle, newOffset);
		checkpoint = Bun.hash(previous).toString(16);
	} finally {
		await handle.close();
	}

	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStatsInput[] = [];
	const toolCalls: ToolCallStats[] = [];
	const toolResults: ToolResultLink[] = [];
	for (const entry of entries) {
		if (isToolResultMessage(entry)) {
			const link = extractToolResultLink(sessionPath, entry);
			if (link) toolResults.push(link);
			continue;
		}
		if (isModelUsage(entry)) {
			const modelUsageStats = extractModelUsageStats(sessionPath, folder, entry, agentType);
			if (modelUsageStats) stats.push(modelUsageStats);
			continue;
		}
		if (isAssistantMessage(entry)) {
			const msgStats = extractStats(sessionPath, folder, entry, agentType);
			if (msgStats) stats.push(msgStats);
			toolCalls.push(...extractToolCalls(sessionPath, folder, entry, agentType));
		}
	}

	return {
		stats,
		toolCalls,
		toolResults,
		newOffset: start + read,
		reset,
		parserState: {
			version: 1,
			offset: start + read,
			dev: info.dev,
			ino: info.ino,
			birthtimeMs: info.birthtimeMs,
			size: info.size,
			mtimeMs: info.mtimeMs,
			checkpoint,
		},
	};
}

/** List every `.jsonl` transcript under the sessions dir (one project dir deep). */
export async function listAllSessionFiles(): Promise<string[]> {
	const sessionsDir = getSessionsDir();
	const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const folderPath = path.join(sessionsDir, entry.name);
		const dirEntries = await fs.readdir(folderPath, { withFileTypes: true });
		for (const file of dirEntries) {
			if (file.isFile() && file.name.endsWith(".jsonl")) files.push(path.join(folderPath, file.name));
		}
	}
	return files;
}
