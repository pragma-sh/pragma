import { getBridge } from "./bridge";

// Re-export the `react` types plugin authors need for full IntelliSense.
// `import type` is fully erased (verbatimModuleSyntax), so this never pulls
// the real `react` package into a compiled plugin bundle. `react`'s own
// declaration file uses `export =`, which disallows a wildcard `export *`
// re-export — so this is an explicit (if long) named list instead.
export type {
  ChangeEvent,
  ComponentProps,
  ComponentPropsWithoutRef,
  ComponentPropsWithRef,
  ComponentType,
  Context,
  CSSProperties,
  DependencyList,
  Dispatch,
  EffectCallback,
  ElementType,
  FC,
  FocusEvent,
  ForwardedRef,
  FormEvent,
  JSX,
  JSXElementConstructor,
  KeyboardEvent,
  MouseEvent,
  PropsWithChildren,
  ReactElement,
  ReactNode,
  Ref,
  RefObject,
  SetStateAction,
  SyntheticEvent,
} from "react";

// Runtime values come from the host bridge, never from a real `react` import.
// This is deliberate: a plugin author's bundler typically aliases the bare
// `"react"` specifier to `@pragma/plugin/react` so every dependency shares one
// React instance with the host. If this module itself imported `"react"`
// normally, that alias would redirect right back here — an infinite loop.
// Sourcing values from `__PRAGMA__.react` avoids that entirely.
const react: typeof import("react") = getBridge().react;

// `--isolatedDeclarations` forbids destructured exports (each binding's type
// can't be inferred per-file without full inference), so every export below
// is spelled out individually with its type explicitly annotated.
export default react;
export const Children: typeof react.Children = react.Children;
export const Component: typeof react.Component = react.Component;
export const Fragment: typeof react.Fragment = react.Fragment;
export const Profiler: typeof react.Profiler = react.Profiler;
export const PureComponent: typeof react.PureComponent = react.PureComponent;
export const StrictMode: typeof react.StrictMode = react.StrictMode;
export const Suspense: typeof react.Suspense = react.Suspense;
export const cloneElement: typeof react.cloneElement = react.cloneElement;
export const createContext: typeof react.createContext = react.createContext;
export const createElement: typeof react.createElement = react.createElement;
export const createRef: typeof react.createRef = react.createRef;
export const forwardRef: typeof react.forwardRef = react.forwardRef;
export const isValidElement: typeof react.isValidElement = react.isValidElement;
export const lazy: typeof react.lazy = react.lazy;
export const memo: typeof react.memo = react.memo;
export const startTransition: typeof react.startTransition = react.startTransition;
export const use: typeof react.use = react.use;
export const useActionState: typeof react.useActionState = react.useActionState;
export const useCallback: typeof react.useCallback = react.useCallback;
export const useContext: typeof react.useContext = react.useContext;
export const useDebugValue: typeof react.useDebugValue = react.useDebugValue;
export const useDeferredValue: typeof react.useDeferredValue = react.useDeferredValue;
export const useEffect: typeof react.useEffect = react.useEffect;
export const useId: typeof react.useId = react.useId;
export const useImperativeHandle: typeof react.useImperativeHandle = react.useImperativeHandle;
export const useInsertionEffect: typeof react.useInsertionEffect = react.useInsertionEffect;
export const useLayoutEffect: typeof react.useLayoutEffect = react.useLayoutEffect;
export const useMemo: typeof react.useMemo = react.useMemo;
export const useOptimistic: typeof react.useOptimistic = react.useOptimistic;
export const useReducer: typeof react.useReducer = react.useReducer;
export const useRef: typeof react.useRef = react.useRef;
export const useState: typeof react.useState = react.useState;
export const useSyncExternalStore: typeof react.useSyncExternalStore = react.useSyncExternalStore;
export const useTransition: typeof react.useTransition = react.useTransition;
export const version: typeof react.version = react.version;
