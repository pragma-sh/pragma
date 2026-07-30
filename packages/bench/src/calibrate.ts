/**
 * Machine-speed calibration for the TypeScript tiers.
 *
 * Mirrors `calibrate()` in `src/report.rs` in intent, not in exact arithmetic:
 * the two never have to agree with each other, because a report is always
 * compared against a baseline recorded by the *same* tier. What matters is that
 * a tier's probe is stable within a machine and proportional between machines,
 * so dividing a wall-time metric by it cancels out hardware differences.
 */

/** Iterations of the probe. Sized to run for tens of milliseconds. */
const ITERATIONS = 20_000_000;

/**
 * Times a fixed, allocation-free integer loop.
 *
 * `Math.imul` keeps the multiply in 32-bit integer space so the JIT cannot turn
 * it into float arithmetic whose cost varies with the values involved, and the
 * accumulated result is returned so nothing can be eliminated as dead code.
 */
export function calibrateNs(): number {
  const started = performance.now();
  let state = 0x243f6a88 | 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    state ^= state >>> 15;
  }
  const elapsed = performance.now() - started;
  // Consume `state` so the loop cannot be optimised away entirely.
  const guard = state === 0 ? 1 : 0;
  // Never return zero: the audit divides by this.
  return Math.max(1, Math.round(elapsed * 1e6) + guard);
}
