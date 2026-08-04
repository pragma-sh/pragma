import { Component, type ErrorInfo, type ReactNode } from "react";
import * as React from "react";
import * as ReactDomClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";

import * as Scratchpad from "@pragma/scratchpad";
import * as ScratchpadPrimitives from "@pragma/scratchpad/ui/primitives";
import * as ScratchpadUi from "@pragma/scratchpad/ui";

declare global {
  var pragmaScratchpadToken: string | undefined;
  var pragmaScratchpadFrame: {
    React: typeof React;
    ReactDomClient: typeof ReactDomClient;
    ReactJsxRuntime: typeof ReactJsxRuntime;
    Scratchpad: typeof Scratchpad;
    ScratchpadUi: typeof ScratchpadUi;
    ScratchpadPrimitives: typeof ScratchpadPrimitives;
    withScratchpadBoundary: typeof withScratchpadBoundary;
  };
}

interface BoundaryProps {
  children: ReactNode;
  name: string;
}

interface BoundaryState {
  error: Error | null;
}

class ScratchpadErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    globalThis.parent.postMessage(
      {
        channel: "pragma-scratchpad",
        token: globalThis.pragmaScratchpadToken,
        type: "component-error",
        message: `${this.props.name}: ${error.message}`,
        stack: info.componentStack,
      },
      "*",
    );
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="pragma-component-error" role="alert">
          <strong>{this.props.name} failed to render</strong>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Wraps one imported scratchpad component in an isolated React error boundary. */
function withScratchpadBoundary<P extends object>(
  Wrapped: React.ComponentType<P>,
  name: string,
): React.ComponentType<P> {
  function Bounded(props: P): React.JSX.Element {
    return (
      <ScratchpadErrorBoundary name={name}>
        {React.createElement(Wrapped, props)}
      </ScratchpadErrorBoundary>
    );
  }
  Bounded.displayName = `ScratchpadBoundary(${name})`;
  return Bounded;
}

globalThis.pragmaScratchpadFrame = {
  React,
  ReactDomClient,
  ReactJsxRuntime,
  Scratchpad,
  ScratchpadUi,
  ScratchpadPrimitives,
  withScratchpadBoundary,
};
