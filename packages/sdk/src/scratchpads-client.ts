// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import {
  attachScratchpadAgent,
  createScratchpadComment,
  parseScratchpadComments,
  parseScratchpadDocument,
  scratchpadCommentsPath,
  serializeScratchpadComments,
  type ScratchpadComment,
} from "@pragma/scratchpad-contract";

import type { AgentsClient } from "./agents-client";
import type { FsClient } from "./fs-client";
import { routes } from "./routes";
import type { Transport } from "./transport";
import type {
  AttachScratchpadAgentOptions,
  CommentScratchpadOptions,
  GetScratchpadsOptions,
  ScratchpadFile,
  ScratchpadRef,
  SendAttachedOptions,
  SendAttachedResult,
} from "./types/scratchpads";

/**
 * Gateway namespace for a worktree's managed scratchpads.
 *
 * The host lists the worktree's scratchpad directory and parses each file's
 * managed frontmatter, so every client sees the same contract the desktop does:
 * the MDX source plus the agent tab the scratchpad is attached to.
 *
 * Everything past {@link ScratchpadsClient.getScratchpads} is composed from the
 * filesystem and agent namespaces rather than served by a route of its own, but
 * belongs here because the composition *is* the contract: the comment thread
 * lives in a sibling file whose name only `@pragma/scratchpad-contract` knows,
 * the attachment lives in managed frontmatter, and a prompt has to be addressed
 * to the running agent's runtime id rather than its catalog id. Re-deriving any
 * of that per client is how the three drift apart.
 */
export class ScratchpadsClient {
  constructor(
    private readonly transport: Transport,
    private readonly fs: FsClient,
    private readonly agents: AgentsClient,
  ) {}

  /** Lists every managed scratchpad in one worktree, source included. */
  getScratchpads(options: GetScratchpadsOptions): Promise<ScratchpadFile[]> {
    const query = `?root=${encodeURIComponent(options.root)}`;
    return this.transport.request<ScratchpadFile[]>(`${routes.scratchpads}${query}`, {
      signal: options.signal,
    });
  }

  /**
   * Reads a scratchpad's comment thread. A scratchpad that was never commented
   * on has no sibling file, which reads as an empty thread rather than an error.
   */
  async getComments(options: ScratchpadRef): Promise<ScratchpadComment[]> {
    const path = scratchpadCommentsPath(options.filePath);
    const { root } = options;
    if (!(await this.fs.pathExists({ root, path }))) return [];
    const file = await this.fs.readFile({ root, path });
    if (file.binary || file.truncated) return [];
    return parseScratchpadComments(file.text);
  }

  /**
   * Appends one comment anchored to a rendered block and returns it.
   *
   * Read-modify-write against the whole file: the thread is small, and the
   * desktop rewrites it wholesale too, so a partial append would be the odd one
   * out. Concurrent callers must serialize their own writes.
   */
  async comment(options: CommentScratchpadOptions): Promise<ScratchpadComment> {
    const { root, filePath, block, text } = options;
    const comment = createScratchpadComment(
      block,
      text,
      options.createdAt ?? Date.now(),
      options.id ?? randomCommentId(),
    );
    const existing = await this.getComments({ root, filePath });
    await this.writeComments({ root, filePath }, [...existing, comment]);
    return comment;
  }

  /** Replaces a scratchpad's comment thread wholesale. */
  async setComments(options: ScratchpadRef, comments: readonly ScratchpadComment[]): Promise<void> {
    await this.writeComments(options, comments);
  }

  /**
   * Records the agent tab a scratchpad prompts, in its managed frontmatter.
   *
   * The attachment lives in the file rather than in client state so it survives
   * the session that created it and reads the same from every client.
   */
  async attachAgent(options: AttachScratchpadAgentOptions): Promise<void> {
    const { root, filePath, tabId, agentId } = options;
    const contents = options.contents ?? (await this.readScratchpad(root, filePath));
    await this.fs.writeFile({
      root,
      path: filePath,
      contents: attachScratchpadAgent(contents, { tabId, agentId }),
    });
  }

  /**
   * Sends text to the agent this scratchpad is attached to.
   *
   * Resolves `{ delivered: false }` when nothing is attached — the common case,
   * because a scratchpad outlives the session that wrote it — so a caller can
   * raise its own "attach an agent" UI instead of catching an error. Delivery
   * itself is fire-and-forget past the gateway: the watcher attached to that
   * session types the text into the agent's TUI, and a tab whose session has
   * already exited drops it.
   */
  async sendAttached(options: SendAttachedOptions): Promise<SendAttachedResult> {
    const { root, filePath, worktreeId, text } = options;
    const contents = options.contents ?? (await this.readScratchpad(root, filePath));
    const { metadata } = parseScratchpadDocument(contents);
    if (!metadata.agentTabId || !metadata.agentId) return { delivered: false };
    const agent = runtimeAgentId(metadata.agentId);
    await this.agents.reportInput(
      { agent, worktreeId, tabId: metadata.agentTabId, text },
      { signal: options.signal },
    );
    return { delivered: true, agent, tabId: metadata.agentTabId };
  }

  private async readScratchpad(root: string, filePath: string): Promise<string> {
    const file = await this.fs.readFile({ root, path: filePath });
    if (file.binary) throw new Error(`Scratchpad ${filePath} is not text.`);
    if (file.truncated) throw new Error(`Scratchpad ${filePath} was truncated by the host.`);
    return file.text;
  }

  private writeComments(
    options: ScratchpadRef,
    comments: readonly ScratchpadComment[],
  ): Promise<void> {
    return this.fs.writeFile({
      root: options.root,
      path: scratchpadCommentsPath(options.filePath),
      contents: serializeScratchpadComments(comments),
    });
  }
}

/**
 * The runtime agent id a report must carry.
 *
 * Frontmatter stores the catalog id (`plugin.agent`), while the agent event
 * stream is keyed by the plugin's own runtime id — its last segment. Sending
 * the qualified id makes the message invisible to the running agent.
 */
export function runtimeAgentId(agentId: string): string {
  return agentId.split(".").at(-1) ?? agentId;
}

/**
 * Comment id for callers that do not supply one. Deliberately not
 * `crypto.randomUUID`: this SDK also runs on React Native's Hermes, which does
 * not implement it.
 */
function randomCommentId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
