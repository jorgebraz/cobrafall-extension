import { MSG } from '../shared/messages.js';

const send = (msg) => chrome.runtime.sendMessage(msg);

const el = {
  enabled: document.getElementById('enabled'),
  cubes: document.getElementById('cubes'),
  empty: document.getElementById('empty'),
  filter: document.getElementById('filter'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  options: document.getElementById('options'),
};

function ago(timestamp) {
  if (!timestamp) return 'never synced';
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.round(hours / 24)}d ago`;
}

function render(state) {
  el.enabled.checked = state.settings.enabled;
  el.filter.value = state.settings.filterMode;
  el.status.textContent = ago(state.lastSync);
  el.empty.hidden = state.cubes.length > 0;

  el.cubes.replaceChildren(
    ...state.cubes.map((cube) => {
      const item = document.createElement('li');

      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = cube.enabled;
      box.addEventListener('change', async () => {
        const next = state.settings.trackedCubes.map((tracked) =>
          tracked.id === cube.id ? { ...tracked, enabled: box.checked } : tracked,
        );
        render(await send({ type: MSG.SET_SETTINGS, patch: { trackedCubes: next } }));
      });

      const name = document.createElement('span');
      name.className = 'cube-name';
      name.textContent = cube.name;

      label.append(box, name);

      const meta = document.createElement('span');
      meta.className = cube.error ? 'cube-meta error' : 'cube-meta';
      meta.textContent = cube.error || `${cube.cardCount} cards`;
      if (cube.error) meta.title = cube.error;

      item.append(label, meta);
      return item;
    }),
  );
}

el.enabled.addEventListener('change', async () => {
  render(await send({ type: MSG.SET_SETTINGS, patch: { enabled: el.enabled.checked } }));
});

el.filter.addEventListener('change', async () => {
  render(await send({ type: MSG.SET_SETTINGS, patch: { filterMode: el.filter.value }, rebuild: false }));
});

el.refresh.addEventListener('click', async () => {
  el.refresh.disabled = true;
  el.status.textContent = 'syncing…';
  const state = await send({ type: MSG.SYNC, force: true });
  el.refresh.disabled = false;
  render(state);
});

const openOptions = (event) => {
  if (event) event.preventDefault();
  chrome.runtime.openOptionsPage();
};

el.options.addEventListener('click', openOptions);
document.getElementById('open-options').addEventListener('click', openOptions);

render(await send({ type: MSG.GET_STATE }));
