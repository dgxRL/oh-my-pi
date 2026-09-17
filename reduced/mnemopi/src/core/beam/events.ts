/** Single event-emission path for the beam modules (Observer pattern). */
import { nowIso } from "../../util/datetime";
import type { BeamEvent, BeamMemoryState } from "./types";

export type EventPayload = Omit<BeamEvent, "type" | "sessionId" | "timestamp">;

/** Fan an event out to the optional eventEmitter and pluginManager sinks. */
export function emitEvent(beam: BeamMemoryState, type: string, data: EventPayload): void {
	const event: BeamEvent = {
		...data,
		type,
		sessionId: beam.sessionId,
		timestamp: nowIso(),
	};
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}
