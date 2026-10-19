import type { ChatSession } from '@/store/useChatStore';
import { getApiURL } from '@/lib/client/api';

const AUTH_TOKEN_KEY = 'xiaoyibao-auth-token';

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
};

type AuthResponse = {
  token: string;
  user: AuthUser;
};

export type HistorySnapshot = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

export function getAuthToken() {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

export function setAuthToken(token: string) {
  window.localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function registerAccount(input: {
  username: string;
  displayName: string;
  password: string;
}) {
  return authRequest('/api/auth/register', input);
}

export async function loginAccount(input: { username: string; password: string }) {
  return authRequest('/api/auth/login', input);
}

export async function logoutAccount() {
  const token = getAuthToken();
  if (!token) {
    return;
  }

  await fetch(getApiURL('/api/auth/logout'), {
    method: 'POST',
    headers: authHeaders(token),
  }).catch(() => undefined);
}

export async function fetchCurrentUser() {
  const token = getAuthToken();
  if (!token) {
    throw new Error('请先登录');
  }

  const response = await fetch(getApiURL('/api/auth/me'), {
    headers: authHeaders(token),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || '登录已过期，请重新登录');
  }

  return payload.user as AuthUser;
}

export async function fetchHistory() {
  const token = getAuthToken();
  const response = await fetch(getApiURL('/api/history'), {
    headers: authHeaders(token),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || '读取历史记录失败');
  }

  return {
    sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
    activeSessionId: payload.activeSessionId || null,
  } satisfies HistorySnapshot;
}

export async function saveHistory(snapshot: HistorySnapshot) {
  const token = getAuthToken();
  if (!token) {
    return;
  }

  const response = await fetch(getApiURL('/api/history'), {
    method: 'PUT',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || '保存历史记录失败');
  }
}

async function authRequest(path: string, body: unknown) {
  const response = await fetch(getApiURL(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || '登录请求失败');
  }

  return payload as AuthResponse;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}
