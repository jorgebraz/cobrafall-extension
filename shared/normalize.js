// Card-name normalization, shared by the index builder and every lookup.
//
// Matching is by name rather than by printing: any printing of a card counts as
// already being in the cube, which is what a cube builder wants. The exact
// printing CubeCobra holds is carried alongside the hit for the tooltip.

const ENTITIES = {
  '&amp;': '&',
  '&#39;': "'",
  '&apos;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

export function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/&(?:amp|#39|apos|quot|lt|gt|nbsp);/g, (m) => ENTITIES[m] || m);
  // Curly quotes to straight, so "Urza's" matches "Urza’s".
  s = s.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
  // Strip diacritics: Lim-Dul, Jotun, Marton Stromgald.
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // Ligatures survive NFKD, so fold them by hand.
  s = s.replace(/\u00e6/gi, 'ae').replace(/\u0153/gi, 'oe').replace(/\u00df/g, 'ss');
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();
  return s;
}

// A card is indexed under its full name and, for double-faced and split cards,
// under its front face alone. Scryfall and CubeCobra agree on the "a // b"
// format, but some Scryfall views show only the front face.
//
// Alchemy rebalances keep their "a-" prefix: those are genuinely other cards.
export function nameKeys(raw) {
  const full = normalizeName(raw);
  if (!full) return [];
  const keys = [full];
  const split = full.indexOf(' // ');
  if (split > 0) keys.push(full.slice(0, split));
  return keys;
}
