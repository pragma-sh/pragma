import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Keys } from "@/components/keys";

/**
 * MDX component map for docs pages; extend this to expose custom components to authors.
 *
 * The cast is required because `@react-three/fiber` augments `JSX.IntrinsicElements` with
 * every three.js export, and `MDXComponents` — which is indexed by intrinsic element name —
 * then contains entries (e.g. `createCanvasElement`) whose props are not component props.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Keys,
    ...components,
  } as MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
