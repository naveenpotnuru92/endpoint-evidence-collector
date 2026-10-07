// Explicit timezone ↔ UTC conversion (no external libs). Used so date inputs are never silently interpreted in the browser's zone.

/** Offset (ms) of `tz` from UTC at the given UTC instant. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of dtf.formatToParts(new Date(utcMs))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a wall-clock "YYYY-MM-DDTHH:mm" in `tz` to a UTC ISO string "YYYY-MM-DDTHH:mm:00Z". Returns null if unparseable. */
export function zonedToUtcIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  try {
    let utc = guess - tzOffsetMs(guess, tz);
    utc = guess - tzOffsetMs(utc, tz);               // second pass handles DST boundaries
    return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch { return null; }
}

export function isValidTz(tz: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }

export const COMMON_TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];

/** UTC ISO → "YYYY-MM-DDTHH:mm" wall-clock in `tz` (for populating datetime-local inputs). */
export function utcIsoToZonedLocal(iso: string | null, tz: string): string {
  if (!iso) return ""; const ms = Date.parse(iso); if (Number.isNaN(ms)) return "";
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 16);
}
