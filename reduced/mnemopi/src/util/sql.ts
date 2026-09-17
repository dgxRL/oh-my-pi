/** Shared SQLite snippet builders for the reduced beam modules. */

/** Build a comma-separated `?` placeholder list of the given length. */
export function placeholders(count: number): string {
	return new Array<string>(Math.max(0, count)).fill("?").join(",");
}
