/**
 * Detects an SPA fallback response (Vite dev / Firebase Hosting rewrite `**` -> /index.html),
 * which returns index.html with HTTP 200 for files that do not exist.
 * True when the Content-Type is text/html or the body begins with `<!doctype html` / `<html`.
 */
export function isSpaFallback(contentType: string | null, body: string): boolean {
  if (contentType && contentType.toLowerCase().includes('text/html')) return true;
  const head = body.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}
