/**
 * pi's `Model` objects carry no release-date field, but most model ids encode
 * one as a suffix (`claude-sonnet-4-5-20250929`, `gpt-5-2025-08-07`,
 * `claude-3-5-haiku-20241022`). We parse that to approximate model age for the
 * recency filter in {@link selectModel}.
 */

/** A minimal shape of the parts of a pi model we read for dating. */
export interface DatedModel {
  id: string;
  name?: string;
}

const DATE_PATTERN = /(20\d{2})-?(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01])/;

/**
 * Extract the release date encoded in a model id or name, or `null` when none
 * is present. Accepts `YYYYMMDD` and `YYYY-MM-DD` forms.
 */
export function parseModelReleaseDate(model: DatedModel): Date | null {
  for (const candidate of [model.id, model.name ?? ""]) {
    const match = DATE_PATTERN.exec(candidate);
    if (!match) continue;
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Whether `date` is more than `months` months before `now` (default: current
 * time).
 */
export function isOlderThanMonths(date: Date, months: number, now: Date = new Date()): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return date.getTime() < cutoff.getTime();
}

/**
 * True when a model is recent enough to consider. Models with no parseable
 * release date are kept (their age is unknown, so we do not exclude them).
 */
export function isModelRecent(model: DatedModel, maxAgeMonths: number, now?: Date): boolean {
  const date = parseModelReleaseDate(model);
  if (!date) return true;
  return !isOlderThanMonths(date, maxAgeMonths, now);
}
