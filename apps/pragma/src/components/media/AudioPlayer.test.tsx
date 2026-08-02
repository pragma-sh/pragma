import { describe, expect, it } from "vitest";

import { formatMediaTime } from "@/components/media/AudioPlayer";

describe("formatMediaTime", () => {
  it("formats short clips as m:ss", () => {
    expect(formatMediaTime(0)).toBe("0:00");
    expect(formatMediaTime(9.9)).toBe("0:09");
    expect(formatMediaTime(65)).toBe("1:05");
  });

  it("formats hour-long clips as h:mm:ss", () => {
    expect(formatMediaTime(3600)).toBe("1:00:00");
    expect(formatMediaTime(3723)).toBe("1:02:03");
  });

  it("treats non-finite values as zero", () => {
    expect(formatMediaTime(Number.NaN)).toBe("0:00");
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatMediaTime(-4)).toBe("0:00");
  });
});
