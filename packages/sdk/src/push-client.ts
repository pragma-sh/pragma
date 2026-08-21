// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import { routes } from "./routes";
import { Transport } from "./transport";

/** What a test push reached, and what the push service refused. */
export interface PushTestResult {
  /** How many registered phones the notification was addressed to. */
  sent: number;
  /** One line per message the push service rejected, with its reason. */
  errors: string[];
}

/** One phone registered for Expo push notifications on this host. */
export interface PushRegistration {
  /** Gateway device id (the `x-pragma-device-id` header the client sends). */
  deviceId: string;
  name: string;
  platform: string;
  /** Expo push token, or null once the device unregisters. */
  pushToken: string | null;
  registeredAt: number;
}

/** Push notification gateway namespace. */
export class PushClient {
  constructor(private readonly transport: Transport) {}

  /**
   * Registers (or refreshes) this installation's Expo push token, so agent
   * alerts reach the phone while it is away from the app. The device is
   * identified by the `x-pragma-device-id` header the client already sends.
   */
  register(payload: { token: string }, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.pushTokens, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  /** Stops push delivery to this installation (unpair, or notifications off). */
  unregister(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.pushTokens, {
      method: "DELETE",
      body: {},
      signal: options.signal,
    });
  }

  /** Lists every phone currently registered for push on this host. */
  list(options: { signal?: AbortSignal } = {}): Promise<PushRegistration[]> {
    return this.transport.request<PushRegistration[]>(routes.pushTokens, {
      method: "GET",
      signal: options.signal,
    });
  }

  /**
   * Sends a test notification to every registered phone and reports what the
   * push service made of it. `sent` counts the phones addressed; `errors`
   * carries a line per message the push service refused, which is the only
   * place a project-wide credential problem is ever named.
   */
  test(options: { signal?: AbortSignal } = {}): Promise<PushTestResult> {
    return this.transport.request<PushTestResult>(routes.pushTest, {
      method: "POST",
      body: {},
      signal: options.signal,
    });
  }

  /**
   * Reports whether the desktop window is focused. While a recent heartbeat says
   * it is, the gateway holds back phone pushes — the user is already looking at
   * the desktop alert. Heartbeats expire (`gateway.push.presenceTtlMs`), so a
   * desktop that dies without blurring stops suppressing on its own.
   */
  presence(payload: { focused: boolean }, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.pushPresence, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }
}
