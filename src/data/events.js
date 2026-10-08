export const EVENT_DURATION_MS = 5 * 60 * 1000;

export const events = [1, 2, 3, 4].map(round => ({
  id: `flash-${round}`,
  round,
  document: `data/flashes/flash-${round}.pdf`
}));
