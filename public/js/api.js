// Small fetch() wrapper: adds the token, parses JSON, throws ApiError on failure.
import { state } from './store.js';

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.message || `Request failed (${status})`);
    this.status = status;   // 0 = network error (offline)
    this.data = data || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: 'NETWORK', message: "Can't reach the server - are you offline?" });
  }

  const data = await res.json().catch(() => null);
  if (res.status === 401 && state.token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path, body) => request('DELETE', path, body),
};

// "/boards" -> "/tenants/7/boards" for the branch we're looking at
export const tp = (path) => `/tenants/${state.tenantId}${path}`;
