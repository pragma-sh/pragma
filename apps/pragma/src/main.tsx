import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { constants } from "@pragma/constants";
import { Toaster } from "@/components/ui/sonner";
import { primeNotificationPermission } from "@/lib/agent-alert";
import { isMacPlatform } from "@/lib/platform";
import "@/lib/brand-icons";
import "./index.css";
import App from "./App.tsx";

// macOS gets a native NSVisualEffectView behind the window plus inset traffic
// lights (see src-tauri/window_chrome.rs). The `.vibrancy` class lets the project
// rail render translucent so the desktop blur reads through it, and reserves a
// `--titlebar-height` strip the frontend keeps draggable and clear of the
// traffic lights. Other platforms keep an opaque rail and standard decorations.
if (isMacPlatform()) {
  const root = document.documentElement;
  root.classList.add("vibrancy");
  root.style.setProperty("--titlebar-height", `${constants.window.titlebarHeight}px`);
}

// Request OS notification permission while the window is frontmost at launch, so
// background agent alerts can fire immediately instead of prompting when unfocused.
primeNotificationPermission();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);
