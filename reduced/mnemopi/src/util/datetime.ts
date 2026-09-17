// Ported from packages/mnemopi/src/util/datetime.ts (minimal: only what temporal-parser needs).
const TZ_RE = /(?:Z|[+-]\d\d:?\d\d)$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type QueryTime = string | Date | null | undefined;

export function parseIsoDateTimeUtc(value: string): Date {
	let text = value.trim();
	if (!text) throw new RangeError("Invalid ISO datetime: empty string");
	if (DATE_ONLY_RE.test(text)) text += "T00:00:00Z";
	else if (!TZ_RE.test(text)) text += "Z";
	const date = new Date(text);
	if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ISO datetime: ${value}`);
	return date;
}

export function normalizeDateTimeUtc(value: Date): Date {
	const time = value.getTime();
	if (Number.isNaN(time)) throw new RangeError("Invalid Date");
	return new Date(time);
}

export function parseQueryTime(value: QueryTime): Date {
	if (value === null || value === undefined) return new Date();
	return typeof value === "string" ? parseIsoDateTimeUtc(value) : normalizeDateTimeUtc(value);
}
