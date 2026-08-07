import { describe, expect, it } from "vitest";

import { constants, type WslDistro } from "@pragma/constants";

import {
  NATIVE_PROFILE,
  defaultProfile,
  effectiveDefaultProfile,
  profileLabel,
  resolveDefaultProfile,
  resolveHiddenDistros,
  sameProfile,
  visibleDistros,
  wslProfile,
} from "./shell-profile";

function distro(name: string): WslDistro {
  return { name, running: false, version: 2, default: false };
}

/** A name the shipped defaults hide, so the tests assert against real data. */
const HIDDEN_BY_DEFAULT = constants.terminalDefaults.hiddenDistros[0] ?? "docker-desktop";

describe("visibleDistros", () => {
  it("hides the shipped Docker VM distributions by default", () => {
    const names = visibleDistros([distro("Ubuntu"), distro(HIDDEN_BY_DEFAULT)], undefined).map(
      (entry) => entry.name,
    );
    expect(names).toEqual(["Ubuntu"]);
  });

  /// The names WSL reports vary in case between installs, so matching has to
  /// be case-insensitive or the shipped hide list silently stops working.
  it("matches hidden names regardless of case", () => {
    expect(visibleDistros([distro("Docker-Desktop")], ["docker-desktop"])).toEqual([]);
  });

  it("lets a project replace the hidden list rather than merge with it", () => {
    expect(visibleDistros([distro(HIDDEN_BY_DEFAULT)], []).map((entry) => entry.name)).toEqual([
      HIDDEN_BY_DEFAULT,
    ]);
  });
});

describe("sameProfile", () => {
  it("separates the WSL default from a named distribution", () => {
    expect(sameProfile(wslProfile(null), wslProfile("Ubuntu"))).toBe(false);
  });

  it("treats a missing distro and an explicit null as the same choice", () => {
    expect(sameProfile({ backend: "wsl" }, wslProfile(null))).toBe(true);
  });

  it("separates backends", () => {
    expect(sameProfile(NATIVE_PROFILE, wslProfile(null))).toBe(false);
  });
});

describe("defaultProfile", () => {
  /// An unconfigured project must send no profile at all, so the server keeps
  /// resolving the shell exactly as it did before shell selection existed.
  it("is null when the project configures no backend", () => {
    expect(defaultProfile(undefined)).toBeNull();
    expect(defaultProfile({})).toBeNull();
  });

  it("carries the configured distribution", () => {
    expect(defaultProfile({ backend: "wsl", distro: "Ubuntu" })).toEqual(wslProfile("Ubuntu"));
  });

  it("ignores a stale distro when the backend is native", () => {
    expect(defaultProfile({ backend: "native", distro: "Ubuntu" })).toEqual(NATIVE_PROFILE);
  });
});

describe("resolveDefaultProfile", () => {
  it("prefers the project scope over the global one", () => {
    expect(
      resolveDefaultProfile([{ backend: "wsl", distro: "Ubuntu" }, { backend: "native" }]),
    ).toEqual(wslProfile("Ubuntu"));
  });

  it("falls through to the global scope when the project names none", () => {
    expect(resolveDefaultProfile([{ shell: "/usr/bin/fish" }, { backend: "wsl" }])).toEqual(
      wslProfile(null),
    );
  });

  /// backend and distro must come from the same scope: a project that switches
  /// back to the native shell must not inherit the global scope's distro.
  it("does not mix a backend from one scope with a distro from another", () => {
    expect(
      resolveDefaultProfile([{ backend: "native" }, { backend: "wsl", distro: "Ubuntu" }]),
    ).toEqual(NATIVE_PROFILE);
  });

  it("is null when no scope configures anything", () => {
    expect(resolveDefaultProfile([undefined, undefined])).toBeNull();
  });
});

describe("effectiveDefaultProfile", () => {
  /// Regression: a distro-less WSL default matched no menu entry, so the menu
  /// drew no default badge at all.
  it("resolves a distro-less WSL default to the distribution WSL names", () => {
    expect(
      effectiveDefaultProfile(wslProfile(null), [
        { ...distro("Ubuntu"), default: true },
        distro("Debian"),
      ]),
    ).toEqual(wslProfile("Ubuntu"));
  });

  it("leaves an explicitly named distribution alone", () => {
    expect(
      effectiveDefaultProfile(wslProfile("Debian"), [{ ...distro("Ubuntu"), default: true }]),
    ).toEqual(wslProfile("Debian"));
  });

  it("leaves the native profile alone", () => {
    expect(
      effectiveDefaultProfile(NATIVE_PROFILE, [{ ...distro("Ubuntu"), default: true }]),
    ).toEqual(NATIVE_PROFILE);
  });

  it("keeps a distro-less profile when WSL reports no default", () => {
    expect(effectiveDefaultProfile(wslProfile(null), [distro("Ubuntu")])).toEqual(wslProfile(null));
  });
});

describe("resolveHiddenDistros", () => {
  it("takes the first scope that sets a list, empty included", () => {
    expect(
      resolveHiddenDistros([{ hiddenDistros: [] }, { hiddenDistros: ["docker-desktop"] }]),
    ).toEqual([]);
    expect(resolveHiddenDistros([undefined, { hiddenDistros: ["docker-desktop"] }])).toEqual([
      "docker-desktop",
    ]);
    expect(resolveHiddenDistros([undefined, undefined])).toBeUndefined();
  });
});

describe("profileLabel", () => {
  it("names the distribution, or the WSL default", () => {
    expect(profileLabel(wslProfile("Ubuntu"))).toBe("Ubuntu");
    expect(profileLabel(wslProfile(null))).toBe("WSL (default)");
    expect(profileLabel(null)).toBe("Terminal");
  });
});
