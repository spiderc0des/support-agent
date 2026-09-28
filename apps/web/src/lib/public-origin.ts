/**
 * The address people actually reach the app on, for building redirects.
 * (Week 5: behind Railway's proxy, request.url is the container's own
 * http://localhost:8080, and a redirect built from it goes nowhere.)
 *
 * Order: NEXT_PUBLIC_APP_URL, then the proxy's forwarded host, then the
 * request itself for local development.
 */
export function publicOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (configured && /^https?:\/\//.test(configured)) return configured;

  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))?.split(",")[0].trim();
  if (host) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
      (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

/** A redirect target on the public origin. `path` must be app-relative. */
export function publicUrl(path: string, request: Request): URL {
  return new URL(path, publicOrigin(request));
}
