export function httpsRepositoryUrl(input: string): string | null {
  if (!input || /[\x00-\x20\x7f\\]/.test(input) || /\[redacted\]/i.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (/[\x00-\x1f\x7f]/.test(decodedPath)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return null;
  }
}
