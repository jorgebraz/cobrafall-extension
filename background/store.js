// Thin wrapper over chrome.storage.local.
//
// Keys:
//   settings   user preferences and the tracked-cube list
//   cube:<id>  one cached cube: metadata, boards, and a flat card list
//   index      merged name -> hits map, rebuilt whenever a cube record changes
//   meta       last sync timestamp and the last sync's per-cube errors

export const DEFAULT_SETTINGS = {
  enabled: true,
  // [{ id, shortId, name, enabled }] — tracked means "keep a local copy",
  // enabled means "count it when marking cards".
  trackedCubes: [],
  includeBasics: false,
  filterMode: 'all', // all | hide-owned | only-owned
  ttlMinutes: 360,
  showBar: true,
  showAddButton: true,
  // Which edge of the card art the badge and button sit against. Bottom by
  // default: the top right of a Magic card is its mana cost.
  overlayAnchor: 'bottom', // bottom | top
  colors: { mainboard: '#2ea043', other: '#d29922' },
};

const cubeKey = (id) => `cube:${id}`;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    colors: { ...DEFAULT_SETTINGS.colors, ...((settings && settings.colors) || {}) },
  };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  if (patch && patch.colors) {
    next.colors = { ...DEFAULT_SETTINGS.colors, ...patch.colors };
  }
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getCube(id) {
  const key = cubeKey(id);
  const got = await chrome.storage.local.get(key);
  return got[key] || null;
}

export async function getCubes(ids) {
  if (!ids.length) return [];
  const got = await chrome.storage.local.get(ids.map(cubeKey));
  return ids.map((id) => got[cubeKey(id)] || null).filter(Boolean);
}

export async function putCube(record) {
  await chrome.storage.local.set({ [cubeKey(record.id)]: record });
}

export async function deleteCubes(ids) {
  if (!ids.length) return;
  await chrome.storage.local.remove(ids.map(cubeKey));
}

export async function getIndex() {
  const { index } = await chrome.storage.local.get('index');
  return index || {};
}

export async function putIndex(index) {
  await chrome.storage.local.set({ index });
}

export async function getMeta() {
  const { meta } = await chrome.storage.local.get('meta');
  return meta || { lastSync: 0, errors: {} };
}

export async function setMeta(patch) {
  const next = { ...(await getMeta()), ...patch };
  await chrome.storage.local.set({ meta: next });
  return next;
}
