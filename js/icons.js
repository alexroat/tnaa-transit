// Icone disegnate per il progetto: stessi tracciati nel pannello e sulla mappa.
const PATHS = {
  bus: 'M5 3h14a3 3 0 0 1 3 3v11a2 2 0 0 1-2 2h-1v2h-3v-2H8v2H5v-2H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3zM5 6v6h14V6zM6.500 14a1.500 1.500 0 1 0 0 3a1.500 1.500 0 0 0 0-3zM17.500 14a1.500 1.500 0 1 0 0 3a1.500 1.500 0 0 0 0-3z',
  train: 'M12 1c5 0 9 1 9 5v10a3 3 0 0 1-2 2.800l2 3.200h-3l-2-3H8l-2 3H3l2-3.200A3 3 0 0 1 3 16V6c0-4 4-5 9-5zM6 6v5h5V6zM13 6v5h5V6zM7.500 13.500a1.500 1.500 0 1 0 0 3a1.500 1.500 0 0 0 0-3zM16.500 13.500a1.500 1.500 0 1 0 0 3a1.500 1.500 0 0 0 0-3z',
};

export const iconSvg = (kind) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${PATHS[kind]}"/></svg>`;

/** Immagine per MapLibre, a doppia risoluzione. */
export function mapIcon(kind, color) {
  const size = 48;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(size / 24, size / 24);
  g.fillStyle = color;
  g.fill(new Path2D(PATHS[kind]), 'evenodd');
  return g.getImageData(0, 0, size, size);
}
