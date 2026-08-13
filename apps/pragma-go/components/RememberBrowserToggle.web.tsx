import { useState } from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { isPersistent, setPersistent } from "@/lib/secret-store";

/** Browser opt-in for storing the pairing token beyond the current tab. */
export function RememberBrowserToggle() {
  const [remember, setRemember] = useState(isPersistent);

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: remember }}
      className="flex-row items-center gap-3"
      onPress={() => {
        const next = !remember;
        setPersistent(next);
        setRemember(next);
      }}
    >
      <View
        className={`h-5 w-5 items-center justify-center rounded border ${
          remember ? "border-primary bg-primary" : "border-input"
        }`}
      >
        {remember ? <Text className="text-xs text-primary-foreground">✓</Text> : null}
      </View>
      <Text className="flex-1 text-sm text-muted-foreground">
        Stay signed in on this browser. Leave off on a shared computer — the token is then forgotten
        when you close the tab.
      </Text>
    </Pressable>
  );
}
