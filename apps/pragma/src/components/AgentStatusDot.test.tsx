import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentStatusDot } from "@/components/AgentStatusDot";

describe("AgentStatusDot", () => {
  it("renders nothing when there is no status", () => {
    const { container } = render(<AgentStatusDot status={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an idle (done) agent", () => {
    const { container } = render(<AgentStatusDot status="done" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an indicator for running and attention", () => {
    expect(render(<AgentStatusDot status="running" />).container.firstChild).not.toBeNull();
    expect(render(<AgentStatusDot status="attention" />).container.firstChild).not.toBeNull();
  });
});
