import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { primeNotificationPermission } from "@/lib/agent-alert";
import "@/lib/brand-icons";
import "./index.css";
import App from "./App.tsx";

// Request OS notification permission while the window is frontmost at launch, so
// background agent alerts can fire immediately instead of prompting when unfocused.
primeNotificationPermission();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);
