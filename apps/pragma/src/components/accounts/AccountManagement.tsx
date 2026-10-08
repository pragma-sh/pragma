import { useEffect, useRef, useState } from "react";

import { Pencil, X } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import type { AccountView, ProviderView } from "@pragma-sh/accounts-view";
import { errorMessage } from "@/lib/errors";
import type { ProjectAccounts } from "@pragma-sh/accounts-view";

/** A Settings account's name: plain text until clicked, then an inline rename field. */
export function AccountName({ account, store }: { account: AccountView; store: ProjectAccounts }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  // Escape unmounts the field, and a blur during unmount must not save.
  const cancelled = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  // Focus the field with the name selected, so typing replaces it.
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (cancelled.current) return;
    const next = draft.trim();
    if (next === account.label) return;
    void store
      .setLabel(account.key, next || null)
      .catch((cause: unknown) => toast.error(`Couldn't rename: ${errorMessage(cause)}`));
  };
  if (editing) {
    return (
      <Input
        aria-label="Account name"
        className="-my-1 h-7 max-w-72 text-sm"
        onBlur={save}
        onChange={(event) => setDraft(event.target.value)}
        ref={field}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") {
            event.stopPropagation();
            cancelled.current = true;
            setEditing(false);
          }
        }}
        value={draft}
      />
    );
  }
  return (
    <button
      aria-label={`Rename ${account.label}`}
      className="group inline-flex min-w-0 items-center gap-1.5 rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => {
        cancelled.current = false;
        setDraft(account.label);
        setEditing(true);
      }}
      type="button"
    >
      <span className="truncate">{account.label}</span>
      <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

/** The harnesses signed in to an account; a Pragma-made login can be signed out. */
export function AccountLogins({
  account,
  provider,
  store,
}: {
  account: AccountView;
  provider: ProviderView;
  store: ProjectAccounts;
}) {
  const harnessName = (agentId: string) =>
    provider.harnesses.find((harness) => harness.agentId === agentId)?.name ?? agentId;
  if (account.logins.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="mr-0.5 text-muted-foreground">Signed in with</span>
      {account.logins.map((login) => (
        <span
          className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/40 px-2 data-[removable]:pr-1"
          data-removable={login.home ? "" : undefined}
          key={login.id}
        >
          {harnessName(login.agentId)}
          {login.home ? (
            <button
              aria-label={`Sign ${harnessName(login.agentId)} out of this account`}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() =>
                void store
                  .removeLogin(login.id)
                  .catch((cause: unknown) => toast.error(errorMessage(cause)))
              }
              type="button"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
