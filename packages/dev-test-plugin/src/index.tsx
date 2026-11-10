import {
  defineCommand,
  definePlugin,
  defineSettingsPage,
  defineSidebarCard,
  defineSidebarTab,
} from "@pragma-sh/plugin";

import { AgentPulseCard } from "./agent-pulse-card";
import { DevTestDiagnosticsPage } from "./diagnostics-page";
import { FORTUNE_REROLL_EVENT, FortuneTab } from "./fortune-tab";
import { OverviewTab } from "./overview-tab";
import { openReportWebView, reportWebView } from "./report-webview";
import { DevTestSettingsPage } from "./settings-page";
import { testMentionsProvider } from "./test-mentions";
import { testSuggestionsProvider } from "./test-suggestions";
import { uncommittedSection } from "./uncommitted-section";

export default definePlugin({
  name: "Pragma Dev Test Plugin",
  description:
    "Dev/test plugin: sidebar tabs, a sidebar card, a worktree section, an SDK event hook, and agent-board suggested drafts.",
  ui: {
    sidebarTabs: [
      defineSidebarTab({ id: "overview", title: "Overview", component: OverviewTab }),
      defineSidebarTab({ id: "fortune", title: "Fortune", component: FortuneTab }),
    ],
    sidebarCards: [defineSidebarCard({ title: "Agent Pulse", component: AgentPulseCard })],
    worktreeSections: [uncommittedSection],
    settingsPages: [
      defineSettingsPage({
        id: "dev-test",
        title: "Board Drafts",
        component: DevTestSettingsPage,
      }),
      defineSettingsPage({
        id: "diagnostics",
        title: "Diagnostics",
        component: DevTestDiagnosticsPage,
      }),
    ],
    webViews: [reportWebView],
  },
  contextProviders: [testMentionsProvider],
  suggestedDrafts: [testSuggestionsProvider],
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
