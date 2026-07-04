import { defineCommand, definePlugin, defineSidebarCard, defineSidebarTab } from "@pragma/plugin";

import { AgentPulseCard } from "./agent-pulse-card";
import { FORTUNE_REROLL_EVENT, FortuneTab } from "./fortune-tab";
import { OverviewTab } from "./overview-tab";
import { openReportWebView, reportWebView } from "./report-webview";

export default definePlugin({
  name: "Pragma Dev Test Plugin",
  description:
    "Dev/test plugin: a random secondary sidebar tab, a sidebar card, and an SDK event hook.",
  ui: {
    sidebarTabs: [
      defineSidebarTab({ id: "overview", title: "Overview", component: OverviewTab }),
      defineSidebarTab({ id: "fortune", title: "Fortune", component: FortuneTab }),
    ],
    sidebarCards: [defineSidebarCard({ title: "Agent Pulse", component: AgentPulseCard })],
    webViews: [reportWebView],
  },
  commands: [
    defineCommand({
      id: "pragma-dev-test-plugin.hello",
      title: "Show Pragma Dev Test Plugin greeting",
      run: (ctx) => ctx.notify("Hello from Pragma Dev Test Plugin", { variant: "success" }),
    }),
    defineCommand({
      id: "pragma-dev-test-plugin.fortune.reroll",
      title: "Reroll dev fortune",
      defaultBinding: "mod+k",
      run: () => {
        window.dispatchEvent(new Event(FORTUNE_REROLL_EVENT));
      },
    }),
    defineCommand({
      id: "pragma-dev-test-plugin.report.open",
      title: "Open dev plugin web view",
      run: () => openReportWebView(),
    }),
  ],
});
