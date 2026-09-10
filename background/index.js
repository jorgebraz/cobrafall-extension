// Turns a cubeJSON payload into a compact local record, and merges records into
// the name index the content script queries.

import { nameKeys } from '../shared/normalize.js';

// CubeCobra derives a cube's boards from the keys of its cards object, minus the
// `id` key, because users can create their own boards beyond mainboard and
// maybeboard. Do exactly the same rather than hardcoding a board list.
export function readBoards(cards) {
  return Object.keys(cards || {})
    .filter((key) => key !== 'id' && Array.isArray(cards[key]))
    .map((key) => ({ key, label: boardLabel(key), count: cards[key].length }));
}

export function boardLabel(key) {
  if (!key) return '';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function toCubeRecord(json, id) {
  const cards = json.cards || {};
  const boards = readBoards(cards);
  const flat = [];

  for (const board of boards) {
    for (const entry of cards[board.key]) {
      const details = entry.details || {};
      const name = details.name || details.name_lower;
      if (!name) continue;
      flat.push({
        name,
        board: board.key,
        set: (details.set || '').toUpperCase(),
        cn: details.collector_number || '',
        printId: entry.cardID || details.scryfall_id || '',
      });
    }
  }

  return {
    // Key the record by the id we track the cube under, not by the id in the
    // payload. Those differ whenever a cube is addressed by its short id, and a
    // mismatch would silently orphan the cached copy.
    id: id || json.id,
    canonicalId: json.id || '',
    shortId: json.shortId || '',
    name: json.name || id,
    visibility: json.visibility || '',
    dateUpdated: Number(json.date) || Number(json.dateLastUpdated) || 0,
    fetchedAt: Date.now(),
    boards,
    cards: flat,
    error: null,
  };
}

// index: normalized name -> [{ c: cubeId, b: boardKey, s: set, n: collectorNumber }]
export function buildIndex(records, settings) {
  const index = {};

  for (const record of records) {
    for (const card of record.cards) {
      if (!settings.includeBasics && card.board === 'basics') continue;
      for (const key of nameKeys(card.name)) {
        const list = index[key] || (index[key] = []);
        const seen = list.some((hit) => hit.c === record.id && hit.b === card.board);
        if (!seen) list.push({ c: record.id, b: card.board, s: card.set, n: card.cn });
      }
    }
  }

  return index;
}

// Expands stored hits into what the overlay needs to render a badge.
export function hydrate(hits, cubesById) {
  return hits
    .map((hit) => {
      const cube = cubesById[hit.c];
      if (!cube) return null;
      return {
        cubeId: hit.c,
        cubeName: cube.name,
        board: hit.b,
        boardLabel: boardLabel(hit.b),
        set: hit.s,
        collectorNumber: hit.n,
      };
    })
    .filter(Boolean);
}
