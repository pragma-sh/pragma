import { useState, type FormEvent } from "react";

import { useNotify, useSdk } from "@pragma/plugin";
import { Button } from "@pragma/plugin/ui";

const fieldStyle = { display: "grid", gap: 4 } as const;
const inputStyle = {
  border: "1px solid currentColor",
  borderRadius: 6,
  padding: "6px 8px",
} as const;

/** Plugin Settings page exercising the SDK agent-board draft API. */
export function DevTestSettingsPage() {
  const sdk = useSdk();
  const notify = useNotify();
  const [prompt, setPrompt] = useState("Create a small README improvement");
  const [worktreeId, setWorktreeId] = useState("");
  const [agentId, setAgentId] = useState("opencode");
  const [modelId, setModelId] = useState("");
  const [reasoningId, setReasoningId] = useState("");
  const [busy, setBusy] = useState(false);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const card = await sdk.createBoardDraft({
        prompt,
        worktreeId,
        agentId,
        modelId: modelId || null,
        reasoningId: reasoningId || null,
      });
      notify("Board draft created", {
        variant: "success",
        description: `${card.branchName}: ${card.id}`,
      });
    } catch (cause) {
      notify("Board draft failed", {
        variant: "error",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h2>Dev Test Plugin</h2>
        <p>Create an agent-board draft through the public Pragma SDK.</p>
      </div>
      <form onSubmit={createDraft} style={{ display: "grid", gap: 12 }}>
        <label style={fieldStyle}>
          Worktree ID
          <input
            required
            style={inputStyle}
            value={worktreeId}
            onChange={(event) => setWorktreeId(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          Agent ID
          <input
            required
            style={inputStyle}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          Model ID
          <input
            placeholder="Use agent default"
            style={inputStyle}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          Reasoning level
          <input
            placeholder="Use automatic reasoning"
            style={inputStyle}
            value={reasoningId}
            onChange={(event) => setReasoningId(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          Prompt
          <textarea
            required
            rows={5}
            style={inputStyle}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !worktreeId || !agentId || !prompt}>
          {busy ? "Creating..." : "Create board draft"}
        </Button>
      </form>
    </div>
  );
}
