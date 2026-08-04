import { describe, expect, it } from "vitest";

import { createRegistrationGate } from "./registration-gate";

/** A promise plus the handle to settle it from the test body. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("createRegistrationGate", () => {
  it("returns the registration's result", async () => {
    const gate = createRegistrationGate();
    await expect(gate.run(() => Promise.resolve("token"))).resolves.toBe("token");
  });

  it("settles immediately when nothing is registering", async () => {
    const gate = createRegistrationGate();
    await expect(gate.settle(0)).resolves.toBeUndefined();
  });

  it("orders the revocation after an in-flight registration", async () => {
    const gate = createRegistrationGate();
    const registration = deferred<void>();
    const order: string[] = [];

    const running = gate.run(async () => {
      await registration.promise;
      order.push("registered");
    });
    const settled = gate.settle(1_000).then(() => order.push("revoked"));

    registration.resolve();
    await Promise.all([running, settled]);
    expect(order).toEqual(["registered", "revoked"]);
  });

  it("aborts a registration that outlives the grace period", async () => {
    const gate = createRegistrationGate();
    const running = gate.run(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("aborted"));
        }),
    );

    await gate.settle(0);
    await expect(running).resolves.toBe("aborted");
  });

  it("aborts the registration when its caller does", async () => {
    const gate = createRegistrationGate();
    const controller = new AbortController();
    const running = gate.run(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("aborted"));
        }),
      controller.signal,
    );

    controller.abort();
    await expect(running).resolves.toBe("aborted");
  });

  it("starts already-cancelled when its caller aborted first", async () => {
    const gate = createRegistrationGate();
    const controller = new AbortController();
    controller.abort();
    await expect(
      gate.run((signal) => Promise.resolve(signal.aborted), controller.signal),
    ).resolves.toBe(true);
  });

  it("stops tracking a finished registration", async () => {
    const gate = createRegistrationGate();
    const controller = new AbortController();
    await gate.run((signal) => Promise.resolve(signal.aborted));
    // A later settle must not abort the signal of a registration already done,
    // nor wait on it.
    await gate.settle(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it("waits on the newest registration when one replaces another", async () => {
    const gate = createRegistrationGate();
    const first = deferred<string>();
    const second = deferred<string>();
    const order: string[] = [];

    const firstRun = gate.run(() => first.promise).then((value) => order.push(value));
    const secondRun = gate.run(() => second.promise).then((value) => order.push(value));
    const settled = gate.settle(1_000).then(() => order.push("revoked"));

    second.resolve("second");
    first.resolve("first");
    await Promise.all([firstRun, secondRun, settled]);
    expect(order.at(-1)).toBe("revoked");
    expect(order).toContain("second");
  });
});
