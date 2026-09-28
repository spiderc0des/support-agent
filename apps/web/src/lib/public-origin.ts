/**
 * The address people actually reach the app on, for building redirects.
 * (Week 5: behind Railway's proxy, request.url is the container's own
 * http://localhost:8080, and a redirect built from it goes nowhere.)
 *
 * Order: the host the browser actually used (the proxy's X-Forwarded-Host,
 * or Host), then NEXT_PUBLIC_APP_URL, then the request URL. The browser's own
 * host comes first so that signing in on localhost, an ngrok URL, or the
 * Railway domain always lands back where you started, even if
 * NEXT_PUBLIC_APP_URL names a different one of them.
 */
export function publicOrigin(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
  const direct = request.headers.get("host")?.split(",")[0].trim();
  // Inside a container, Host can be the internal address; only trust it
  // when there is no proxy in front, which is local development.
  const host = forwarded ?? (direct && /^(localhost|127\.0\.0\.1)(:|$)/.test(direct) ? direct : null);
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (!host && configured && /^https?:\/\//.test(configured)) return configured;

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
