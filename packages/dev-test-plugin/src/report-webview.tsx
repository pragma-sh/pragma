import { defineWebView, useWebViewPayload } from "@pragma/plugin";
import { Button } from "@pragma/plugin/ui";

interface ReportPayload {
  message: string;
  openedAt: string;
}

function ReportWebView() {
  const payload = useWebViewPayload<ReportPayload>();
  return (
    <main className="h-full bg-background p-6 text-foreground">
      <div className="rounded-xl border border-border bg-card p-4 shadow-raised">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Plugin web view</p>
        <h1 className="mt-2 text-xl font-semibold">{payload?.message ?? "No payload"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Opened: {payload?.openedAt ?? "unknown"}
        </p>
        <Button className="mt-4" size="sm" variant="secondary">
          Host button
        </Button>
      </div>
    </main>
  );
}

export const reportWebView = defineWebView<ReportPayload>({
  id: "report",
  title: "Plugin Report",
  component: ReportWebView,
});

export function openReportWebView(): Promise<void> {
  return reportWebView.open({
    title: "Plugin Report",
    payload: { message: "Hello from a plugin web view", openedAt: new Date().toISOString() },
    dedupeKey: "dev-report",
  });
}
