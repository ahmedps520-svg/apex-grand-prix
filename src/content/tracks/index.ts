import type { TrackDef } from '../../sim/track/Track';
import { DUNMORE } from './dunmore';
import { LAKE_VIRESKA } from './lake-vireska';
import { MERRIFORD_PARK } from './merriford-park';
import { MIRADOR } from './mirador';
import { PORT_AVELINE } from './port-aveline';
import { SOLMARA } from './solmara';
import { SUNHAVEN } from './sunhaven';
import { VELTMOOR } from './veltmoor';

/**
 * Every circuit, in season-calendar order: the short club circuit opens the season (and is the
 * easiest to learn) and the desert round closes it.
 */
export const TRACKS: readonly TrackDef[] = [
  MERRIFORD_PARK,
  PORT_AVELINE,
  LAKE_VIRESKA,
  DUNMORE,
  SOLMARA,
  VELTMOOR,
  SUNHAVEN,
  MIRADOR,
];

export function trackById(id: string): TrackDef | undefined {
  return TRACKS.find((track) => track.id === id);
}
