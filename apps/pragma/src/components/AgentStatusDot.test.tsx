import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentStatusDot } from "@/components/AgentStatusDot";

describe("AgentStatusDot", () => {
  it("renders nothing when there is no status", () => {
    const { container } = render(<AgentStatusDot status={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a success indicator for a done agent", () => {
    const { container } = render(<AgentStatusDot status="done" />);
    expect(container.firstChild).not.toBeNull();
    expect(container.firstChild).toHaveClass("bg-success");
  });

  it("renders running and attention indicators with their state tokens", () => {
    expect(render(<AgentStatusDot status="running" />).container.firstChild).toHaveClass(
      "bg-warning",
    );
    expect(render(<AgentStatusDot status="attention" />).container.firstChild).toHaveClass(
      "bg-destructive",
    );
  });
});
