/**
 * Stateless parse worker for `syncAllSessions`. The main thread owns the
 * SQLite handle; workers receive a session path, offset, and parser state, run
 * `parseSessionFile` (pure I/O + CPU, no DB), and post a structured-clone-safe
 * result back. The try/catch IS the worker protocol: errors are reported as
 * `{ ok: false, error }` data across the boundary, not thrown into the void.
 * A `{ kind: "ping" }` request replies `{ ok: true, kind: "pong" }` and backs
 * `smokeTestSyncWorker`.
 */
import { type ParseSessionResult, parseSessionFile, type SessionParserState } from "./parser";

export type SyncWorkerRequest =
	| { kind?: "parse"; sessionFile: string; fromOffset: number; parserState?: SessionParserState; replay?: boolean }
	| { kind: "ping" };

export type SyncWorkerResponse =
	| { ok: true; kind?: "parse"; result: ParseSessionResult }
	| { ok: true; kind: "pong" }
	| { ok: false; error: string };

declare const self: Worker & {
	onmessage: ((event: MessageEvent<SyncWorkerRequest>) => void) | null;
};

self.onmessage = async event => {
	const request = event.data;
	try {
		if (request.kind === "ping") {
			self.postMessage({ ok: true, kind: "pong" } satisfies SyncWorkerResponse);
			return;
		}
		const result = await parseSessionFile(request.sessionFile, request.fromOffset, request.parserState);
		self.postMessage({ ok: true, result } satisfies SyncWorkerResponse);
	} catch (err) {
		const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		self.postMessage({ ok: false, error } satisfies SyncWorkerResponse);
	}
};
