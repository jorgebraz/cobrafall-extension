// Cobrafall — marks Scryfall cards that already live in one of your CubeCobra
// cubes, filters a search by that, and adds a card to a cube in place.
//
// This script never talks to CubeCobra. It asks the service worker, which owns
// the cache and the credentials.

(() => {
  'use strict';

  // Mirrors shared/messages.js. MV3 content scripts are classic scripts and
  // cannot import it, so keep the two in step.
  const MSG = {
    LOOKUP_CARDS: 'LOOKUP_CARDS',
    GET_ADD_TARGETS: 'GET_ADD_TARGETS',
    ADD_TO_CUBE: 'ADD_TO_CUBE',
    MOVE_BOARD: 'MOVE_BOARD',
    REMOVE_FROM_BOARD: 'REMOVE_FROM_BOARD',
    SET_SETTINGS: 'SET_SETTINGS',
    SYNC: 'SYNC',
  };

  const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  // Scryfall image titles read "Esper Sentinel (Modern Horizons 2 #12)".
  const TITLE_SUFFIX = /\s*\([^()]*#[^()]*\)\s*$/;

  const state = {
    settings: { colors: {}, filterMode: 'all', showBar: true, showAddButton: true, enabled: true },
    hits: new Map(), // normalized-ish raw name -> hit list
    entries: [],
    targets: null,
    menu: null,
  };

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch {
        resolve(null); // extension reloaded out from under the page
      }
    });

  // ------------------------------------------------------------- extraction

  function cleanText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('.card-text-mana-cost, .card-symbol').forEach((el) => el.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function nameFromImage(scope) {
    const img = scope.querySelector('img.card[title], img[title]');
    if (!img) return '';
    return img.getAttribute('title').replace(TITLE_SUFFIX, '').trim();
  }

  // Scryfall card links are /card/<set>/<collector number>/<slug>.
  const CARD_PATH = /\/card\/([^/?#]+)\/([^/?#]+)/;

  // The printing on show, used so a card added to a cube can name its printing
  // in the badge tooltip straight away.
  function printingFrom(scope) {
    let href = '';

    // Card pages and full view repeat every other printing further down, so take
    // the language row marked current rather than the first card link found.
    const current = scope.querySelector && scope.querySelector('a.print-langs-item.current[href]');
    if (current) href = current.getAttribute('href');
    else if (scope.matches && scope.matches('a[href]')) href = scope.getAttribute('href');
    else if (scope.querySelector) {
      const links = [...scope.querySelectorAll('a[href*="/card/"]')];
      const own = links.find((link) => !link.closest('.prints-table, .print-langs'));
      if (own) href = own.getAttribute('href');
    }
    if (!href) href = location.pathname;

    const match = href.match(CARD_PATH);
    if (!match) return { set: '', collectorNumber: '' };
    return {
      set: decodeURIComponent(match[1]).toUpperCase(),
      collectorNumber: decodeURIComponent(match[2]),
    };
  }

  function printIdFrom(scope) {
    const own = scope.getAttribute && scope.getAttribute('data-card-id');
    if (own) return own;
    // In full view and on a card page the id sits on the saved-cards button.
    const button = scope.querySelector('.deckbuilder-card-add-button[data-card-id]');
    if (button) return button.getAttribute('data-card-id');
    const img = scope.querySelector('img.card[src]');
    const match = img && img.getAttribute('src').match(UUID);
    return match ? match[1] : '';
  }

  // One collector per Scryfall view. Each returns entries the annotator can use
  // without caring which view produced them.
  const COLLECTORS = [
    // Grid view, and the grid on set and artist pages.
    () =>
      [...document.querySelectorAll('.card-grid-item')].map((node) => ({
        layout: 'grid',
        node,
        anchor: node,
        badgeHost: node,
        name: cleanText(node.querySelector('.card-grid-item-invisible-label')) || nameFromImage(node),
        printId: printIdFrom(node),
        printing: printingFrom(node),
      })),

    // Checklist view. Scoped to the checklist table so the prints table on a
    // card page is left alone.
    () =>
      [...document.querySelectorAll('table.checklist tbody tr[data-card-id]')].map((node) => {
        const cell = node.querySelector('td.ellipsis');
        return {
          layout: 'checklist',
          node,
          anchor: node,
          badgeHost: cell || node,
          name: cleanText(cell && cell.querySelector('a')) || cleanText(cell),
          printId: printIdFrom(node),
          printing: printingFrom(node),
        };
      }),

    // Text view. No image and no card id, so no add button here.
    () =>
      [...document.querySelectorAll('a.card-text.text-grid-item')].map((node) => ({
        layout: 'text',
        node,
        anchor: node,
        badgeHost: node,
        name: cleanText(node.querySelector('.card-text-title')),
        printId: '',
        printing: printingFrom(node),
      })),

    // Full view and the single card page share this markup.
    () =>
      [...document.querySelectorAll('.card-profile')].map((node) => {
        const image = node.querySelector('.card-image');
        return {
          layout: 'profile',
          node,
          anchor: image || node,
          badgeHost: image || node,
          name:
            nameFromImage(node) ||
            cleanText(node.querySelector('.card-text-card-name')) ||
            cleanText(node.querySelector('.card-text-title')),
          printId: printIdFrom(node),
          printing: printingFrom(node),
        };
      }),
  ];

  function collect() {
    const entries = [];
    for (const collector of COLLECTORS) {
      for (const entry of collector()) {
        if (entry.name && entry.anchor) entries.push(entry);
      }
    }
    return entries;
  }

  // A single card page has exactly one card profile and no grid. Everything else
  // showing cards is a listing, including the full view, which renders repeated
  // card profiles rather than a grid.
  const isSearchListing = () =>
    !!document.querySelector('.card-grid, .text-grid, table.checklist') ||
    document.querySelectorAll('.card-profile').length > 1;

  // ------------------------------------------------------------- rendering

  function ringColor(hits) {
    const colors = state.settings.colors || {};
    const main = hits.some((hit) => hit.board === 'mainboard');
    return main ? colors.mainboard || '#2ea043' : colors.other || '#d29922';
  }

  function badgeText(hits) {
    if (hits.length > 1) return `${hits.length} cubes`;
    const hit = hits[0];
    const board = hit.board === 'mainboard' ? '' : ` · ${hit.boardLabel}`;
    return `${hit.cubeName}${board}`;
  }

  function tooltip(hits) {
    return hits
      .map((hit) => {
        const print = hit.set ? ` (${hit.set} #${hit.collectorNumber})` : '';
        return `${hit.cubeName} — ${hit.boardLabel}${print}`;
      })
      .join('\n');
  }

  function clearAnnotation(entry) {
    entry.anchor.classList.remove('cbf-anchor');
    entry.anchor.removeAttribute('data-cbf-state');
    entry.anchor.removeAttribute('data-cbf-filterable');
    entry.anchor.style.removeProperty('--cbf-ring');
    entry.badgeHost.querySelectorAll(':scope > .cbf-badge, :scope > .cbf-add').forEach((el) => el.remove());
  }

  function annotate(entry, hits) {
    clearAnnotation(entry);

    const { anchor, badgeHost } = entry;
    anchor.classList.add('cbf-anchor');
    anchor.dataset.cbfLayout = entry.layout;
    anchor.dataset.cbfState = hits.length ? 'in' : 'out';
    if (entry.filterable) anchor.dataset.cbfFilterable = '1';

    if (hits.length) {
      anchor.style.setProperty('--cbf-ring', ringColor(hits));

      const badge = document.createElement('span');
      badge.className = 'cbf-badge';
      if (entry.layout === 'checklist') badge.classList.add('cbf-badge-inline');
      badge.textContent = badgeText(hits);
      badge.title = tooltip(hits);
      badgeHost.appendChild(badge);
    }

    // The text view carries no printing id, so there is nothing safe to add.
    if (state.settings.showAddButton && entry.printId) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = entry.layout === 'checklist' ? 'cbf-add cbf-add-inline' : 'cbf-add';
      add.textContent = '+';
      add.title = hits.length ? 'Move, remove, or add a copy' : 'Add to a cube';
      add.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openAddMenu(entry, add);
      });
      badgeHost.appendChild(add);
    }
  }

  function render() {
    let owned = 0;
    for (const entry of state.entries) {
      const hits = state.hits.get(entry.name) || [];
      if (hits.length) owned += 1;
      annotate(entry, hits);
    }
    updateBar(owned);
  }

  // ------------------------------------------------------------- filter bar

  // persist is false when we are only reflecting the stored mode. Writing it back
  // would fire storage.onChanged, which would call us again.
  function applyFilter(mode, persist = false) {
    state.settings.filterMode = mode;
    document.documentElement.dataset.cbfFilter = mode;
    const bar = document.querySelector('.cbf-bar');
    if (bar) {
      bar.querySelectorAll('[data-mode]').forEach((button) => {
        button.classList.toggle('cbf-on', button.dataset.mode === mode);
      });
    }
    if (persist) send({ type: MSG.SET_SETTINGS, patch: { filterMode: mode }, rebuild: false });
  }

  function updateBar(owned) {
    const status = document.querySelector('.cbf-bar-status');
    if (!status) return;
    const total = state.entries.filter((entry) => entry.filterable).length;
    status.textContent = total ? `${owned} of ${total} already in your cubes` : '';
  }

  function buildBar() {
    const existing = document.querySelector('.cbf-bar');

    // The bar is optional. Hiding it leaves the filter itself alone, which stays
    // reachable from the toolbar popup.
    if (!state.settings.showBar) {
      if (existing) existing.remove();
      return;
    }

    if (existing || !isSearchListing()) return;

    const bar = document.createElement('div');
    bar.className = 'cbf-bar';
    bar.innerHTML =
      '<span class="cbf-bar-name">Cobrafall</span>' +
      '<span class="cbf-bar-modes">' +
      '<button type="button" data-mode="all">All</button>' +
      '<button type="button" data-mode="hide-owned">Hide in cubes</button>' +
      '<button type="button" data-mode="only-owned">Only in cubes</button>' +
      '</span>' +
      '<span class="cbf-bar-status"></span>' +
      '<button type="button" class="cbf-bar-refresh">Refresh cubes</button>';

    bar.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => applyFilter(button.dataset.mode, true));
    });

    const refresh = bar.querySelector('.cbf-bar-refresh');
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.textContent = 'Refreshing…';
      await send({ type: MSG.SYNC, force: true });
      refresh.disabled = false;
      refresh.textContent = 'Refresh cubes';
      state.targets = null;
      await lookup();
    });

    const info = document.querySelector('.search-info');
    const grid = document.querySelector('.card-grid, .text-grid, .checklist-wrapper, table.checklist');
    if (info && info.parentNode) info.parentNode.insertBefore(bar, info.nextSibling);
    else if (grid && grid.parentNode) grid.parentNode.insertBefore(bar, grid);
    else return;

    applyFilter(state.settings.filterMode || 'all');
  }

  // ------------------------------------------------------------- add to cube

  function closeMenu() {
    if (state.menu) {
      state.menu.remove();
      state.menu = null;
      document.removeEventListener('click', onDocumentClick, true);
    }
  }

  // The listener captures, so without this a click on the menu would close it
  // before its own handler ran, and the second click confirming a removal could
  // never be made.
  function onDocumentClick(event) {
    if (state.menu && state.menu.contains(event.target)) return;
    closeMenu();
  }

  function menuSection(text) {
    const node = document.createElement('div');
    node.className = 'cbf-menu-section';
    node.textContent = text;
    return node;
  }

  function menuGroup(title) {
    const group = document.createElement('div');
    group.className = 'cbf-menu-group';
    const heading = document.createElement('div');
    heading.className = 'cbf-menu-title';
    heading.textContent = title;
    group.appendChild(heading);
    return group;
  }

  // Both actions behave the same way from here: disable the row, ask the worker,
  // then either re-badge the card from the hits it returns or explain the refusal.
  function menuItem(label, className, busyLabel, request, entry, done, confirm = false) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = className;
    item.textContent = label;
    let armed = !confirm;

    item.addEventListener('click', async (event) => {
      event.stopPropagation();

      // Taking a card out of a cube is the one thing here that loses work, and
      // this menu sits under the pointer, so ask for the click twice.
      if (!armed) {
        armed = true;
        item.classList.add('cbf-menu-armed');
        item.textContent = 'Click again to remove';
        return;
      }

      item.disabled = true;
      item.textContent = busyLabel;

      const res = await send(request());
      closeMenu();

      if (res && res.ok) {
        toast(done);
        state.hits.set(entry.name, res.hits || []);
        render();
      } else {
        toast((res && res.message) || 'CubeCobra did not accept that change', true);
      }
    });

    return item;
  }

  // Actions on the copy a cube already holds come first: for a card you own,
  // shifting or dropping it is usually the intent, and adding a second copy is
  // the rarer one.
  function ownedSection(entry, hits, targets) {
    const groups = [];

    for (const hit of hits) {
      const cube = targets.find((target) => target.id === hit.cubeId);
      if (!cube) continue;

      const others = cube.boards.filter((board) => board.key !== hit.board);
      const group = menuGroup(`${cube.name} · ${hit.boardLabel}`);
      for (const board of others) {
        group.appendChild(
          menuItem(
            `Move to ${board.label}`,
            'cbf-menu-item cbf-menu-move',
            `Moving to ${board.label}…`,
            () => ({
              type: MSG.MOVE_BOARD,
              cubeId: cube.id,
              cubeName: cube.name,
              fromBoard: hit.board,
              toBoard: board.key,
              printId: entry.printId,
              name: entry.name,
            }),
            entry,
            `Moved ${entry.name} to ${cube.name} · ${board.label}`,
          ),
        );
      }
      group.appendChild(
        menuItem(
          `Remove from ${hit.boardLabel}`,
          'cbf-menu-item cbf-menu-remove',
          'Removing…',
          () => ({
            type: MSG.REMOVE_FROM_BOARD,
            cubeId: cube.id,
            cubeName: cube.name,
            fromBoard: hit.board,
            printId: entry.printId,
            name: entry.name,
          }),
          entry,
          `Removed ${entry.name} from ${cube.name} · ${hit.boardLabel}`,
          true,
        ),
      );

      groups.push(group);
    }

    return groups;
  }

  function addSection(entry, targets) {
    return targets.map((cube) => {
      const group = menuGroup(cube.name);
      for (const board of cube.boards) {
        group.appendChild(
          menuItem(
            board.label,
            'cbf-menu-item',
            `${board.label}…`,
            () => ({
              type: MSG.ADD_TO_CUBE,
              cubeId: cube.id,
              cubeName: cube.name,
              board: board.key,
              printId: entry.printId,
              name: entry.name,
              set: entry.printing.set,
              collectorNumber: entry.printing.collectorNumber,
            }),
            entry,
            `Added ${entry.name} to ${cube.name} · ${board.label}`,
          ),
        );
      }
      return group;
    });
  }

  async function openAddMenu(entry, button) {
    closeMenu();

    if (!state.targets) state.targets = (await send({ type: MSG.GET_ADD_TARGETS })) || [];
    const targets = state.targets;
    const hits = state.hits.get(entry.name) || [];

    const menu = document.createElement('div');
    menu.className = 'cbf-menu';

    if (!targets.length) {
      menu.innerHTML = '<p class="cbf-menu-empty">No cubes enabled. Open Cobrafall options to pick some.</p>';
    } else {
      const owned = ownedSection(entry, hits, targets);
      if (owned.length) {
        menu.appendChild(menuSection('Already in your cubes'));
        for (const group of owned) menu.appendChild(group);
        menu.appendChild(menuSection('Add a copy'));
      }
      for (const group of addSection(entry, targets)) menu.appendChild(group);
    }

    document.body.appendChild(menu);

    const box = button.getBoundingClientRect();
    const top = window.scrollY + box.bottom + 6;
    const left = Math.min(window.scrollX + box.left, window.scrollX + window.innerWidth - menu.offsetWidth - 12);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, left)}px`;

    state.menu = menu;
    // Deferred so the click that opened the menu does not immediately close it.
    setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
  }

  function toast(text, isError = false) {
    const el = document.createElement('div');
    el.className = `cbf-toast${isError ? ' cbf-toast-error' : ''}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('cbf-toast-out'), 3200);
    setTimeout(() => el.remove(), 3600);
  }

  // ------------------------------------------------------------- lifecycle

  async function lookup() {
    const entries = collect();
    const filterable = isSearchListing();
    for (const entry of entries) entry.filterable = filterable;
    state.entries = entries;

    if (!entries.length) return;

    const names = [...new Set(entries.map((entry) => entry.name))];
    const res = await send({ type: MSG.LOOKUP_CARDS, names });
    if (!res) return;

    state.settings = {
      colors: res.colors || {},
      filterMode: res.filterMode || 'all',
      showBar: res.showBar !== false,
      showAddButton: res.showAddButton !== false,
      enabled: res.enabled !== false,
    };

    state.hits = new Map(Object.entries(res.hits || {}));
    buildBar();
    // Applied whether or not the bar is on show, since the popup sets it too.
    applyFilter(state.settings.filterMode);
    render();
  }

  let pending = null;
  function scheduleLookup() {
    clearTimeout(pending);
    pending = setTimeout(lookup, 150);
  }

  // Scryfall serves plain HTML with no Turbo, so the first pass sees everything.
  // The observer covers the deck tray and any late re-render.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && (node.classList.contains('cbf-badge') || node.classList.contains('cbf-add'))) continue;
        if (node.matches && node.matches('.cbf-bar, .cbf-menu, .cbf-toast')) continue;
        if (node.querySelector && node.querySelector('.card-grid-item, .card-profile, .text-grid-item')) {
          return scheduleLookup();
        }
        if (node.matches && node.matches('.card-grid-item, .card-profile, .text-grid-item, tr[data-card-id]')) {
          return scheduleLookup();
        }
      }
    }
  });

  // A sync elsewhere (the popup, an alarm, another tab) rewrites the index.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.index || changes.settings)) scheduleLookup();
  });

  lookup();
  observer.observe(document.body, { childList: true, subtree: true });
})();
