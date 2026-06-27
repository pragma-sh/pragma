import { describe, expect, it } from "vitest";

import { routeKanbanMove } from "@/lib/kanban-move";

describe("routeKanbanMove", () => {
  it("treats a drop in the same column as a no-op", () => {
    expect(routeKanbanMove("draft", "draft")).toBe("noop");
    expect(routeKanbanMove("completed", "completed")).toBe("noop");
  });

  it("routes the forward single-step transitions to their actions", () => {
    expect(routeKanbanMove("draft", "inProgress")).toBe("start");
    expect(routeKanbanMove("inProgress", "reviewNeeded")).toBe("review");
    expect(routeKanbanMove("reviewNeeded", "completed")).toBe("complete");
  });

  it("blocks backward and skipping moves", () => {
    expect(routeKanbanMove("inProgress", "draft")).toBe("blocked");
    expect(routeKanbanMove("completed", "reviewNeeded")).toBe("blocked");
    expect(routeKanbanMove("draft", "completed")).toBe("blocked");
    expect(routeKanbanMove("draft", "reviewNeeded")).toBe("blocked");
  });
});
