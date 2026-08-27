import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { constants } from "@pragma/constants";
import { Toaster } from "@/components/ui/sonner";
import { primeNotificationPermission } from "@/lib/agent-alert";
import { startGatewayPresenceReporting } from "@/lib/gateway-presence";
import { isMacPlatform } from "@/lib/platform";
import "@/plugins/bootstrap-bridge";
import "@/lib/brand-icons";
import "./index.css";
import App from "./App.tsx";

// macOS gets a native NSVisualEffectView behind the window plus inset traffic
// lights (see src-tauri/window_chrome.rs). The `.vibrancy` class lets the project
// rail render translucent so the desktop blur reads through it, and reserves a
// `--titlebar-height` strip the frontend keeps draggable and clear of the
// traffic lights. Native fullscreen has no traffic lights, so shrink that inset
// to a small top margin that aligns sidebar content with the top bar. Other platforms keep an
// opaque rail and standard decorations.
if (isMacPlatform()) {
  const root = document.documentElement;
  root.classList.add("vibrancy");
  const appWindow = getCurrentWindow();
  const syncTitlebarHeight = () => {
    void appWindow
      .isFullscreen()
      .then((fullscreen) => {
        root.classList.toggle("vibrancy", !fullscreen);
        root.style.setProperty(
          "--titlebar-height",
          fullscreen ? "5px" : `${constants.window.titlebarHeight}px`,
        );
        return undefined;
      })
      .catch(() => undefined);
  };

  syncTitlebarHeight();
  void appWindow.onResized(syncTitlebarHeight);
}

// Request OS notification permission while the window is frontmost at launch, so
// background agent alerts can fire immediately instead of prompting when unfocused.
primeNotificationPermission();

// Let the gateway know when this window is in front, so a paired phone is not
// pushed an alert the user is already reading here.
startGatewayPresenceReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);
