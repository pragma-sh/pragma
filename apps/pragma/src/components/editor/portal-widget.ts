// fallow-ignore-file unused-class-member -- CodeMirror calls eq/toDOM/destroy/ignoreEvent via WidgetType polymorphism; static analysis cannot see those call sites.
import { WidgetType } from "@codemirror/view";

/**
 * A CodeMirror block widget whose DOM is nothing but a stable container for a
 * React portal — the editor owns placement, React owns the contents.
 *
 * Identity is the `key`: while it is unchanged CodeMirror reuses the same DOM
 * node, so the portal's children keep their local state across redraws. Mount
 * and unmount callbacks let the host component track which containers are live.
 */
export class PortalWidget extends WidgetType {
  constructor(
    private readonly key: string,
    private readonly className: string,
    private readonly onMount: (key: string, dom: HTMLElement) => void,
    private readonly onUnmount: (key: string) => void,
  ) {
    super();
  }

  override eq(other: PortalWidget): boolean {
    return other.key === this.key;
  }

  override toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = this.className;
    this.onMount(this.key, dom);
    return dom;
  }

  override destroy(): void {
    this.onUnmount(this.key);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
