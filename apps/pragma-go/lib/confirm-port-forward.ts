import type { OpenPort } from "@pragma-sh/sdk";
import { Alert } from "react-native";

/** Native confirmation before publishing a local development server. */
export function confirmPortForward(port: OpenPort): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      `Forward port ${port.port}?`,
      `${port.process} will be reachable through your configured public tunnel.`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Forward", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
