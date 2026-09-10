import { MSG } from '../shared/messages.js';

const send = (msg) => chrome.runtime.sendMessage(msg);

const el = {
  load: document.getElementById('load'),
  notice: document.getElementById('notice'),
  cubes: document.getElementById('cubes'),
  save: document.getElementById('save'),
  saveStatus: document.getElementById('save-status'),
  showAddButton: document.getElementById('showAddButton'),
  includeBasics: document.getElementById('includeBasics'),
  ttlMinutes: document.getElementById('ttlMinutes'),
  colorMain: document.getElementById('colorMain'),
  colorOther: document.getElementById('colorOther'),
};

// id -> { id, shortId, name, enabled, tracked }
let rows = new Map();

function notice(text, kind = 'info') {
  el.notice.hidden = !text;
  el.notice.textContent = text || '';
  el.notice.className = `notice ${kind}`;
}

function renderCubes() {
  const list = [...rows.values()];

  el.cubes.replaceChildren(
    ...list.map((cube) => {
      const item = document.createElement('li');

      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = cube.tracked;
      box.addEventListener('change', () => {
        cube.tracked = box.checked;
      });

      const name = document.createElement('span');
      name.className = 'cube-name';
      name.textContent = cube.name;

      label.append(box, name);

      const meta = document.createElement('span');
      meta.className = cube.error ? 'cube-meta error' : 'cube-meta';
      meta.textContent = cube.error || (cube.cardCount ? `${cube.cardCount} cards` : '');

      item.append(label, meta);
      return item;
    }),
  );

  if (!list.length) notice('No cubes loaded yet. Use "Load from CubeCobra".');
}

function renderSettings(settings) {
  el.showAddButton.checked = settings.showAddButton;
  el.includeBasics.checked = settings.includeBasics;
  el.ttlMinutes.value = String(settings.ttlMinutes);
  el.colorMain.value = settings.colors.mainboard;
  el.colorOther.value = settings.colors.other;
}

async function loadState() {
  const state = await send({ type: MSG.GET_STATE });
  renderSettings(state.settings);
  rows = new Map(
    state.cubes.map((cube) => [
      cube.id,
      { ...cube, tracked: true, enabled: cube.enabled !== false },
    ]),
  );
  renderCubes();
  return state;
}

el.load.addEventListener('click', async () => {
  el.load.disabled = true;
  notice('Asking CubeCobra…');
  const res = await send({ type: MSG.LIST_MY_CUBES });
  el.load.disabled = false;

  if (!res || !res.ok) {
    if (res && res.needsLogin) {
      notice('Log in to CubeCobra first, then load again.', 'warn');
      el.notice.append(' ');
      const link = document.createElement('a');
      link.href = 'https://cubecobra.com/user/login';
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Open CubeCobra login';
      el.notice.append(link);
    } else {
      notice((res && res.message) || 'Could not reach CubeCobra.', 'warn');
    }
    return;
  }

  for (const cube of res.cubes) {
    const existing = rows.get(cube.id);
    rows.set(cube.id, {
      ...cube,
      cardCount: existing ? existing.cardCount : 0,
      error: existing ? existing.error : null,
      enabled: existing ? existing.enabled : true,
      tracked: existing ? existing.tracked : false,
    });
  }

  notice(`${res.cubes.length} cubes found. Tick the ones to track, then save.`);
  renderCubes();
});

el.save.addEventListener('click', async () => {
  el.save.disabled = true;
  el.saveStatus.textContent = 'Syncing…';

  const tracked = [...rows.values()]
    .filter((cube) => cube.tracked)
    .map((cube) => ({ id: cube.id, shortId: cube.shortId || '', name: cube.name, enabled: cube.enabled }));

  const state = await send({ type: MSG.SET_TRACKED_CUBES, cubes: tracked });
  el.save.disabled = false;

  const failed = state.cubes.filter((cube) => cube.error);
  el.saveStatus.textContent = failed.length
    ? `Saved. ${failed.length} cube(s) could not be read.`
    : `Saved. ${state.cubes.length} cube(s) tracked.`;

  await loadState();
});

for (const [id, key] of [
  ['showAddButton', 'showAddButton'],
  ['includeBasics', 'includeBasics'],
]) {
  el[id].addEventListener('change', () => send({ type: MSG.SET_SETTINGS, patch: { [key]: el[id].checked } }));
}

el.ttlMinutes.addEventListener('change', () =>
  send({ type: MSG.SET_SETTINGS, patch: { ttlMinutes: Number(el.ttlMinutes.value) }, rebuild: false }),
);

for (const input of [el.colorMain, el.colorOther]) {
  input.addEventListener('change', () =>
    send({
      type: MSG.SET_SETTINGS,
      patch: { colors: { mainboard: el.colorMain.value, other: el.colorOther.value } },
      rebuild: false,
    }),
  );
}

await loadState();
