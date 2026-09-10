# Cobrafall

Marks cards on [Scryfall](https://scryfall.com) that are already in your
[CubeCobra](https://cubecobra.com) cubes, filters a search by that, and adds a card to a
cube without leaving the page.

## Install

1. Open `chrome://extensions` and turn on developer mode.
2. Choose "Load unpacked" and pick this directory.
3. Log in to CubeCobra in the same browser.
4. Open the extension's options, click **Load from CubeCobra**, tick the cubes to track,
   and save. Private and unlisted cubes work because the request carries your session.

## What you get on Scryfall

- A colored ring and a badge on every card already in a tracked cube. Green means the
  mainboard, amber means any other board. The badge tooltip names each cube, each board,
  and the printing that cube holds, which is how you spot a printing mismatch.
- A bar above search results to hide cards already in your cubes, or show only those. Turn
  the bar off in the options if you would rather not see it; the filter itself stays
  available from the toolbar popup.
- A `+` button on card hover. For a card already in a cube it offers to move that cube's
  copy between boards first, then to add a fresh copy. For anything else it just adds.

Matching is by card name, so any printing on Scryfall counts as already in the cube. A move
acts on the copy your cube holds, which is usually a different printing from the one on
screen.

All four Scryfall search views work (grid, checklist, text, full) plus single card pages.
The text view has no add button because that view carries no printing id.

## How it stays current

The service worker owns every CubeCobra request and the local cache. A refresh asks
`date_updated` for each tracked cube first and only downloads a cube whose timestamp moved,
so the normal case is one small request per cube. Refreshes happen on browser start, on a
timer you choose in the options, and on demand from the popup or the Scryfall bar.

## Layout

| Path | Role |
| --- | --- |
| `background/service-worker.js` | Message router, sync scheduling, add and move |
| `background/cubecobra.js` | Every CubeCobra endpoint, and the reason they live here |
| `background/index.js` | cubeJSON to local record, and the name index |
| `background/store.js` | `chrome.storage.local` layout and defaults |
| `content/scryfall.js` | Page scanning, badges, filter bar, add menu |
| `shared/normalize.js` | Card-name normalization, used on both sides of a match |

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with Scryfall or Cube Cobra. Magic: The Gathering is a trademark of Wizards
of the Coast. Card data comes from CubeCobra's public API and from the pages you are
already looking at on Scryfall; the extension sends nothing anywhere else.
