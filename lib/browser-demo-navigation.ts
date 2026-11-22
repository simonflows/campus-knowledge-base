const sections = new Set([
  "/",
  "/knowledge",
  "/editor",
  "/check",
  "/analytics",
  "/requests",
  "/work",
  "/login",
]);
const origin = "https://browser-demo.invalid";

export type DemoLocation = { pathname: string; search: string; anchor: string };

export function readDemoLocation(fragment: string): DemoLocation {
  const value = fragment.replace(/^#/, "");
  const parsed =
    value.startsWith("/") && !value.startsWith("//")
      ? new URL(value, origin)
      : null;
  if (!parsed || parsed.origin !== origin || !sections.has(parsed.pathname)) {
    return {
      pathname: "/",
      search: "",
      anchor: fragment.startsWith("#/") ? "" : fragment,
    };
  }
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    anchor: parsed.hash,
  };
}

export function demoHref(href: string, location?: DemoLocation): string | null {
  if (href.startsWith("#")) {
    return `#${location?.pathname ?? "/"}${location?.search ?? ""}${href}`;
  }
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const parsed = new URL(href, origin);
  if (parsed.origin !== origin || !sections.has(parsed.pathname)) return null;
  return `#${parsed.pathname}${parsed.search}${parsed.hash}`;
}
