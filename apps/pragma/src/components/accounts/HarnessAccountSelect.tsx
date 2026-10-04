import { ChevronDown, LogIn, Undo2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  canSignInAnother,
  borrowedSignInLabel,
  harnessAccountChoices,
  type AccountView,
  type HarnessAccountChoice,
  type HarnessView,
  type ProviderView,
} from "@pragma-sh/accounts-view";
import { usagePercentLabel } from "@pragma-sh/accounts-view";
import { cn } from "@/lib/utils";

/** What the harness account selects do. */
export interface HarnessAccountActions {
  /** Moves each harness onto `account`. */
  assign: (harnesses: HarnessView[], account: AccountView) => void;
  /** Signs the harness in to another account of its provider. */
  signIn: (harness: HarnessView) => void;
  /** Drops this project's override so the harness follows the global choice. */
  resetOverride: (harness: HarnessView) => void;
  /** Settings' global scope only: clears the global choice back to the harness's own login. */
  followOwnLogin?: (harness: HarnessView) => void;
}

/**
 * The account a harness launches with, as a select-like trigger that opens its
 * account picker. `md` is the Settings page's bordered select; `sm` is the
 * toolbar menu's borderless one.
 */
export function HarnessAccountSelect({
  actions,
  harness,
  muted = false,
  provider,
  size,
}: {
  actions: HarnessAccountActions;
  harness: HarnessView;
  /** Styles a harness that is on no listed account. */
  muted?: boolean;
  provider: ProviderView;
  size: "sm" | "md";
}) {
  const choices = harnessAccountChoices(provider, harness);
  const options = choices.flatMap((choice) => (choice.status === "ready" ? [choice] : []));
  const others = choices.filter((choice) => choice.status !== "ready");
  const current = harness.current?.accountKey ?? "";
  const override = harness.current?.scope === "project";
  const currentAccount = provider.accounts.find((account) => account.key === current);
  const pick = (key: string) => {
    const account = options.find((option) => option.account.key === key)?.account;
    if (account && key !== current) actions.assign([harness], account);
  };
  return (
    <DropdownMenu>
      <AccountSelectTrigger
        harness={harness}
        label={currentAccount?.label ?? "Choose account"}
        legacy={provider.legacy}
        muted={muted}
        size={size}
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          {harness.name} uses{override ? " · this project only" : ""}
          {harness.source.swaps ? (
            <span className="block text-[11px] font-normal text-muted-foreground">
              Shares one sign-in file, so running sessions switch too.
            </span>
          ) : null}
        </DropdownMenuLabel>
        <ReadyAccounts current={current} harness={harness} onPick={pick} options={options} />
        <OtherAccounts choices={others} harness={harness} signIn={actions.signIn} />
        <HarnessMenuActions actions={actions} harness={harness} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountSelectTrigger({
  harness,
  label,
  legacy,
  muted,
  size,
}: {
  harness: HarnessView;
  label: string;
  legacy: boolean | undefined;
  muted: boolean;
  size: "sm" | "md";
}) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        aria-label={`Choose the account ${harness.name} uses`}
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center justify-between gap-1.5 rounded-md border text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none data-[state=open]:bg-accent",
          size === "md"
            ? "h-8 w-64 bg-background px-2.5 text-sm"
            : "h-6 max-w-52 border-transparent px-1.5 text-[11px]",
          muted && "text-muted-foreground",
          muted && size === "md" && "border-dashed",
        )}
        disabled={legacy}
        type="button"
      >
        <span className="truncate">{label}</span>
        {legacy ? null : <ChevronDown className="size-3.5 shrink-0 opacity-60" />}
      </button>
    </DropdownMenuTrigger>
  );
}

/** The accounts the harness can switch to right away, as radio items. */
function ReadyAccounts({
  current,
  harness,
  onPick,
  options,
}: {
  current: string;
  harness: HarnessView;
  onPick: (key: string) => void;
  options: HarnessAccountChoice[];
}) {
  if (options.length === 0) {
    return <p className="px-1.5 py-1 text-xs text-muted-foreground">Not signed in to an account</p>;
  }
  return (
    <DropdownMenuRadioGroup onValueChange={onPick} value={current}>
      {options.map((choice) => (
        <DropdownMenuRadioItem key={choice.account.key} value={choice.account.key}>
          <AccountOptionLabel
            account={choice.account}
            detail={
              choice.status === "ready" && choice.borrowed ? borrowedSignInLabel(harness) : null
            }
          />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** Sign in to another account, and the ways back to an inherited choice. */
function HarnessMenuActions({
  actions,
  harness,
}: {
  actions: HarnessAccountActions;
  harness: HarnessView;
}) {
  const scope = harness.current?.scope;
  const ownLogin = scope === "global" ? actions.followOwnLogin : undefined;
  const items = [
    canSignInAnother(harness) && {
      icon: LogIn,
      label: "Sign in to another account…",
      onSelect: () => actions.signIn(harness),
    },
    scope === "project" && {
      icon: Undo2,
      label: "Follow all projects",
      onSelect: () => actions.resetOverride(harness),
    },
    ownLogin && {
      icon: Undo2,
      label: `Use ${harness.name}'s own login`,
      onSelect: () => ownLogin(harness),
    },
  ].filter((item) => !!item);
  if (items.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {items.map(({ icon: Icon, label, onSelect }) => (
        <DropdownMenuItem key={label} onSelect={onSelect}>
          <Icon />
          {label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * The provider's accounts the harness cannot pick yet: one it has to sign in
 * to (a different OAuth app), or one it cannot use at all, with the reason.
 */
function OtherAccounts({
  choices,
  harness,
  signIn,
}: {
  choices: HarnessAccountChoice[];
  harness: HarnessView;
  signIn: HarnessAccountActions["signIn"];
}) {
  if (choices.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {choices.map((choice) =>
        choice.status === "signIn" ? (
          <DropdownMenuItem key={choice.account.key} onSelect={() => signIn(harness)}>
            <AccountOptionLabel
              account={choice.account}
              detail={`Sign in with ${harness.name} to use it`}
            />
            <LogIn />
          </DropdownMenuItem>
        ) : choice.status === "unavailable" ? (
          <DropdownMenuItem disabled key={choice.account.key}>
            <AccountOptionLabel account={choice.account} detail={choice.reason} />
          </DropdownMenuItem>
        ) : null,
      )}
    </>
  );
}

function AccountOptionLabel({
  account,
  detail: override,
}: {
  account: AccountView;
  /** Replaces the email/plan line, e.g. how the harness would get to use it. */
  detail?: string | null;
}) {
  const detail = override
    ? override
    : account.email && account.email !== account.label
      ? account.email
      : account.plan;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{account.label}</span>
        {detail ? (
          <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {account.primary ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {usagePercentLabel(account.primary)}
        </span>
      ) : null}
    </span>
  );
}

/** Marks a harness whose account is chosen for this project only. */
export function OverrideDot() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label="This project only"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      </TooltipTrigger>
      <TooltipContent>This project only</TooltipContent>
    </Tooltip>
  );
}
