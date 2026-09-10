// Message types exchanged between the content script, popup, options page and
// the background service worker.
//
// The content script cannot import this module (MV3 content scripts are classic
// scripts, not ES modules), so it mirrors these strings locally. Keep the two
// lists in sync: content/scryfall.js has a matching MSG constant near the top.
export const MSG = {
  GET_STATE: 'GET_STATE',
  LOOKUP_CARDS: 'LOOKUP_CARDS',
  GET_ADD_TARGETS: 'GET_ADD_TARGETS',
  ADD_TO_CUBE: 'ADD_TO_CUBE',
  MOVE_BOARD: 'MOVE_BOARD',
  SYNC: 'SYNC',
  LIST_MY_CUBES: 'LIST_MY_CUBES',
  SET_SETTINGS: 'SET_SETTINGS',
  SET_TRACKED_CUBES: 'SET_TRACKED_CUBES',
};
