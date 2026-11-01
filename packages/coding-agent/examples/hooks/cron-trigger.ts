/**
 * Cron Trigger Hook
 *
 * Wakes the agent on a schedule, so a session can keep driving itself toward
 * ongoing work without a human typing each turn (the "proactive" super-agent
 * property). Schedules live in a JSON file that is re-read on every tick, so
 * entries can be added or edited while the session runs.
 *
 * Usage:
 *   1. Create ~/.omp/agent/cron.json (or set OMP_CRON_FILE):
 *      [
 *        { "name": "nightly-regression", "schedule": "0 3 * * *",
 *          "message": "Run the regression suite and report failures." },
 *        { "name": "inbox-sweep", "schedule": "0,30 * * * *",
 *          "message": "Check for new review comments and address them." }
 *      ]
 *   2. Start omp with `--hook examples/hooks/cron-trigger.ts` (or copy the
 *      file into ~/.omp/agent/hooks/pre/).
 *
 * Schedule format: standard 5-field cron (minute hour day-of-month month
 * day-of-week), supporting wildcard, step values (`/n`), lists (`0,15,30`),
 * and ranges (`9-17`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const CHECK_INTERVAL_MS = 15_000;
const DEFAULT_CRON_FILE = path.join(os.homedir(), ".omp", "agent", "cron.json");

interface CronEntry {
	name?: string;
	schedule: string;
	message: string;
}

interface Field {
	min: number;
	max: number;
	values: Set<number>;
}

/** Parses one cron field into a set of matching values. Throws on bad syntax. */
function parseField(spec: string, min: number, max: number): Field {
	const values = new Set<number>();
	for (const part of spec.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in "${part}"`);
		let lo = min;
		let hi = max;
		if (rangePart !== "*") {
			const dash = rangePart.indexOf("-");
			if (dash === -1) {
				lo = hi = Number(rangePart);
			} else {
				lo = Number(rangePart.slice(0, dash));
				hi = Number(rangePart.slice(dash + 1));
			}
			if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
				throw new Error(`invalid range "${rangePart}" (expected ${min}-${max})`);
			}
		}
		for (let v = lo; v <= hi; v += step) values.add(v);
	}
	return { min, max, values };
}

/** True when the timestamp matches the 5-field cron expression. */
export function cronMatches(expr: string, date: Date): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`cron expression needs 5 fields, got ${fields.length}`);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = [
		parseField(fields[0], 0, 59),
		parseField(fields[1], 0, 23),
		parseField(fields[2], 1, 31),
		parseField(fields[3], 1, 12),
		parseField(fields[4], 0, 6),
	];
	const domRestricted = !fields[2].startsWith("*");
	const dowRestricted = !fields[4].startsWith("*");
	// Standard cron: if both day fields are restricted, either may match.
	if (domRestricted && dowRestricted) {
		const domHit = dayOfMonth.values.has(date.getDate());
		const dowHit = dayOfWeek.values.has(date.getDay());
		if (!domHit && !dowHit) return false;
	} else {
		if (!dayOfMonth.values.has(date.getDate())) return false;
		if (!dayOfWeek.values.has(date.getDay())) return false;
	}
	return (
		minute.values.has(date.getMinutes()) && hour.values.has(date.getHours()) && month.values.has(date.getMonth() + 1)
	);
}

function loadEntries(file: string): CronEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array`);
	return parsed.map(entry => {
		const { name, schedule, message } = entry as Record<string, unknown>;
		if (typeof schedule !== "string" || typeof message !== "string" || !message.trim()) {
			throw new Error(`${file}: each entry needs string "schedule" and non-empty "message"`);
		}
		return { name: typeof name === "string" ? name : undefined, schedule, message };
	});
}

export default function (pi: HookAPI) {
	let timer: NodeJS.Timeout | undefined;
	let lastFiredMinute = "";

	pi.on("session_start", async (_event, ctx) => {
		if (timer) return; // session_start can fire again on resume — never double-arm
		const file = process.env.OMP_CRON_FILE || DEFAULT_CRON_FILE;

		timer = setInterval(() => {
			// Fire at most once per wall-clock minute across all entries.
			const now = new Date();
			const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
			if (minuteKey === lastFiredMinute) return;
			let entries: CronEntry[];
			try {
				entries = loadEntries(file);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`cron-trigger: ${error instanceof Error ? error.message : error}`, "warning");
				return;
			}
			const due = entries.filter(entry => {
				try {
					return cronMatches(entry.schedule, now);
				} catch (error) {
					if (ctx.hasUI)
						ctx.ui.notify(
							`cron-trigger: ${entry.name ?? entry.schedule}: ${error instanceof Error ? error.message : error}`,
							"warning",
						);
					return false;
				}
			});
			if (due.length === 0) return;
			lastFiredMinute = minuteKey;
			for (const entry of due) {
				pi.sendMessage(
					{
						customType: "cron-trigger",
						content: `Scheduled task (${entry.name ?? entry.schedule}): ${entry.message}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			}
		}, CHECK_INTERVAL_MS);
		timer.unref?.();

		if (ctx.hasUI) {
			try {
				const count = loadEntries(file).length;
				ctx.ui.notify(
					count > 0 ? `cron-trigger: ${count} schedule(s) from ${file}` : `cron-trigger: no schedules in ${file}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`cron-trigger: ${error instanceof Error ? error.message : error}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});
}
