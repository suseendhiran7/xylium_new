// Thin fetch wrapper: same-origin cookies, CSRF header on writes, one error shape.

let csrfToken = null;
let onUnauthorized = () => {};

export function setCsrfToken(t) {
  csrfToken = t;
}
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Request failed (${status})`);
    this.status = status;
    this.code = body && body.error;
    this.details = body && body.details;
  }
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text };
  }
  if (res.status === 401 && !url.endsWith('/auth/login') && !url.endsWith('/auth/me')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

/** PUT a File as the raw request body (application/octet-stream). */
async function upload(url, file) {
  const headers = { 'content-type': 'application/octet-stream' };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(url, { method: 'PUT', headers, credentials: 'same-origin', body: file });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text };
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
  upload,
};

export const UNCHANGED = '__UNCHANGED__';
