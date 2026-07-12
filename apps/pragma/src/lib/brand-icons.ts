import { addCollection, type IconifyJSON } from "@iconify/react";

import brandIcons from "@/lib/brand-icons.json";

/**
 * Editor/launcher brand icons (`lucide:*` + `simple-icons:*`), resolved entirely
 * offline.
 *
 * The `brandIcon` ids in `@pragma/constants` (e.g. `lucide:folder-open`,
 * `simple-icons:cursor`) would otherwise be fetched from the Iconify API over
 * the network — unacceptable in a desktop app and flaky in tests. Rather than
 * bundle the full multi-megabyte `@iconify-json/*` collections for a handful of
 * icons, `brand-icons.json` is a curated subset containing only the icons the
 * launchers actually reference. Registering both prefixes once at startup makes
 * every `<Icon icon="lucide:…" />` / `<Icon icon="simple-icons:…" />` resolve
 * synchronously from local data. Mirrors the file-tree approach in
 * {@link file-icons}.
 */
addCollection(brandIcons.lucide as IconifyJSON);
addCollection(brandIcons["simple-icons"] as IconifyJSON);
addCollection(brandIcons.brand as IconifyJSON);
