export interface AutomationLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface AutomationFsClient {
  find(path: string, options?: { name?: string; minBytes?: number }): Promise<string[]>;
}

export interface AutomationContext {
  log: AutomationLogger;
  paths: {
    project: string;
    worktree: string;
    global: boolean;
  };
  fs: AutomationFsClient;
  git: Record<string, never>;
}

export type AutomationTrigger =
  | { type: "cron"; schedule: string }
  | {
      type: "event";
      listen: (
        ctx: AutomationContext,
        fire: (payload?: unknown) => void,
      ) => (() => void) | void | Promise<(() => void) | void>;
    };

export interface AutomationDefinition {
  name: string;
  description: string;
  trigger: AutomationTrigger;
  run: (ctx: AutomationContext, payload?: unknown) => void | Promise<void>;
  readonly pragmaAutomation: true;
}

export interface DefineAutomationInput {
  name: string;
  description: string;
  trigger: AutomationTrigger;
  run: (ctx: AutomationContext, payload?: unknown) => void | Promise<void>;
}

/** Defines one Pragma automation. Export the returned value as the file default. */
export function defineAutomation(definition: DefineAutomationInput): AutomationDefinition {
  return { ...definition, pragmaAutomation: true };
}
