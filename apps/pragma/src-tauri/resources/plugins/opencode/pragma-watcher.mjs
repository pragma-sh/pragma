// src/pragma-watcher.ts
var DEFAULT_APPROVE_KEYS = "\r";
var RIGHT_ARROW = "\x1B[C";
var DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
var DEFAULT_SUBMIT_KEYS = "\r";
var RESUBSCRIBE_DELAY_MS = 500;
function createBuiltinWatcher(agent, handleDecisions) {
  return {
    agent,
    // fallow-ignore-next-line complexity -- polling loop with reconnect is intentionally serial; breaking up would add more complexity
    async watch(ctx) {
      const config = ctx.config ?? {};
      const keys = {
        approveKeys: config.approveKeys ?? DEFAULT_APPROVE_KEYS,
        denyKeys: config.denyKeys ?? DEFAULT_DENY_KEYS,
        submitKeys: config.submitKeys ?? DEFAULT_SUBMIT_KEYS,
      };
      const seenRequestIds = new Set();
      while (!ctx.signal.aborted) {
        try {
          await consumeControlEvents(ctx, keys, handleDecisions, seenRequestIds);
        } catch {}
        if (ctx.signal.aborted) {
          return;
        }
        await delay(RESUBSCRIBE_DELAY_MS, ctx.signal);
      }
    },
  };
}
var opencodeApprovalWatcher = createBuiltinWatcher("opencode", true);
var claudeCodeInterjectWatcher = createBuiltinWatcher("claude-code", false);
var cursorInterjectWatcher = createBuiltinWatcher("cursor", false);
// fallow-ignore-next-line complexity -- sequential per-event decision handling; splitting would not reduce essential complexity
async function consumeControlEvents(ctx, keys, handleDecisions, seenRequestIds) {
  const connection = await ctx.sdk.agents.connect({
    agent: ctx.agentId,
    tabId: ctx.session.tabId,
    worktreeId: ctx.session.worktreeId,
    signal: ctx.signal,
  });
  for await (const event of connection) {
    if (ctx.signal.aborted) {
      return;
    }
    if (handleDecisions && event.type === "agentDecision") {
      const { decision } = event;
      if (seenRequestIds.has(decision.requestId)) {
        continue;
      }
      seenRequestIds.add(decision.requestId);
      await writeKeys(ctx, decision.approved ? keys.approveKeys : keys.denyKeys);
    } else if (event.type === "agentInput") {
      await writeKeys(ctx, `${event.input.text}${keys.submitKeys}`);
    }
  }
}
async function writeKeys(ctx, data) {
  try {
    await ctx.sendKeys(data);
  } catch {}
}
function delay(ms, signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
  });
}
var pragmaWatcher = {
  watchers: [opencodeApprovalWatcher, claudeCodeInterjectWatcher, cursorInterjectWatcher],
};
var pragma_watcher_default = pragmaWatcher;
export {
  opencodeApprovalWatcher,
  pragma_watcher_default as default,
  cursorInterjectWatcher,
  claudeCodeInterjectWatcher,
};
