// src/pragma-watcher.ts
var DEFAULT_APPROVE_KEYS = "\r";
var RIGHT_ARROW = "\x1B[C";
var DOWN_ARROW = "\x1B[B";
var DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
var DEFAULT_SUBMIT_KEYS = "\r";
var QUESTION_REJECT_KEYS = "\x1B";
var QUESTION_DIGIT_MAX = 9;
var QUESTION_OTHER_INPUT_DELAY_MS = 150;
var CLAUDE_INTERJECT_SUBMIT_DELAY_MS = 200;
var RESUBSCRIBE_DELAY_MS = 500;
function createBuiltinWatcher(agent, handleDecisions, interjectSubmitDelayMs = 0) {
  return {
    agent,
    async watch(ctx) {
      const keys = resolveKeys(ctx.config);
      const seenRequestIds = new Set();
      const questionOptionsByRequestId = new Map();
      while (!ctx.signal.aborted) {
        try {
          await consumeControlEvents(
            ctx,
            keys,
            handleDecisions,
            interjectSubmitDelayMs,
            seenRequestIds,
            questionOptionsByRequestId,
          );
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
var claudeCodeInterjectWatcher = createBuiltinWatcher(
  "claude-code",
  false,
  CLAUDE_INTERJECT_SUBMIT_DELAY_MS,
);
var cursorInterjectWatcher = createBuiltinWatcher("cursor", false);
function resolveKeys(config) {
  const c = config ?? {};
  return {
    approveKeys: c.approveKeys ?? DEFAULT_APPROVE_KEYS,
    denyKeys: c.denyKeys ?? DEFAULT_DENY_KEYS,
    submitKeys: c.submitKeys ?? DEFAULT_SUBMIT_KEYS,
  };
}
async function consumeControlEvents(
  ctx,
  keys,
  handleDecisions,
  interjectSubmitDelayMs,
  seenRequestIds,
  questionOptionsByRequestId,
) {
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
    await handleControlEvent(
      ctx,
      keys,
      handleDecisions,
      interjectSubmitDelayMs,
      seenRequestIds,
      questionOptionsByRequestId,
      event,
    );
  }
}
async function handleControlEvent(
  ctx,
  keys,
  handleDecisions,
  interjectSubmitDelayMs,
  seenRequestIds,
  questionOptionsByRequestId,
  event,
) {
  if (event.type === "agent" && handleDecisions) {
    rememberQuestionOptions(questionOptionsByRequestId, event);
    return;
  }
  if (handleDecisions && (await handleDecision(ctx, keys, seenRequestIds, event))) {
    return;
  }
  if (
    handleDecisions &&
    (await handleAnswer(ctx, seenRequestIds, questionOptionsByRequestId, event))
  ) {
    return;
  }
  if (event.type === "agentInput") {
    await handleInterjection(ctx, keys.submitKeys, interjectSubmitDelayMs, event.input.text);
  }
}
async function handleDecision(ctx, keys, seenRequestIds, event) {
  if (event.type !== "agentDecision") return false;
  if (seenRequestIds.has(event.decision.requestId)) return true;
  seenRequestIds.add(event.decision.requestId);
  await writeKeys(ctx, event.decision.approved ? keys.approveKeys : keys.denyKeys);
  return true;
}
async function handleAnswer(ctx, seenRequestIds, questionOptionsByRequestId, event) {
  if (event.type !== "agentAnswer") return false;
  const { answer } = event;
  if (seenRequestIds.has(answer.requestId)) return true;
  seenRequestIds.add(answer.requestId);
  const options = questionOptionsByRequestId.get(answer.requestId) ?? [];
  questionOptionsByRequestId.delete(answer.requestId);
  const reply = answer.answer?.trim() ?? null;
  if (!answer.dismissed && reply && !options.includes(reply)) {
    await writeFreeTextAnswer(ctx, options.length, reply);
    return true;
  }
  const strokes = questionAnswerKeys({ dismissed: answer.dismissed, reply, options });
  if (strokes) await writeKeys(ctx, strokes);
  return true;
}
async function writeFreeTextAnswer(ctx, optionCount, reply) {
  await writeKeys(ctx, openOtherEditorKeys(optionCount));
  await delay(QUESTION_OTHER_INPUT_DELAY_MS, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, `${reply}\r`);
}
async function handleInterjection(ctx, submitKeys, submitDelayMs, text) {
  if (submitDelayMs <= 0 || !submitKeys) {
    await writeKeys(ctx, `${text}${submitKeys}`);
    return;
  }
  await writeKeys(ctx, text);
  await delay(submitDelayMs, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, submitKeys);
}
function rememberQuestionOptions(cache, event) {
  if (
    event.status === "attention" &&
    event.attentionKind === "question" &&
    typeof event.requestId === "string" &&
    event.requestId.length > 0
  ) {
    const options = (event.options ?? [])
      .map((option) => option.label)
      .filter((option) => option.trim() !== "");
    cache.set(event.requestId, options);
  }
}
function questionAnswerKeys(input) {
  if (input.dismissed || input.reply === null) {
    return QUESTION_REJECT_KEYS;
  }
  const reply = input.reply.trim();
  if (!reply) {
    return QUESTION_REJECT_KEYS;
  }
  const options = input.options;
  const matchIndex = options.findIndex((option) => option === reply);
  if (matchIndex >= 0) {
    return selectOptionKeys(matchIndex, options.length);
  }
  return `${openOtherEditorKeys(options.length)}${reply}\r`;
}
function openOtherEditorKeys(optionCount) {
  return `${DOWN_ARROW.repeat(optionCount)}\r`;
}
function selectOptionKeys(index, optionCount) {
  const total = optionCount + 1;
  if (index < QUESTION_DIGIT_MAX && index < total) {
    return String(index + 1);
  }
  return `${DOWN_ARROW.repeat(index)}\r`;
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
  questionAnswerKeys,
  opencodeApprovalWatcher,
  pragma_watcher_default as default,
  cursorInterjectWatcher,
  claudeCodeInterjectWatcher,
};
