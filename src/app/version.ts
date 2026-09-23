/**
 * Which build is running, shown on the loading screen, in the help card and in a corner of the
 * screen, so it's always clear whether an update has arrived. The minor version is the round.
 */

const [semver = '0.0.0', build = 'dev'] = __APP_VERSION__.split('+');

export const VERSION = semver;
export const BUILD = build;
export const BUILD_DATE = __BUILD_DATE__;
export const ROUND = Number(semver.split('.')[1] ?? 0);

/** e.g. "v0.2.0 · Round 2 · build 1a2b3c4 · 2026-09-23" */
export const VERSION_TEXT = `v${VERSION} · Round ${ROUND} · build ${BUILD} · ${BUILD_DATE}`;

const SEEN_KEY = 'apex-gp.lastVersion';

/**
 * Remembers the version for next time and returns the one seen before, if it differs (so the
 * game can say it was updated). Returns null on a first visit or when nothing changed.
 */
export function takeVersionChange(): string | null {
  const current = `${VERSION}+${BUILD}`;
  try {
    const previous = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, current);
    return previous && previous !== current ? previous : null;
  } catch {
    return null;
  }
}
