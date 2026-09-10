import { MSG } from '../shared/messages.js';
import { nameKeys } from '../shared/normalize.js';
import { addToCube, fetchCubeJSON, fetchDateUpdated, fetchMyCubes } from './cubecobra.js';
import { buildIndex, hydrate, toCubeRecord } from './index.js';
import {
  deleteCubes,
  getCubes,
  getIndex,
  getMeta,
  getSettings,
  putCube,
  putIndex,
  setMeta,
  setSettings,
} from './store.js';

const ALARM = 'cobrafall-sync';

// ---------------------------------------------------------------- sync

let inFlight = null;

function trackedIds(settings) {
  return settings.trackedCubes.map((cube) => cube.id);
}

async function refreshOne(id, { force }) {
  const [existing] = await getCubes([id]);

  if (!force && existing && Date.now() - existing.fetchedAt < 60 * 1000) {
    return existing;
  }

  // date_updated is a few bytes; cubeJSON is a few hundred kilobytes gzipped.
  // Only pull the big one when the cube actually moved.
  if (!force && existing) {
    const dateUpdated = await fetchDateUpdated(id);
    if (dateUpdated !== null && dateUpdated === existing.dateUpdated) {
      const touched = { ...existing, fetchedAt: Date.now(), error: null };
      await putCube(touched);
      return touched;
    }
  }

  const json = await fetchCubeJSON(id);
  const record = toCubeRecord(json, id);
  await putCube(record);
  return record;
}

async function rebuildIndex(settings) {
  const enabled = settings.trackedCubes.filter((cube) => cube.enabled).map((cube) => cube.id);
  const records = await getCubes(enabled);
  await putIndex(buildIndex(records, settings));
  return records;
}

async function syncAll({ force = false } = {}) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const settings = await getSettings();
    const errors = {};

    for (const tracked of settings.trackedCubes) {
      try {
        const record = await refreshOne(tracked.id, { force });
        // Cube names change; keep the settings copy in step with the real one.
        if (record.name && record.name !== tracked.name) tracked.name = record.name;
      } catch (err) {
        errors[tracked.id] = err.message || String(err);
        const [existing] = await getCubes([tracked.id]);
        if (existing) await putCube({ ...existing, error: errors[tracked.id] });
      }
    }

    await setSettings({ trackedCubes: settings.trackedCubes });
    await rebuildIndex(settings);
    await setMeta({ lastSync: Date.now(), errors });
    return { ok: true, errors };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function syncIfStale() {
  const [settings, meta] = await Promise.all([getSettings(), getMeta()]);
  if (!settings.trackedCubes.length) return;
  const ttl = Math.max(5, settings.ttlMinutes) * 60 * 1000;
  if (Date.now() - meta.lastSync >= ttl) syncAll().catch(() => {});
}

// ---------------------------------------------------------------- lookup

async function lookupCards(names) {
  const [settings, index] = await Promise.all([getSettings(), getIndex()]);
  const cubesById = {};
  for (const cube of settings.trackedCubes) cubesById[cube.id] = cube;

  const hits = {};
  if (settings.enabled) {
    for (const name of names) {
      const merged = [];
      const seen = new Set();
      for (const key of nameKeys(name)) {
        for (const hit of index[key] || []) {
          const dedupe = `${hit.c}|${hit.b}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          merged.push(hit);
        }
      }
      if (merged.length) hits[name] = hydrate(merged, cubesById);
    }
  }

  syncIfStale();

  return {
    hits,
    enabled: settings.enabled,
    colors: settings.colors,
    filterMode: settings.filterMode,
    showAddButton: settings.showAddButton,
  };
}

// ---------------------------------------------------------------- state

async function getState() {
  const [settings, meta] = await Promise.all([getSettings(), getMeta()]);
  const records = await getCubes(trackedIds(settings));
  const byId = {};
  for (const record of records) byId[record.id] = record;

  const cubes = settings.trackedCubes.map((tracked) => {
    const record = byId[tracked.id];
    return {
      ...tracked,
      cardCount: record ? record.cards.length : 0,
      boards: record ? record.boards : [],
      fetchedAt: record ? record.fetchedAt : 0,
      error: (meta.errors || {})[tracked.id] || (record && record.error) || null,
    };
  });

  return { settings, cubes, lastSync: meta.lastSync };
}

async function getAddTargets() {
  const settings = await getSettings();
  const enabled = settings.trackedCubes.filter((cube) => cube.enabled);
  const records = await getCubes(enabled.map((cube) => cube.id));
  const byId = {};
  for (const record of records) byId[record.id] = record;

  return enabled.map((cube) => ({
    id: cube.id,
    name: cube.name,
    boards: byId[cube.id] ? byId[cube.id].boards : [{ key: 'mainboard', label: 'Mainboard' }],
  }));
}

// Replaces the tracked list wholesale, from the options page.
async function setTrackedCubes(cubes) {
  const settings = await getSettings();
  const nextIds = new Set(cubes.map((cube) => cube.id));
  const dropped = trackedIds(settings).filter((id) => !nextIds.has(id));

  await deleteCubes(dropped);
  await setSettings({ trackedCubes: cubes });
  await syncAll();
  return getState();
}

// After a successful add, patch the cached record and index in place so the
// badge appears immediately instead of waiting for the next sync.
async function applyLocalAdd({ cubeId, board, printId, name, set, collectorNumber }) {
  const [record] = await getCubes([cubeId]);
  if (!record) return;

  record.cards.push({ name, board, set: set || '', cn: collectorNumber || '', printId });
  if (!record.boards.some((entry) => entry.key === board)) {
    record.boards.push({ key: board, label: board.charAt(0).toUpperCase() + board.slice(1), count: 1 });
  }
  await putCube(record);

  const settings = await getSettings();
  await rebuildIndex(settings);
}

// ---------------------------------------------------------------- routing

const handlers = {
  [MSG.GET_STATE]: () => getState(),

  [MSG.LOOKUP_CARDS]: (msg) => lookupCards(msg.names || []),

  [MSG.GET_ADD_TARGETS]: () => getAddTargets(),

  [MSG.SYNC]: async (msg) => {
    const result = await syncAll({ force: !!msg.force });
    return { ...result, ...(await getState()) };
  },

  [MSG.LIST_MY_CUBES]: () => fetchMyCubes(),

  [MSG.SET_SETTINGS]: async (msg) => {
    const settings = await setSettings(msg.patch || {});
    // Enabling or disabling a cube, or the basics board, changes what the index
    // should contain without needing another download.
    if (msg.rebuild !== false) await rebuildIndex(settings);
    return getState();
  },

  [MSG.SET_TRACKED_CUBES]: (msg) => setTrackedCubes(msg.cubes || []),

  [MSG.ADD_TO_CUBE]: async (msg) => {
    let result = await addToCube(msg.cubeId, msg.board, msg.printId);

    // 409 is CubeCobra's optimistic-locking conflict from a concurrent edit to
    // the same cube. One retry usually clears it.
    if (!result.ok && result.status === 409) {
      await new Promise((r) => setTimeout(r, 600));
      result = await addToCube(msg.cubeId, msg.board, msg.printId);
    }

    if (result.ok) {
      await applyLocalAdd(msg);
      return { ok: true, hits: (await lookupCards([msg.name])).hits[msg.name] || [] };
    }

    if (result.status === 403) {
      return { ok: false, message: `You cannot edit ${msg.cubeName || 'that cube'}` };
    }
    if (result.status === 401) {
      return { ok: false, message: 'Log in to CubeCobra first' };
    }
    if (result.status === 409) {
      return { ok: false, message: 'That cube was edited while adding. Try again.' };
    }
    return result;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;

  Promise.resolve(handler(msg))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, message: err.message || String(err) }));

  return true; // response is asynchronous
});

// ---------------------------------------------------------------- schedule

async function scheduleAlarm() {
  const settings = await getSettings();
  const period = Math.max(30, settings.ttlMinutes);
  await chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  syncIfStale();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarm();
  syncIfStale();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) syncAll().catch(() => {});
});
