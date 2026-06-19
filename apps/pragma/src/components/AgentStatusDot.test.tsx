import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentStatusDot } from "@/components/AgentStatusDot";

describe("AgentStatusDot", () => {
  it("renders nothing when there is no status", () => {
    const { container } = render(<AgentStatusDot status={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a green indicator for a done agent", () => {
    const { container } = render(<AgentStatusDot status="done" />);
    expect(container.firstChild).not.toBeNull();
    expect(container.firstChild).toHaveClass("bg-green-500");
  });

  it("renders yellow and red indicators for running and attention", () => {
    expect(render(<AgentStatusDot status="running" />).container.firstChild).toHaveClass(
      "bg-yellow-400",
    );
    expect(render(<AgentStatusDot status="attention" />).container.firstChild).toHaveClass(
      "bg-red-500",
    );
  });
});
