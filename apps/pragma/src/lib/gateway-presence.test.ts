import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isFocusedMock = vi.fn<() => Promise<boolean>>();
const presenceMock = vi.fn<(payload: { focused: boolean }) => Promise<void>>();
let focusListener: ((event: { payload: boolean }) => void) | null = null;
let visibilityListener: (() => void) | null = null;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: () => isFocusedMock(),
    onFocusChanged: (listener: (event: { payload: boolean }) => void) => {
      focusListener = listener;
      return Promise.resolve(() => undefined);
    },
  }),
}));

vi.mock("@/lib/tauri", () => ({
  gatewayConnectionInfo: () => Promise.resolve({ baseUrl: "http://127.0.0.1:1", token: "t" }),
}));

vi.mock("@pragma/sdk", () => ({
  PragmaClient: class {
    push = { presence: (payload: { focused: boolean }) => presenceMock(payload) };
  },
}));

/**
 * Starts a fresh copy of the module. Its state is module-level and it never
 * stops, so each test gets its own instance and drives only that instance's
 * listeners.
 */
async function start(): Promise<void> {
  vi.resetModules();
  const { startGatewayPresenceReporting } = await import("./gateway-presence");
  startGatewayPresenceReporting();
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  visibilityListener?.();
}

/** The `focused` values reported to the gateway, in order. */
async function reported(count: number): Promise<boolean[]> {
  await vi.waitFor(() => expect(presenceMock).toHaveBeenCalledTimes(count));
  return presenceMock.mock.calls.map(([payload]) => payload.focused);
}

describe("startGatewayPresenceReporting", () => {
  beforeEach(() => {
    focusListener = null;
    visibilityListener = null;
    presenceMock.mockReset();
    presenceMock.mockResolvedValue(undefined);
    isFocusedMock.mockReset();
    isFocusedMock.mockResolvedValue(true);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
      if (type === "visibilitychange") visibilityListener = listener as () => void;
    });
    // The heartbeat is an interval of seconds; keep it out of the test's way.
    vi.spyOn(window, "setInterval").mockReturnValue(
      1 as unknown as ReturnType<typeof window.setInterval>,
    );
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the window's focus at startup and heartbeats it", async () => {
    await start();
    await expect(reported(1)).resolves.toEqual([true]);
    expect(window.setInterval).toHaveBeenCalledTimes(1);
  });

  it("resumes the focused heartbeat when a hidden window becomes visible again", async () => {
    await start();
    await reported(1);

    setVisibility("hidden");
    await expect(reported(2)).resolves.toEqual([true, false]);

    // No Tauri focus change accompanies a restore, so visibility alone has to
    // put the window back into the focused state.
    setVisibility("visible");
    await expect(reported(3)).resolves.toEqual([true, false, true]);
    expect(window.setInterval).toHaveBeenCalledTimes(2);
  });

  it("stays unfocused when an unfocused window becomes visible", async () => {
    isFocusedMock.mockResolvedValue(false);
    await start();
    await reported(1);

    setVisibility("hidden");
    setVisibility("visible");
    // Nothing changed: the window was never focused.
    await expect(reported(1)).resolves.toEqual([false]);
  });

  it("does not report a focus change that lands while hidden", async () => {
    await start();
    await reported(1);
    setVisibility("hidden");
    await reported(2);

    focusListener?.({ payload: false });
    focusListener?.({ payload: true });
    await expect(reported(2)).resolves.toEqual([true, false]);

    setVisibility("visible");
    await expect(reported(3)).resolves.toEqual([true, false, true]);
  });

  it("follows OS focus changes while visible", async () => {
    await start();
    await reported(1);

    focusListener?.({ payload: false });
    await expect(reported(2)).resolves.toEqual([true, false]);

    focusListener?.({ payload: true });
    await expect(reported(3)).resolves.toEqual([true, false, true]);
  });

  it("starts hidden when the window is not on screen at launch", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await start();
    await expect(reported(1)).resolves.toEqual([false]);
    expect(window.setInterval).not.toHaveBeenCalled();
  });
});
