import values from "../values.json";
import type { Constants } from "./generated/constants";

export type {
  Constants,
  AppInfo,
  WindowDefaults,
  Links,
  Project,
  Worktree,
  Tab,
  ProjectIcon,
} from "./generated/constants";

/**
 * Shared application constants.
 *
 * The values live in `values.json` and are validated against `schema.json`.
 * The same JSON is consumed by the Rust backend (see `src/lib.rs`), so this is
 * the single source of truth across both languages.
 */
export const constants: Constants = values;

export default constants;
