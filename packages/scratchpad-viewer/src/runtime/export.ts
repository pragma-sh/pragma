import { installScratchpadFrameRuntime } from "../frame-runtime";

// Standalone exports have no host connection, even if embedded in another page.
globalThis.pragmaScratchpad = {
  agentFeedbackEnabled: false,
  promptAgent: async () => "cancelled",
  requestAgentAttachment: async () => false,
  subscribeAgentProgress: () => () => undefined,
  getWhiteboardSnapshot: async () => null,
};
installScratchpadFrameRuntime(true);
