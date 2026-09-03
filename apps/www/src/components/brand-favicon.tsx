import type { ComponentProps } from "react";

import { CANVAS, faviconLayer, INK, ON_DARK } from "@pragma/brand";

const faviconMarkup = faviconLayer(INK, ON_DARK.stroke, "site-navbar-favicon");

/** Compact Pragma favicon treatment rendered from `@pragma/brand` geometry. */
export function BrandFavicon(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      aria-hidden="true"
      focusable="false"
      {...props}
      dangerouslySetInnerHTML={{ __html: faviconMarkup }}
    />
  );
}
