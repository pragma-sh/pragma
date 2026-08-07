import { useEffect, useState } from "react";

import type { WslDistroList } from "@pragma/constants";

import { listWslDistros } from "@/lib/tauri";

/** A host with no WSL — every non-Windows machine, and Windows without it. */
const NO_WSL: WslDistroList = { isWindows: false, distros: [] };

/**
 * Narrows whatever the IPC boundary actually returned to a usable list.
 *
 * The probe is the only WSL affordance's data source and it sits behind an
 * untyped `invoke`, so a null or half-shaped reply must degrade to "no WSL"
 * rather than crash the tab strip that renders the menu.
 */
function asDistroList(value: unknown): WslDistroList {
  if (!value || typeof value !== "object") return NO_WSL;
  const list = value as Partial<WslDistroList>;
  return Array.isArray(list.distros)
    ? { isWindows: list.isWindows === true, distros: list.distros }
    : NO_WSL;
}

/**
 * Probes WSL once per mount.
 *
 * The probe shells out to `wsl.exe`, so it is deliberately not run on every
 * render or menu open; a distribution installed while the app is running
 * appears after the next reload. A failed probe reports an empty list, which
 * hides every WSL affordance rather than surfacing an error the user can do
 * nothing about.
 */
export function useWslDistros(): WslDistroList {
  const [distros, setDistros] = useState<WslDistroList>(NO_WSL);

  useEffect(() => {
    let cancelled = false;
    void listWslDistros()
      .catch(() => NO_WSL)
      .then((result) => {
        if (!cancelled) setDistros(asDistroList(result));
        return result;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return distros;
}
