/**
 * Time helpers for admin reporting.
 *
 * SQLite's CURRENT_TIMESTAMP stores "YYYY-MM-DD HH:MM:SS" (UTC) while some rows (SOL
 * subscriptions, older code) store ISO strings with a "T". Comparing either against an ISO
 * bound as text drops rows (" " sorts before "T"), so every admin range query compares
 * `datetime(column)` against `datetime(?)`, and bounds are passed in SQLite's own format.
 */

/** A Date as SQLite's UTC "YYYY-MM-DD HH:MM:SS". */
export function toSqlTime(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}

/** A Date as "YYYY-MM-DD" (UTC). */
export function toSqlDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Parse a DB time ("YYYY-MM-DD HH:MM:SS" UTC, or ISO) to epoch ms. */
export function dbTimeMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const iso = value.includes("T")
		? value
		: `${value.replace(" ", "T")}${value.length <= 10 ? "T00:00:00" : ""}Z`;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : t;
}

/** Normalize a DB time to ISO for the client (null stays null). */
export function isoOrNull(value: string | null | undefined): string | null {
	const t = dbTimeMs(value);
	return t === null ? null : new Date(t).toISOString();
}

/** First instant of the UTC month containing `date`. */
export function startOfUtcMonth(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** First instant of the UTC month `offset` months after the one containing `date`. */
export function addUtcMonths(date: Date, offset: number): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

/** First instant of the UTC day containing `date`. */
export function startOfUtcDay(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Average month length, used to normalize SOL subscription periods to a month. */
export const DAYS_PER_MONTH = 30.4375;

export class InvalidDateError extends Error {
	constructor(field: string) {
		super(`${field} is not a valid date`);
		this.name = "InvalidDateError";
	}
}

/** Parse a query/body date. Throws InvalidDateError (routes answer 400) for garbage. */
export function parseDateParam(value: unknown, field: string): Date {
	if (typeof value !== "string" || value.trim() === "" || value.length > 40)
		throw new InvalidDateError(field);
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) throw new InvalidDateError(field);
	return d;
}
