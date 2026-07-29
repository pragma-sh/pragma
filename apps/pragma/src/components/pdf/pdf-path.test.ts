import { describe, expect, it } from "vitest";

import { isPdfPath } from "@/components/pdf/pdf-path";

describe("isPdfPath", () => {
  it("matches .pdf files regardless of case or directory", () => {
    expect(isPdfPath("docs/spec.pdf")).toBe(true);
    expect(isPdfPath("Report.PDF")).toBe(true);
  });

  it("rejects anything else the code editor still owns", () => {
    expect(isPdfPath(null)).toBe(false);
    expect(isPdfPath("notes.md")).toBe(false);
    expect(isPdfPath("pdf")).toBe(false);
    // A name that merely contains ".pdf" is not a PDF.
    expect(isPdfPath("spec.pdf.txt")).toBe(false);
  });
});
