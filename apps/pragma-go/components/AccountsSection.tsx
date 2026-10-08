import {
  chipHarnesses,
  formatDuration,
  percentUsed,
  resetsInMs,
  usagePercentLabel,
  usageSeverity,
  type AccountView,
  type HarnessView,
  type ProviderView,
} from "@pragma-sh/accounts-view";
import type { UsageLimit } from "@pragma-sh/constants";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import {
  accountUsers,
  currentAccountLabel,
  providerSummary,
  usageStatusMessage,
} from "@/lib/account-summary";
import { switchMenuActions, switchTarget } from "@/lib/account-switch";
import { hapticSelection, hapticSuccess } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import type { Accounts } from "@/lib/use-accounts";
import { cn } from "@/lib/utils";
import { AgentIcon } from "./AgentIcon";
import { IconSymbol } from "./IconSymbol";
import { MenuView } from "./ui/menu-view";
import { Text } from "./ui/text";

/** Expand/collapse timings. Short enough to feel like a direct response. */
const EXPAND_MS = 180;
const CHEVRON_MS = 160;

/** Bar fill per severity band, mirroring the desktop's colors. */
const BAR_CLASS = {
  ok: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

/**
 * The home screen's account cards: one per provider, its accounts' usage, and
 * which account each harness launches with.
 *
 * Renders nothing when the host has no accounts — an absent section is the
 * honest answer, and is deliberately different from an account that exists but
 * cannot report usage. A failed read keeps the last providers on screen rather
 * than blanking or implying zero usage.
 */
export function AccountsSection({ accounts }: { accounts: Accounts }) {
  if (!accounts.loading && accounts.providers.length === 0) {
    return null;
  }
  return (
    <View className="gap-2">
      <Text className="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Accounts
      </Text>
      <ProviderList accounts={accounts} />
    </View>
  );
}

/**
 * The cards, stacked full width, or placeholders while the first list is still
 * on its way.
 */
function ProviderList({ accounts }: { accounts: Accounts }) {
  const placeholders = accounts.providers.length === 0;
  return (
    <View className="gap-3">
      {placeholders
        ? [0, 1].map((index) => <ProviderSkeleton key={index} />)
        : accounts.providers.map((provider) => (
            <ProviderCard accounts={accounts} key={provider.provider} provider={provider} />
          ))}
    </View>
  );
}

/**
 * A card-shaped placeholder while the first read is in flight.
 *
 * It occupies the same space as a real card so the section does not jump
 * when the list lands, and it pulses so a slow host reads as "loading" rather
 * than as a provider with nothing to say.
 */
function ProviderSkeleton() {
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 700 }), -1, true);
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      accessibilityLabel="Loading accounts"
      className="gap-3 overflow-hidden rounded-xl border border-border bg-card p-3"
      style={style}
    >
      <View className="flex-row items-center gap-2">
        <View className="h-[18px] w-[18px] rounded-full bg-muted" />
        <View className="h-3 flex-1 rounded-full bg-muted" />
      </View>
      <View className="h-1 rounded-full bg-muted" />
    </Animated.View>
  );
}

/**
 * One provider: a collapsed row showing the account that runs out first, which
 * expands to every account and a switcher per harness.
 */
function ProviderCard({ accounts, provider }: { accounts: Accounts; provider: ProviderView }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Animated.View
      className="overflow-hidden rounded-xl border border-border bg-card"
      layout={LinearTransition.duration(EXPAND_MS)}
    >
      <Pressable
        accessibilityHint="Shows every account and which one each agent uses"
        accessibilityLabel={`${provider.title} accounts`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="gap-2 p-3 active:opacity-70"
        onPress={() => {
          hapticSelection();
          setExpanded((open) => !open);
        }}
      >
        <ProviderSummaryRows accounts={accounts} expanded={expanded} provider={provider} />
      </Pressable>
      {expanded ? (
        <Animated.View entering={FadeIn.duration(EXPAND_MS)} exiting={FadeOut.duration(EXPAND_MS)}>
          <ProviderDetail accounts={accounts} provider={provider} />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/** The collapsed card's content: title, the lead account's usage, and who it is. */
function ProviderSummaryRows({
  accounts,
  expanded,
  provider,
}: {
  accounts: Accounts;
  expanded: boolean;
  provider: ProviderView;
}) {
  const { lead, caption } = providerSummary(provider);
  return (
    <>
      <View className="flex-row items-center gap-2">
        <AgentIcon fallback="◔" icon={providerIcon(accounts, provider)} size={18} />
        <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {provider.title}
        </Text>
        <PercentLabel limit={lead?.primary} />
        <Chevron expanded={expanded} />
      </View>
      <LeadUsage account={lead} />
      {caption ? (
        <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
    </>
  );
}

function PercentLabel({ limit }: { limit: UsageLimit | undefined }) {
  return limit ? (
    <Text className="text-xs text-muted-foreground">{usagePercentLabel(limit)}</Text>
  ) : null;
}

/** The lead account's primary bar, or why it has none. */
function LeadUsage({ account }: { account: AccountView | undefined }) {
  return account?.primary ? (
    <UsageBar limit={account.primary} />
  ) : (
    <AccountStatus account={account} />
  );
}

/**
 * The first harness's catalog icon. A provider's own icon is a file path on the
 * host, which the phone cannot load; the agent icons come through the gateway.
 */
function providerIcon(accounts: Accounts, provider: ProviderView) {
  for (const harness of provider.harnesses) {
    const icon = accounts.agentIcon(harness.agentId);
    if (icon) return icon;
  }
  return null;
}

/**
 * The disclosure chevron: one glyph that rotates, rather than two that swap.
 *
 * It is tinted from the resolved theme colors because an SF Symbol takes a
 * literal `tintColor` prop and cannot read a NativeWind class — left untinted
 * it would ignore the user's theme and paint itself the system label color.
 */
function Chevron({ expanded }: { expanded: boolean }) {
  const { mutedForeground } = useThemeColors();
  const turn = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    turn.value = withTiming(expanded ? 1 : 0, { duration: CHEVRON_MS });
  }, [expanded, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 180}deg` }] }));

  return (
    <Animated.View style={style}>
      <IconSymbol
        className="text-muted-foreground"
        color={mutedForeground}
        fallback="⌄"
        name="chevron.down"
        size={12}
        tintColor={mutedForeground}
      />
    </Animated.View>
  );
}

function ProviderDetail({ accounts, provider }: { accounts: Accounts; provider: ProviderView }) {
  const harnesses = chipHarnesses(provider, provider.harnesses);
  const dashboardUrl = provider.dashboardUrl;
  return (
    <View className="gap-3 border-t border-border p-3">
      {provider.accounts.map((account) => (
        <AccountRow account={account} key={account.key} provider={provider} />
      ))}
      {harnesses.length > 0 ? (
        <View className="gap-2 border-t border-border pt-3">
          {harnesses.map((harness) => (
            <HarnessSwitch
              accounts={accounts}
              harness={harness}
              key={harness.agentId}
              provider={provider}
            />
          ))}
        </View>
      ) : null}
      {dashboardUrl ? (
        <Pressable
          accessibilityRole="link"
          className="flex-row items-center gap-1 active:opacity-70"
          onPress={() => void Linking.openURL(dashboardUrl)}
        >
          <Text className="text-xs font-medium text-foreground">View dashboard</Text>
          <IconSymbol fallback="↗" name="arrow.up.right" size={11} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** One account: who it is, its plan, and every usage category it reports. */
function AccountRow({ account, provider }: { account: AccountView; provider: ProviderView }) {
  const users = accountUsers(account, provider);
  return (
    <View className="gap-2">
      <View className="gap-0.5">
        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
          {account.label}
          {account.plan ? <Text className="text-muted-foreground"> · {account.plan}</Text> : null}
        </Text>
        {users.length > 0 ? (
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            Used by {users.join(", ")}
          </Text>
        ) : null}
      </View>
      <AccountLimits account={account} />
    </View>
  );
}

/** Every category a ready reading reports, or why there is none. */
function AccountLimits({ account }: { account: AccountView }) {
  const result = account.usage;
  if (result?.status !== "ready") {
    return <AccountStatus account={account} verbose />;
  }
  return result.limits.map((limit) => (
    <LimitRow key={limit.id} limit={limit} observedAt={result.observedAt} />
  ));
}

/**
 * Which account a harness launches with, and the menu that changes it.
 *
 * The switch is global: the home screen has no project in view, and a
 * project-level override set on the desktop keeps winning inside that project.
 * Agents already running keep the account they started with.
 */
function HarnessSwitch({
  accounts,
  harness,
  provider,
}: {
  accounts: Accounts;
  harness: HarnessView;
  provider: ProviderView;
}) {
  const { switching, choose } = useSwitchAccount(accounts, harness);
  const label = currentAccountLabel(provider, harness);

  return (
    <MenuView
      actions={switchMenuActions(provider, harness)}
      onPressAction={(event) => choose(event.nativeEvent.event)}
      title={`${harness.name} uses`}
    >
      <View
        accessibilityHint="Chooses the account this agent launches with"
        accessibilityLabel={`${harness.name} account: ${label}`}
        className="flex-row items-center gap-2"
      >
        <AgentIcon fallback="◆" icon={accounts.agentIcon(harness.agentId)} size={16} />
        <Text className="text-xs text-foreground">{harness.name}</Text>
        <Text className="flex-1 text-right text-xs text-muted-foreground" numberOfLines={1}>
          {label}
        </Text>
        <SwitchIndicator switching={switching} />
      </View>
    </MenuView>
  );
}

/** Runs a switch chosen from the menu, reporting a failure rather than hiding it. */
function useSwitchAccount(
  accounts: Accounts,
  harness: HarnessView,
): { switching: boolean; choose: (actionId: string) => void } {
  const [switching, setSwitching] = useState(false);
  const choose = (actionId: string): void => {
    const accountKey = switchTarget(actionId);
    if (!accountKey || accountKey === harness.current?.accountKey) return;
    setSwitching(true);
    accounts
      .switchAccount(harness, accountKey)
      .then(hapticSuccess)
      .catch((error: unknown) => {
        Alert.alert(
          "Couldn't switch account",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setSwitching(false));
  };
  return { switching, choose };
}

/** A spinner while a switch is in flight, otherwise the menu affordance. */
function SwitchIndicator({ switching }: { switching: boolean }) {
  const { mutedForeground } = useThemeColors();
  return switching ? (
    <ActivityIndicator color={mutedForeground} size="small" />
  ) : (
    <IconSymbol
      color={mutedForeground}
      fallback="⇅"
      name="chevron.up.chevron.down"
      size={11}
      tintColor={mutedForeground}
    />
  );
}

function LimitRow({ limit, observedAt }: { limit: UsageLimit; observedAt: number }) {
  const resetsIn = resetsInMs(limit, observedAt);
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs text-foreground">{limit.title}</Text>
        <Text className="text-xs text-muted-foreground">{usagePercentLabel(limit)}</Text>
      </View>
      <UsageBar limit={limit} />
      {resetsIn === null ? null : (
        <Text className="text-[11px] text-muted-foreground">
          Resets in {formatDuration(resetsIn)}
        </Text>
      )}
    </View>
  );
}

/**
 * The bar itself. An unlimited category gets an empty track rather than a full
 * or empty *fill*, because either would read as a usage figure it does not have.
 */
function UsageBar({ limit }: { limit: UsageLimit }) {
  const percent = percentUsed(limit);
  if (percent === null) {
    return <View className="h-1 rounded-full bg-muted" />;
  }
  return (
    <View
      accessibilityLabel={`${limit.title}: ${Math.round(percent)}% used`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      className="h-1 overflow-hidden rounded-full bg-muted"
    >
      <View
        className={cn("h-full rounded-full", BAR_CLASS[usageSeverity(percent)])}
        style={{ width: `${percent}%` }}
      />
    </View>
  );
}

/** Why an account is showing no bar: never phrased as zero usage. */
function AccountStatus({
  account,
  verbose = false,
}: {
  account: AccountView | undefined;
  verbose?: boolean;
}) {
  return (
    <Text className="text-[11px] text-muted-foreground" numberOfLines={verbose ? undefined : 1}>
      {usageStatusMessage(account?.usage)}
    </Text>
  );
}
