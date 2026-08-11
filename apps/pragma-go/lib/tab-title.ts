/** Terminal label before a shell emits an OSC title, including headless sessions. */
export function displayTabTitle(title: string | null | undefined): string {
  return title?.trim() || "Shell";
}
