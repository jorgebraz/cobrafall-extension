// Every CubeCobra request lives here, and every one of them runs in the service
// worker rather than the content script.
//
// The reason is credentials. CubeCobra answers cubeJSON with
// `Access-Control-Allow-Origin: *`, and a wildcard forbids credentialed CORS, so
// a page script could never read a private or unlisted cube. An extension with
// host_permissions for cubecobra.com is not subject to CORS at all and can send
// the session cookie, which is what makes private cubes work.

const BASE = 'https://cubecobra.com';

// cubeJSON is rate limited to 100 requests per minute per user or IP. The sync
// path checks date_updated first so a normal refresh costs one small request per
// cube, but keep a floor between full pulls anyway.
const FETCH_GAP_MS = 250;
let lastFetchAt = 0;

async function throttle() {
  const wait = lastFetchAt + FETCH_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

async function ccFetch(path, init = {}) {
  await throttle();
  return fetch(BASE + path, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) },
  });
}

// CubeCobra's CSRF middleware is currently disabled server side: csurf() is
// commented out and the token resolves to an empty string. Send the header
// anyway, sourced from a real page when one is parseable, so that adding to a
// cube keeps working if the check is turned back on.
let csrfToken = null;

async function getCsrfToken() {
  if (csrfToken !== null) return csrfToken;
  csrfToken = '';
  try {
    const res = await ccFetch('/', { headers: { Accept: 'text/html' } });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/"csrfToken"\s*:\s*"([^"]*)"/);
      if (m) csrfToken = m[1];
    }
  } catch {
    // Offline or blocked: fall through with an empty token.
  }
  return csrfToken;
}

export async function fetchMyCubes() {
  const res = await ccFetch('/cube/api/mycubes');
  if (res.status === 401 || res.status === 302) return { ok: false, needsLogin: true };
  if (!res.ok) return { ok: false, message: `CubeCobra returned ${res.status}` };
  const body = await res.json();
  if (body.success !== 'true') return { ok: false, message: 'CubeCobra rejected the request' };
  return { ok: true, cubes: body.cubes || [] };
}

// Returns the cube's last-edited timestamp in epoch ms, or null if it could not
// be read. Cheap enough to call for every tracked cube on every refresh.
export async function fetchDateUpdated(id) {
  const res = await ccFetch(`/cube/api/date_updated/${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Cube not found, or not visible to you');
    throw new Error(`CubeCobra returned ${res.status}`);
  }
  const body = await res.json();
  const date = Number(body.date_updated);
  return Number.isFinite(date) ? date : null;
}

export async function fetchCubeJSON(id) {
  const res = await ccFetch(`/cube/api/cubeJSON/${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Cube not found, or not visible to you');
    if (res.status === 429) throw new Error('Rate limited by CubeCobra, try again shortly');
    throw new Error(`CubeCobra returned ${res.status}`);
  }
  return res.json();
}

// Applies a changelog to a cube: per-board adds, removes, swaps and edits. This
// is the endpoint the cube editor itself posts to, and the only way to take a
// card off a board, so a move between boards is a remove plus an add.
//
// expectedVersion guards it. CubeCobra rejects the commit with 409 if the cube
// moved on since the version was read, so always read the version and the card
// indices from the same cubeJSON response used to build the changes.
export async function commitChanges(cubeId, changes, expectedVersion) {
  const token = await getCsrfToken();
  const res = await ccFetch('/cube/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CSRF-Token': token },
    body: JSON.stringify({
      id: cubeId,
      changes: { ...changes, version: expectedVersion },
      expectedVersion,
      useBlog: false,
      title: '',
      blog: '',
    }),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && body.success === 'true') return { ok: true, version: body.version };

  return { ok: false, status: res.status, message: (body && body.message) || `CubeCobra returned ${res.status}` };
}

// board is the raw board key from cubeJSON. The server runs it through
// boardNameToKey (lowercase, whitespace stripped), so a key is always valid.
export async function addToCube(cubeId, board, printId) {
  const token = await getCsrfToken();
  const res = await ccFetch(`/cube/api/addtocube/${encodeURIComponent(cubeId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CSRF-Token': token },
    body: JSON.stringify({ cards: [printId], board, createBlogPost: false }),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && body.success === 'true') return { ok: true };

  const message = (body && body.message) || `CubeCobra returned ${res.status}`;
  return { ok: false, status: res.status, message };
}
