import { constants, type AgentReportPayload } from "@pragma/constants";

/**
 * Where an agent report came from, in names a person recognises. Every field is
 * optional: a report can arrive for a worktree whose project has not been loaded
 * yet, and a tab the user never renamed has no name of its own.
 */
export interface AgentAlertLocation {
  projectName?: string | null;
  worktreeName?: string | null;
  tabName?: string | null;
}

const text = constants.agentStatus.notificationText;

/** Substitutes `{key}` placeholders; an unknown placeholder is left as-is. */
function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Headline for an alert: the agent's display name plus what it wants. Mirrored
 * by the gateway's Rust renderer so a phone push reads like the desktop toast.
 */
export function agentAlertTitle(payload: AgentReportPayload, agentName: string): string {
  const values = { agent: agentName };
  if (payload.status === "done") {
    return render(text.doneTitle, values);
  }
  if (payload.attentionKind === "command") {
    return render(text.commandTitle, values);
  }
  if (payload.attentionKind === "question") {
    return render(text.questionTitle, values);
  }
  return render(text.attentionTitle, values);
}

/**
 * Body for an alert: which project/worktree (and tab) the agent is in, so a
 * notification is actionable without opening the app first.
 */
export function agentAlertBody(location: AgentAlertLocation = {}): string {
  const place = [location.projectName, location.worktreeName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(text.locationSeparator);
  const tab = location.tabName?.trim();
  if (!place) {
    // Nothing to hang the suffix off, so drop its leading separator ("· tab …").
    return tab ? render(text.tabSuffix, { tab }).replace(/^\W+/u, "") : text.unknownLocation;
  }
  return tab ? `${place}${render(text.tabSuffix, { tab })}` : place;
}
