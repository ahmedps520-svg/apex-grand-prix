/** Menu icons: simple 24×24 stroke drawings, coloured by CSS (`currentColor`). */

export type IconName =
  | 'race'
  | 'trophy'
  | 'stopwatch'
  | 'drift'
  | 'road'
  | 'city'
  | 'brush'
  | 'gear'
  | 'pad'
  | 'info'
  | 'pulse'
  | 'school';

const PATHS: Record<IconName, string> = {
  // Chequered flag on a pole.
  race: 'M5 21V4 M5 4h13l-2.5 4 2.5 4H5 M9 4v8 M13 4v8 M5 8h12.5',
  trophy:
    'M8 4h8v5a4 4 0 0 1-8 0z M8 6H5a3 3 0 0 0 3 4 M16 6h3a3 3 0 0 1-3 4 M12 13v4 M8 21h8 M9 17h6',
  stopwatch: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 13V9 M10 2h4 M12 5V2 M18.5 6.5l1.5-1.5',
  drift: 'M3 16c4 0 6-9 10-9s4 6 8 6 M6 20l1-2 M11 20l1-2 M16 20l1-2',
  road: 'M8 21l2-18 M16 21l-2-18 M12 4v2 M12 10v3 M12 17v3',
  // A skyline: three towers of different heights on a road.
  city: 'M3 21h18 M5 21V11h4v10 M11 21V4h5v17 M18 21v-7h3v7 M13 8h1 M13 12h1 M13 16h1 M7 15h.01',
  brush: 'M15 4l5 5-9 9-5-5z M6 13c-2 0-3 2-3 4v3h3c2 0 4-1 4-3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  pad: 'M7 9h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.2 2L14 14h-4l-1.8 2A3 3 0 0 1 3 14v-1a4 4 0 0 1 4-4z M8 11v3 M6.5 12.5h3 M15.5 12h.01 M17.5 13.5h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7.5v.5',
  pulse: 'M3 12h4l2-5 4 10 2-5h6',
  school: 'M3 9l9-5 9 5-9 5z M7 11v5c3 2 7 2 10 0v-5 M21 9v6',
};

export function Icon({ name, size = 28 }: { name: IconName; size?: number }) {
  return (
    <svg
      class="mn-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
