/** Paint colours for the player's car (the AI field uses the rest). */
export const PAINTS: ReadonlyArray<{ name: string; hex: number }> = [
  { name: 'Racing red', hex: 0xa3101f },
  { name: 'Midnight blue', hex: 0x14306b },
  { name: 'Electric blue', hex: 0x1f5fd1 },
  { name: 'Signal yellow', hex: 0xf2b705 },
  { name: 'Racing green', hex: 0x1d5e3a },
  { name: 'Papaya', hex: 0xf07f13 },
  { name: 'Violet', hex: 0x7b2cf5 },
  { name: 'Pearl white', hex: 0xe8e8e8 },
  { name: 'Carbon black', hex: 0x1c1c1c },
  { name: 'Hot pink', hex: 0xd81b60 },
  { name: 'Silver', hex: 0x9e9e9e },
  { name: 'Teal', hex: 0x10a7b8 },
];

/** Points for positions 1–10 in a championship race. */
export const CHAMPIONSHIP_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
