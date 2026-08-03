import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";

import { useConnection } from "./connection-context";
import { configureNotificationHandler, registerForPush } from "./push";
import { pushRoute } from "./push-route";

configureNotificationHandler();

/**
 * Registers this device for agent-alert pushes once a host is paired, and opens
 * the reporting agent's chat tab when the user taps one — including a tap that
 * launched the app from a cold start.
 */
export function usePushNotifications(): void {
  const { client, status } = useConnection();

  useEffect(() => {
    if (!client || status !== "paired") return;
    let cancelled = false;
    void registerForPush(client).then((result) => {
      if (!cancelled && !result.ok) {
        console.warn(`push notifications are off: ${result.reason}`);
      }
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [client, status]);

  useEffect(() => {
    if (status !== "paired") return;
    // A tap that launched the app is delivered as the "last response" rather
    // than through the listener, so check it before subscribing.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      navigate(response);
      return undefined;
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(navigate);
    return () => subscription.remove();
  }, [status]);
}

function navigate(response: Notifications.NotificationResponse | null): void {
  const data = response?.notification.request.content.data;
  const route = pushRoute(data);
  if (route) router.push(route);
}
