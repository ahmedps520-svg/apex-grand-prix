import type { Skill, SkillEvent } from '../app/Skill';
import type { LadderStanding } from '../content/ladder';
import { el, setText } from './dom';

/** Arcade: the skill score, the chain's multiplier, and pop-ups for each scored event. */
export class SkillHud {
  readonly root = el('div', 'skill');
  private readonly label = el('div', 'skill-label', 'SKILL');
  private readonly score = el('div', 'skill-score', '0');
  private readonly combo = el('div', 'skill-combo');
  private readonly pops = el('div', 'skill-pops');
  private readonly level = el('div', 'skill-level');
  private readonly levelFill = el('span');
  private shown = '';
  /** Drift trial: the drifts' points are the score shown. */
  private driftOnly = false;
  private levelShown = '';

  constructor(parent: HTMLElement) {
    const bar = el('div', 'skill-level-bar');
    bar.appendChild(this.levelFill);
    this.root.append(this.label, this.score, this.combo, this.level, bar, this.pops);
    this.root.hidden = true;
    this.combo.hidden = true;
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  reset(): void {
    this.pops.replaceChildren();
    this.shown = '';
    setText(this.score, '0');
    this.combo.hidden = true;
  }

  /** The festival's ladder: the level, its title and the points to the next. */
  setLadder(standing: LadderStanding): void {
    const text =
      standing.toNext === null
        ? `LV ${standing.level} · ${standing.title.toUpperCase()}`
        : `LV ${standing.level} · ${standing.title.toUpperCase()} · ${standing.toNext.toLocaleString('en-US')} TO GO`;
    if (text === this.levelShown) return;
    this.levelShown = text;
    setText(this.level, text);
    this.levelFill.style.width = `${Math.round(standing.share * 100)}%`;
  }

  /** Shows the drifts' points alone (a drift trial), or the whole score. */
  setDriftOnly(on: boolean): void {
    this.driftOnly = on;
    setText(this.label, on ? 'DRIFT' : 'SKILL');
    this.shown = '';
  }

  update(skill: Skill): void {
    for (const event of skill.take()) this.pop(event);
    const value = this.driftOnly ? skill.driftScore : skill.score;
    const key = `${value},${skill.combo}`;
    if (key === this.shown) return;
    this.shown = key;
    setText(this.score, value.toLocaleString('en-US'));
    this.combo.hidden = skill.combo < 2;
    setText(
      this.combo,
      `×${skill.multiplier.toFixed(2).replace(/\.?0+$/, '')} · ${skill.combo} chain`,
    );
  }

  private pop(event: SkillEvent): void {
    const text =
      event.kind === 'crash'
        ? 'CRASH · chain lost'
        : `+${event.points.toLocaleString('en-US')} ${event.label}`;
    const node = el('div', `skill-pop ${event.kind}`, text);
    this.pops.appendChild(node);
    setTimeout(() => node.remove(), 1800);
  }
}
