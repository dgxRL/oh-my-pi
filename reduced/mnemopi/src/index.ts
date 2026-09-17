/**
 * Barrel re-exports mirroring the original package's public surface (subset).
 * The original also ships an MCP server, CLI, diagnose, dr/recovery, plugins,
 * banks CRUD, scratchpad tools, and an orchestrator — none of that is reduced.
 */
export {
	Mnemopi,
	remember,
	recall,
	recallEnhanced,
	get,
	forget,
	update,
	getStats,
	getContext,
	sleep,
	sleepAllSessions,
	scratchpadWrite,
	scratchpadRead,
	scratchpadClear,
	setBank,
	getBank,
	getDefaultInstance,
	resetDefaultInstanceForTests,
} from "./core/memory";
export { BeamMemory, initBeam } from "./core/beam";
export { closeQuietly, openDatabase, transaction } from "./db";
export { available, embed, embedQuery, currentEmbeddingModel } from "./core/embeddings";
