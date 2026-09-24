export function requireContractTarget(env = process.env) {
  if (!env.HAPPYVIEW_BASE_URL) throw new Error('HAPPYVIEW_BASE_URL must point to the supplied running local HappyView instance');
  const url = new URL(env.HAPPYVIEW_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HAPPYVIEW_BASE_URL must use HTTP or HTTPS');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('HTTP contracts are restricted to a local HappyView URL');
  return url;
}

export function contractUrl(baseUrl, nsid, params = {}) {
  const url = new URL(`/xrpc/${nsid}`, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
  }
  // HappyView's current query decoder mishandles '+' as a space; encode spaces as %20.
  url.search = url.search.replaceAll('+', '%20');
  return url.toString();
}
