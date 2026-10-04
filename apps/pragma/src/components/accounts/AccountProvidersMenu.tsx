import { useMemo, useState } from "react";

import type { AccountBindingScope } from "@pragma-sh/constants";
import { CircleUserRound, Plus, Settings2 } from "lucide-react";
import { toast } from "sonner";

import { AddAccountDialog, type AddAccountTarget } from "@/components/accounts/AddAccountDialog";
import type { HarnessAccountActions } from "@/components/accounts/HarnessAccountSelect";
import { ProviderSection } from "@/components/accounts/ProviderSection";
import { ProviderMicroBars } from "@/components/accounts/UsageBar";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentsList } from "@/hooks/use-agents-list";
import { buildProviderViews, inUseProviders, switchScope, type HarnessView } from "@/lib/accounts";
import { errorMessage } from "@/lib/errors";
import { useProjectAccounts, type ProjectAccounts } from "@/state/accounts-store";

/**
 * The toolbar's Account providers menu: every account the project's host knows
 * about, grouped by provider. Under each provider's accounts, every harness has
 * a row whose account select is the menu's only way to switch.
 */
export function AccountProvidersMenu({
  isRemote,
  onOpenSettings,
  projectId,
}: {
  isRemote: boolean;
  onOpenSettings: () => void;
  projectId: string | null;
}) {
  const { state, store } = useProjectAccounts(projectId);
  const providers = useProviderViews(state);
  const shown = useMemo(() => inUseProviders(providers), [providers]);
  const [addTarget, setAddTarget] = useState<AddAccountTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const startAdd = (target: AddAccountTarget | null) => {
    setAddTarget(target);
    setAdding(true);
  };
  if (!state.list || state.list.providers.length === 0) {
    return null;
  }
  const list = state.list;
  const actions = rowActions(store, (harness) =>
    startAdd({ provider: harness.source.provider, agentId: harness.agentId }),
  );
  return (
    <>
      <Popover
        onOpenChange={(open) => {
          if (open) {
            void store.reload(true);
            store.refreshUsageNow();
          }
        }}
      >
        <PopoverTrigger asChild>
          {/* Sized to its content: up to six usage bars sit beside the icon, and a
              square icon button clipped them. */}
          <IconButton
            className="gap-1.5 border-border/60 bg-muted/40 px-2 text-muted-foreground"
            label="Account providers"
            size="sm"
            variant="ghost"
          >
            <CircleUserRound className="size-3.5" />
            <ProviderMicroBars providers={shown} />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-96 gap-1 p-2">
          <PopoverHeader className="flex-row items-center justify-between px-2 py-1">
            <PopoverTitle>Account providers</PopoverTitle>
            <span className="flex-1" />
            <IconButton
              label="Add account"
              onClick={() => startAdd(null)}
              size="icon-sm"
              variant="ghost"
            >
              <Plus />
            </IconButton>
            <IconButton
              label="Manage accounts"
              onClick={onOpenSettings}
              size="icon-sm"
              variant="ghost"
            >
              <Settings2 />
            </IconButton>
          </PopoverHeader>
          <div className="flex max-h-[28rem] flex-col gap-2 overflow-auto">
            {shown.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No harness is using an account yet. Add one, or manage accounts in Settings.
              </p>
            ) : null}
            {shown.map((provider) => (
              <ProviderSection
                actions={actions}
                isRemote={isRemote}
                key={provider.provider}
                list={list}
                provider={provider}
              />
            ))}
          </div>
          <p className="border-t px-2 pt-2 text-[11px] text-muted-foreground">
            Switching applies to all projects, except ones that chose their own account. Running
            sessions keep the account they started with.
          </p>
        </PopoverContent>
      </Popover>
      <AddAccountDialog
        isRemote={isRemote}
        onOpenChange={setAdding}
        open={adding}
        providers={providers}
        store={store}
        target={addTarget}
      />
    </>
  );
}

/** Provider views with harness names from the agent launcher. */
export function useProviderViews(state: ReturnType<typeof useProjectAccounts>["state"]) {
  const agents = useAgentsList();
  return useMemo(() => {
    if (!state.list) return [];
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    return buildProviderViews(
      { list: state.list, usage: state.usage },
      (agentId) => names.get(agentId) ?? agentId.split(".").pop() ?? agentId,
    );
  }, [agents, state.list, state.usage]);
}

/** Reports a failed switch without leaving an unhandled rejection. */
function run(work: Promise<void>): Promise<unknown> {
  return work.catch((cause: unknown) =>
    toast.error(`Couldn't switch accounts: ${errorMessage(cause)}`),
  );
}

/**
 * The harness selects' actions. The menu writes the scope the select already shows
 * (see `switchScope`); Settings pins `scope` to the page's own.
 */
export function rowActions(
  store: ProjectAccounts,
  signIn: HarnessAccountActions["signIn"],
  scope?: AccountBindingScope,
): HarnessAccountActions {
  const clear = (harness: HarnessView, bindingScope: AccountBindingScope) =>
    void run(
      store.setBinding({
        agentId: harness.agentId,
        provider: harness.source.provider,
        accountKey: null,
        scope: bindingScope,
      }),
    );
  return {
    assign: (harnesses, account) =>
      void run(
        store.setBindings(
          harnesses.map((harness) => ({
            agentId: harness.agentId,
            provider: account.provider,
            accountKey: account.key,
            scope: scope ?? switchScope(harness),
          })),
        ),
      ),
    signIn,
    resetOverride: (harness) => clear(harness, "project"),
    ...(scope === "global"
      ? { followOwnLogin: (harness: HarnessView) => clear(harness, "global") }
      : {}),
  };
}
