/**
 * Web counterpart of `use-widget-sync.ts`. There are no home-screen widgets in
 * a browser, and the real hook's module graph reaches `@expo/ui/swift-ui` — so
 * this stub exists as much to keep SwiftUI out of the web bundle as to skip the
 * work.
 */
export function useWidgetSync(): void {
  // Nothing to mirror: a browser tab has no widget extension.
}
