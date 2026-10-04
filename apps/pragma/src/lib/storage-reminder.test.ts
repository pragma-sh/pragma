import { constants } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import {
  formatLocalDate,
  latestDueReminder,
  nextReminder,
  parseLocalDate,
  reminderIntervalDays,
  reminderOwed,
} from "./storage-reminder";

const at = (value: string, hour = 12) => {
  const date = parseLocalDate(value);
  if (!date) throw new Error(`bad date ${value}`);
  date.setHours(hour);
  return date;
};

describe("storage reminder schedule", () => {
  const weekly = { enabled: true, startDate: "2026-09-01", intervalDays: 7 };

  it("round-trips local calendar dates and rejects malformed ones", () => {
    expect(formatLocalDate(at("2026-02-28"))).toBe("2026-02-28");
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("09/01/2026")).toBeNull();
    expect(parseLocalDate(undefined)).toBeNull();
  });

  it("falls back to the shipped interval", () => {
    expect(reminderIntervalDays({ enabled: true })).toBe(constants.storage.reminderIntervalDays);
    expect(reminderIntervalDays({ intervalDays: 0 })).toBe(constants.storage.reminderIntervalDays);
    expect(reminderIntervalDays(weekly)).toBe(7);
  });

  it("finds the latest due occurrence", () => {
    expect(latestDueReminder(weekly, at("2026-08-31"))).toBeNull();
    expect(formatLocalDate(latestDueReminder(weekly, at("2026-09-01"))!)).toBe("2026-09-01");
    expect(formatLocalDate(latestDueReminder(weekly, at("2026-09-14", 23))!)).toBe("2026-09-08");
    expect(formatLocalDate(latestDueReminder(weekly, at("2026-09-15", 0))!)).toBe("2026-09-15");
  });

  it("schedules the next occurrence after now", () => {
    expect(formatLocalDate(nextReminder(weekly, at("2026-08-20"))!)).toBe("2026-09-01");
    expect(formatLocalDate(nextReminder(weekly, at("2026-09-10"))!)).toBe("2026-09-15");
    expect(nextReminder({ ...weekly, enabled: false }, at("2026-09-10"))).toBeNull();
  });

  it("owes a reminder only until that occurrence is acknowledged", () => {
    const now = at("2026-09-10");
    expect(formatLocalDate(reminderOwed(weekly, null, now)!)).toBe("2026-09-08");
    expect(reminderOwed(weekly, "2026-09-08", now)).toBeNull();
    expect(formatLocalDate(reminderOwed(weekly, "2026-09-01", now)!)).toBe("2026-09-08");
    expect(reminderOwed({ ...weekly, enabled: false }, null, now)).toBeNull();
  });
});
