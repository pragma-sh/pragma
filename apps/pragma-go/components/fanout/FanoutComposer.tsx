import type { FanoutMember, FanoutSendTarget } from "@pragma-sh/constants";
import { memberLabel } from "@pragma-sh/fanout-view";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { followUpSummary, followUpTarget } from "@/lib/fanout-form";
import type { SendSummary } from "@/lib/use-fanout-actions";

/**
 * A follow-up for the attempts: to every live attempt at once — the usual case,
 * since a fanout compares them on equal footing — or only to the attempt in view.
 */
export function FanoutComposer({
  current,
  disabled,
  onSend,
  sending,
}: {
  /** The attempt the pager is showing; the "this attempt" target. */
  current: FanoutMember | undefined;
  disabled: boolean;
  onSend: (message: string, target: FanoutSendTarget) => Promise<SendSummary | null>;
  sending: boolean;
}) {
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<"all" | "member">("all");
  const [summary, setSummary] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const text = message.trim();
    if (!text) return;
    const result = await onSend(text, followUpTarget(scope, current?.id));
    if (!result) return;
    setMessage("");
    setSummary(followUpSummary(result));
  };

  return (
    <View className="gap-2 border-t border-border bg-background px-4 pt-3">
      <ScopeTabs current={current} onChange={setScope} scope={scope} />
      <FollowUpInput
        canSend={canSendFollowUp(disabled, sending, message)}
        disabled={disabled}
        message={message}
        onChange={(text) => {
          setMessage(text);
          setSummary(null);
        }}
        onSend={() => void send()}
        sending={sending}
      />
      {summary ? <Text className="text-xs text-muted-foreground">{summary}</Text> : null}
    </View>
  );
}

/** Every attempt, or only the one the pager is showing. */
function ScopeTabs({
  current,
  onChange,
  scope,
}: {
  current: FanoutMember | undefined;
  onChange: (scope: "all" | "member") => void;
  scope: "all" | "member";
}) {
  return (
    <Tabs onValueChange={(next) => onChange(next === "member" ? "member" : "all")} value={scope}>
      <TabsList className="w-full">
        <TabsTrigger value="all">
          <Text>All attempts</Text>
        </TabsTrigger>
        <TabsTrigger disabled={!current} value="member">
          <Text numberOfLines={1}>{current ? memberLabel(current) : "This attempt"}</Text>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function canSendFollowUp(disabled: boolean, sending: boolean, message: string): boolean {
  return !disabled && !sending && message.trim().length > 0;
}

function FollowUpInput({
  canSend,
  disabled,
  message,
  onChange,
  onSend,
  sending,
}: {
  canSend: boolean;
  disabled: boolean;
  message: string;
  onChange: (text: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  return (
    <View className="flex-row items-end gap-2">
      <Input
        className="max-h-28 flex-1 py-2"
        editable={!disabled}
        multiline
        onChangeText={onChange}
        placeholder={disabled ? "This fanout is not accepting messages" : "Send a follow-up…"}
        style={{ textAlignVertical: "top" }}
        value={message}
      />
      <Button disabled={!canSend} onPress={onSend}>
        <Text>{sending ? "Sending…" : "Send"}</Text>
      </Button>
    </View>
  );
}
