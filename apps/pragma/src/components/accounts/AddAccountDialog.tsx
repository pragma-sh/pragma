import { useEffect, useMemo, useState } from "react";

import type { AccountBindingScope, AccountLogin } from "@pragma-sh/constants";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ProviderIcon, providerIconSrc } from "@/components/accounts/ProviderIcon";
import { useAccountLogin, type AccountLoginFlow } from "@/components/accounts/use-account-login";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { HarnessView, ProviderView } from "@pragma-sh/accounts-view";
import { errorMessage } from "@/lib/errors";
import { browserOpenExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { ProjectAccounts } from "@pragma-sh/accounts-view";

/** Which harness a sign-in is for, when the caller already knows. */
export interface AddAccountTarget {
  provider: string;
  agentId: string;
}

/**
 * Add account: pick a provider and the harness to sign in with, finish the
 * plugin's login command (opening its URL, pasting a code), then name the
 * account and choose where to use it.
 */
export function AddAccountDialog({
  isRemote,
  onOpenChange,
  open,
  providers,
  store,
  target,
}: {
  isRemote: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  providers: ProviderView[];
  store: ProjectAccounts;
  target: AddAccountTarget | null;
}) {
  const flow = useAccountLogin(store, isRemote);
  const { choice, setChoice, signable, harness, provider } = useHarnessChoice(
    providers,
    open,
    target,
  );
  const close = () => {
    void flow.cancel();
    flow.reset();
    onOpenChange(false);
  };
  const done = flow.phase === "done";
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            {done
              ? "Signed in. Name the account and choose where to use it."
              : "Sign in through the harness's own login, in your browser."}
          </DialogDescription>
        </DialogHeader>
        {flow.phase === "idle" ? (
          <ChooseHarness
            choice={choice}
            isRemote={isRemote}
            onChoose={setChoice}
            signable={signable}
          />
        ) : null}
        {isSigningIn(flow) ? <SignInProgress flow={flow} /> : null}
        {done && flow.login && provider ? (
          <FinishAccount login={flow.login} onSaved={close} provider={provider} store={store} />
        ) : null}
        {done ? null : <SignInFooter flow={flow} harness={harness} onCancel={close} />}
      </DialogContent>
    </Dialog>
  );
}

function isSigningIn(flow: AccountLoginFlow): boolean {
  return flow.phase === "waiting" || flow.phase === "finishing" || flow.phase === "error";
}

/** The harness the user picked to sign in with, reset to `target` on each open. */
function useHarnessChoice(
  providers: ProviderView[],
  open: boolean,
  target: AddAccountTarget | null,
) {
  const signable = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          harnesses: provider.harnesses.filter((harness) => harness.source.hasLogin),
        }))
        .filter((entry) => entry.harnesses.length > 0),
    [providers],
  );
  const [choice, setChoice] = useState<AddAccountTarget | null>(target);
  useEffect(() => {
    if (open) setChoice(target);
  }, [open, target]);
  const harness = signable
    .find((entry) => entry.provider.provider === choice?.provider)
    ?.harnesses.find((candidate) => candidate.agentId === choice?.agentId);
  const provider = providers.find((candidate) => candidate.provider === choice?.provider);
  return { choice, setChoice, signable, harness, provider };
}

function SignInFooter({
  flow,
  harness,
  onCancel,
}: {
  flow: AccountLoginFlow;
  harness: HarnessView | undefined;
  onCancel: () => void;
}) {
  return (
    <DialogFooter>
      <Button onClick={onCancel} variant="ghost">
        Cancel
      </Button>
      {flow.phase === "idle" ? (
        <Button disabled={!harness} onClick={() => harness && void flow.begin(harness)}>
          Open browser
          <ArrowUpRight />
        </Button>
      ) : null}
      {flow.phase === "error" && harness ? (
        <Button onClick={() => void flow.begin(harness)}>Try again</Button>
      ) : null}
    </DialogFooter>
  );
}

function ChooseHarness({
  choice,
  isRemote,
  onChoose,
  signable,
}: {
  choice: AddAccountTarget | null;
  isRemote: boolean;
  onChoose: (choice: AddAccountTarget) => void;
  signable: Array<{ provider: ProviderView; harnesses: HarnessView[] }>;
}) {
  if (signable.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        None of your installed agent plugins declares a login command yet.
      </p>
    );
  }
  return (
    <RadioGroup
      aria-label="Harness to sign in with"
      className="flex max-h-80 flex-col gap-3 overflow-auto"
      onValueChange={(value) => onChoose(parseChoice(value))}
      value={choice ? choiceValue(choice) : ""}
    >
      {signable.map(({ provider, harnesses }) => (
        <div className="flex flex-col gap-2" key={provider.provider}>
          <div className="flex items-center gap-2 text-xs font-medium">
            <ProviderIcon src={providerIconSrc(provider.iconPath, provider.pluginDir, isRemote)} />
            {provider.title}
          </div>
          {harnesses.map((harness) => {
            const value = choiceValue({ provider: provider.provider, agentId: harness.agentId });
            const id = `add-account-${value}`;
            return (
              <div className="flex items-center gap-2 pl-6" key={harness.agentId}>
                <RadioGroupItem id={id} value={value} />
                <Label className="font-normal" htmlFor={id}>
                  Sign in with {harness.name}
                  {harness.source.multiAccount ? null : (
                    <span className="text-muted-foreground">(replaces its login)</span>
                  )}
                </Label>
              </div>
            );
          })}
        </div>
      ))}
    </RadioGroup>
  );
}

/** Radio values are strings; a provider/harness pair round-trips through JSON. */
function choiceValue(choice: AddAccountTarget): string {
  return JSON.stringify([choice.provider, choice.agentId]);
}

function parseChoice(value: string): AddAccountTarget {
  const [provider, agentId] = JSON.parse(value) as [string, string];
  return { provider, agentId };
}

function SignInProgress({ flow }: { flow: AccountLoginFlow }) {
  const session = flow.session;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      <SignInStatus flow={flow} />
      {session?.instructions ? <p className="text-xs">{session.instructions}</p> : null}
      <SignInLinks urls={session?.urls ?? []} />
      <CodeForm send={flow.send} />
      <SignInOutput flow={flow} />
    </div>
  );
}

/** The login terminal's output behind a toggle, plus the manual "done" button. */
function SignInOutput({ flow }: { flow: AccountLoginFlow }) {
  const [showOutput, setShowOutput] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between">
        <button
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setShowOutput((current) => !current)}
          type="button"
        >
          {showOutput ? "Hide terminal output" : "Show terminal output"}
        </button>
        {flow.phase === "waiting" ? (
          <Button onClick={() => void flow.finish()} size="sm" variant="ghost">
            I've signed in
          </Button>
        ) : null}
      </div>
      {showOutput ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {flow.session?.output || "No output yet."}
        </pre>
      ) : null}
    </>
  );
}

function SignInStatus({ flow }: { flow: AccountLoginFlow }) {
  if (flow.phase === "error") {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
        {flow.error}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted p-3 text-xs">
      <Loader2 className="size-4 animate-spin" />
      {flow.phase === "finishing" ? "Checking the sign-in…" : "Waiting for you to sign in…"}
    </div>
  );
}

function SignInLinks({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {urls.slice(0, 3).map((url) => (
        <Button key={url} onClick={() => void browserOpenExternal(url)} size="sm" variant="outline">
          Open sign-in page
          <ArrowUpRight />
        </Button>
      ))}
    </div>
  );
}

function CodeForm({ send }: { send: AccountLoginFlow["send"] }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send(code.trim()).then(() => setCode(""));
      }}
    >
      <Input
        aria-label="Code from the sign-in page"
        onChange={(event) => setCode(event.target.value)}
        placeholder="Paste a code if the page shows one"
        value={code}
      />
      <Button disabled={!code.trim()} type="submit" variant="secondary">
        Send
      </Button>
    </form>
  );
}

function FinishAccount({
  login,
  onSaved,
  provider,
  store,
}: {
  login: AccountLogin;
  onSaved: () => void;
  provider: ProviderView;
  store: ProjectAccounts;
}) {
  const accountKey = store.getSnapshot().list?.loginKeys[login.id] ?? `login:${login.id}`;
  const usable = provider.harnesses.filter(
    (harness) =>
      harness.agentId === login.agentId ||
      store
        .getSnapshot()
        .list?.state.logins.some(
          (other) =>
            other.agentId === harness.agentId &&
            store.getSnapshot().list?.loginKeys[other.id] === accountKey,
        ),
  );
  const [label, setLabel] = useState(login.identity?.email ?? login.identity?.name ?? "");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set([login.agentId]));
  const [scope, setScope] = useState<AccountBindingScope>("global");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (label.trim()) await store.api.setLabel(accountKey, label.trim());
      await Promise.all(
        [...selected].map((agentId) =>
          store.api.setBinding({ agentId, provider: provider.provider, accountKey, scope }),
        ),
      );
      await store.reload();
      onSaved();
    } catch (cause) {
      toast.error(`Couldn't save the account: ${errorMessage(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">Name</span>
        <Input onChange={(event) => setLabel(event.target.value)} value={label} />
        <span className="text-[11px] text-muted-foreground">
          {[login.identity?.plan, login.credentialPath ? `Token: ${login.credentialPath}` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Use this account in</span>
        {usable.map((harness) => (
          <label className="flex items-center gap-2 text-xs" key={harness.agentId}>
            <Checkbox
              checked={selected.has(harness.agentId)}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked === true) next.add(harness.agentId);
                  else next.delete(harness.agentId);
                  return next;
                })
              }
            />
            {harness.name}
          </label>
        ))}
      </div>
      <ScopeToggle onChange={setScope} scope={scope} />
      <DialogFooter>
        <Button onClick={onSaved} variant="ghost">
          Skip
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

/** "All projects" vs "This project" for a binding write. */
function ScopeToggle({
  onChange,
  scope,
}: {
  onChange: (scope: AccountBindingScope) => void;
  scope: AccountBindingScope;
}) {
  return (
    <fieldset className="flex items-center justify-between gap-2">
      <legend className="float-left text-xs text-muted-foreground">Apply to</legend>
      <div className="flex rounded-md border p-0.5">
        {(["global", "project"] as const).map((value) => (
          <button
            aria-pressed={scope === value}
            className={cn(
              "rounded px-2 py-0.5 text-xs text-muted-foreground",
              scope === value && "bg-accent text-accent-foreground",
            )}
            key={value}
            onClick={() => onChange(value)}
            type="button"
          >
            {value === "global" ? "All projects" : "This project"}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
