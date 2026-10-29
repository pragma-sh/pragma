/** Offline replay of normalized computer snapshots and recorded decision answers. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseEvaluateResponse } from "@pragma-sh/system1";
import type { ComputerDecideRequest } from "@pragma-sh/constants";
import { computerDecision, computerQuestions } from "../src/computer-use";

const path =
  process.argv[2] ??
  fileURLToPath(new URL("../src/fixtures/computer-replay.json", import.meta.url));
const fixtures = JSON.parse(readFileSync(path, "utf8")) as {
  name: string;
  request: ComputerDecideRequest;
  response: unknown;
  expectedKind: string;
}[];
let passed = 0;
const started = performance.now();
for (const fixture of fixtures) {
  const questions = computerQuestions(fixture.request);
  const parsed = parseEvaluateResponse(questions, fixture.response);
  const decision = computerDecision(fixture.request, parsed.answers);
  if (decision.kind !== fixture.expectedKind)
    throw new Error(`${fixture.name}: expected ${fixture.expectedKind}, got ${decision.kind}`);
  passed++;
}
console.log(
  JSON.stringify({
    fixtures: passed,
    elapsedMs: Math.round(performance.now() - started),
    note: "Offline fixture replay; no live model accuracy or OS behavior measured.",
  }),
);
