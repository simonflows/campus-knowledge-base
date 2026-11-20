export function getTrustedPreviewOrigin(
  mode: string | undefined,
  configuredOrigin: string | undefined
): string | null {
  if (mode !== "development" || !configuredOrigin) return null;

  try {
    const url = new URL(configuredOrigin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (
      configuredOrigin !== url.origin &&
      configuredOrigin !== `${url.origin}/`
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}
