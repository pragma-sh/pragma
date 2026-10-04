import { constants, type StorageReminderSettings } from "@pragma-sh/constants";

/**
 * The storage reminder's schedule: reminders fall on `startDate`, then every
 * `intervalDays` days after it, all at local midnight. Dates are local calendar
 * days (`YYYY-MM-DD`), never instants, so a reminder set for the 1st fires on
 * the 1st wherever the user happens to be.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a `YYYY-MM-DD` local calendar date; null when malformed. */
export function parseLocalDate(value: string | undefined): Date | null {
  const match = value ? ISO_DATE.exec(value) : null;
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const date = new Date(year, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a date as its local `YYYY-MM-DD` calendar day. */
export function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The interval in effect, falling back to the shipped default. */
export function reminderIntervalDays(settings: StorageReminderSettings | undefined): number {
  const days = settings?.intervalDays;
  return days !== undefined && Number.isInteger(days) && days >= 1
    ? days
    : constants.storage.reminderIntervalDays;
}

/** Adds whole calendar days, staying at local midnight across DST changes. */
function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The most recent reminder at or before `now`, or null when reminders are off
 * or the first one is still in the future.
 */
export function latestDueReminder(
  settings: StorageReminderSettings | undefined,
  now: Date,
): Date | null {
  if (!settings?.enabled) return null;
  const start = parseLocalDate(settings.startDate);
  if (!start || start > now) return null;
  const interval = reminderIntervalDays(settings);
  // Calendar-day distance, rounded so a DST-shortened day still counts as one.
  const elapsedDays = Math.round((now.getTime() - start.getTime()) / DAY_MS);
  let due = addDays(start, Math.floor(elapsedDays / interval) * interval);
  if (due > now) due = addDays(due, -interval);
  return due;
}

/** The next reminder strictly after `now`, or null when reminders are off. */
export function nextReminder(
  settings: StorageReminderSettings | undefined,
  now: Date,
): Date | null {
  if (!settings?.enabled) return null;
  const start = parseLocalDate(settings.startDate);
  if (!start) return null;
  if (start > now) return start;
  const latest = latestDueReminder(settings, now) ?? start;
  return addDays(latest, reminderIntervalDays(settings));
}

/**
 * Whether a reminder is owed: one has come due since the user last
 * acknowledged one (`acknowledged` is the due date they dismissed).
 */
export function reminderOwed(
  settings: StorageReminderSettings | undefined,
  acknowledged: string | null,
  now: Date,
): Date | null {
  const due = latestDueReminder(settings, now);
  if (!due) return null;
  const seen = parseLocalDate(acknowledged ?? undefined);
  return seen && seen >= due ? null : due;
}
