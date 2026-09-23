/** The AI drivers' names (all fictional): race rivals take them in order, street racers mixed. */
export const AI_NAMES: readonly string[] = [
  'K. Arvidsen',
  'M. Okonkwo',
  'L. Castellane',
  'T. Varga',
  'R. Holloway',
  'S. Moravec',
  'D. Quintero',
  'J. Lindqvist',
  'A. Ferreira',
  'N. Tanabe',
  'E. Brandt',
];

/** A race rival's name by its car index (car 0 is the player). */
export function rivalName(car: number): string {
  return car === 0 ? 'You' : (AI_NAMES[(car - 1) % AI_NAMES.length] ?? `Driver ${car}`);
}

/** A street racer's name by its index in the field. */
export function racerName(index: number): string {
  return AI_NAMES[(index * 5 + 3) % AI_NAMES.length] ?? `Racer ${index + 1}`;
}
