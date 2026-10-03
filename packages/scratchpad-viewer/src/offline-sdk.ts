/** SDK names whose functions are pure local helpers, without gateway access. */
const LOCAL_EXPORTS = new Set([
  "base64ToBytes",
  "bytesToBase64",
  "runtimeAgentId",
  "promptAgent",
  "scratchpadBridge",
]);

/** An empty stream also supports the methods of an agent connection as no-ops. */
function offlineClient(): unknown {
  const members = new Map<PropertyKey, unknown>();
  return new Proxy(() => undefined, {
    get(_target, key) {
      // Avoid becoming a thenable: awaiting a connection must settle immediately.
      if (key === "then") return undefined;
      if (key === Symbol.asyncIterator) return async function* emptyStream() {};
      if (key === Symbol.iterator) return function* emptyIterator() {};
      if (!members.has(key)) members.set(key, offlineMethod(String(key)));
      return members.get(key);
    },
    apply: () => Promise.resolve(undefined),
  });
}

function offlineMethod(name: string): unknown {
  // Namespace properties are callable proxies, so both client.fs.readFile() and
  // directly constructed namespace clients stay disconnected.
  return new Proxy(() => undefined, {
    get(_target, key) {
      if (key === "then") return undefined;
      if (key === Symbol.asyncIterator) return async function* emptyStream() {};
      return offlineMethod(String(key));
    },
    apply() {
      if (name === "subscribe" || name === "stream") return offlineClient();
      if (name === "connect") return Promise.resolve(offlineClient());
      if (
        name.startsWith("list") ||
        name.startsWith("search") ||
        name === "getScratchpads" ||
        name === "getComments"
      )
        return Promise.resolve([]);
      if (name === "sendAttached") return Promise.resolve({ delivered: false });
      return Promise.resolve(undefined);
    },
  });
}

/** Replaces SDK host APIs with disconnected stubs, preserving local utilities. */
export function offlineScratchpadScope<T extends object>(source: T): T {
  const scope: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "function" || LOCAL_EXPORTS.has(name) || name.endsWith("Error")) {
      scope[name] = value;
    } else if (name.endsWith("Client")) {
      // A normal function can be constructed and returns this inert proxy instead
      // of creating a real SDK transport or consulting environment credentials.
      scope[name] = offlineClient;
    } else if (name === "hasPragmaEnvironment") {
      scope[name] = () => false;
    } else if (name === "readEnv") {
      scope[name] = () => undefined;
    } else if (name === "awaitAgentAnswer" || name === "awaitAgentDecision") {
      scope[name] = async () => null;
    } else {
      scope[name] = async () => undefined;
    }
  }
  return scope as T;
}
