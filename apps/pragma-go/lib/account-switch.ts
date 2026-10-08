import {
  borrowedSignInLabel,
  harnessAccountChoices,
  type HarnessView,
  type ProviderView,
} from "@pragma-sh/accounts-view";
import type { MenuAction } from "@react-native-menu/menu";

/** Prefix on a menu action id that names the account to switch to. */
const SWITCH_PREFIX = "switch:";

/**
 * The switch menu for one harness: every account of its provider, the way the
 * desktop's harness dropdown lists them.
 *
 * Accounts the harness can use now are selectable, the current one checked.
 * Accounts it would first have to sign in to, or cannot use at all, stay in the
 * list but disabled, with the reason as their subtitle — hiding them would make
 * a second account look missing rather than unreachable from here. Signing in
 * runs a login command in a terminal on the host, which the desktop drives.
 */
export function switchMenuActions(provider: ProviderView, harness: HarnessView): MenuAction[] {
  const current = harness.current?.accountKey ?? null;
  return harnessAccountChoices(provider, harness).map((choice): MenuAction => {
    const { account } = choice;
    const action: MenuAction = { id: `${SWITCH_PREFIX}${account.key}`, title: account.label };
    if (choice.status === "ready") {
      action.state = account.key === current ? "on" : "off";
      if (choice.borrowed) action.subtitle = borrowedSignInLabel(harness);
      return action;
    }
    action.subtitle =
      choice.status === "signIn" ? `Sign in for ${harness.name} on the desktop` : choice.reason;
    action.attributes = { disabled: true };
    return action;
  });
}

/** The account key a chosen switch action names, or null for anything else. */
export function switchTarget(actionId: string): string | null {
  return actionId.startsWith(SWITCH_PREFIX) ? actionId.slice(SWITCH_PREFIX.length) : null;
}
