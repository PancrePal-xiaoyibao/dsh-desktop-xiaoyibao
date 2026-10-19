const apiBaseURL = normalizeBaseURL(process.env.NEXT_PUBLIC_API_BASE_URL);
const wsBaseURL = normalizeBaseURL(
  process.env.NEXT_PUBLIC_WS_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL
);

export function getApiURL(path: string) {
  if (!apiBaseURL) {
    return path;
  }

  return new URL(path, apiBaseURL).toString();
}

export function getWebSocketURL(path: string) {
  if (wsBaseURL) {
    const url = new URL(path, wsBaseURL);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    }
    if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }
    return url.toString();
  }

  if (typeof window === 'undefined') {
    return path;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

function normalizeBaseURL(value: string | undefined) {
  if (!value) {
    return '';
  }

  return value.endsWith('/') ? value : `${value}/`;
}
