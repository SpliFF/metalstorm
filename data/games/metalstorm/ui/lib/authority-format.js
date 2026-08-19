// ui/lib/authority-format.js — how an authority quantity is written for a
// player to read (PLAN-endtoend.md D49). Pure logic, no DOM.
//
// Authority is genuinely fractional in the sim: reward normalisation scales a
// systemic reward by 1/velocity clamped to [0.5, 2.0]
// (game_authority.lua GG.Authority.NormaliseReward), stipends and overflow
// decay compound, and bounty stakes split. So the number a widget reads is a
// real fraction — and it also crossed the wire as a float32 rulesParam, which
// is where the 18 significant figures come from: an honest 114.55 arrives in
// the mirror as 114.55000305175781.
//
// Printing the mirror verbatim is what put `YOU 202.5500030517578` /
// `TEAM 614.5499877929688` on the authority bar and
// `+114.55000305175781 authority (objective_control)` in its toast. E5 asks
// for an economy that is "visible and honest"; float32 debris is neither.
//
// ONE DECIMAL, trailing `.0` stripped. Two properties decide that over a plain
// Math.round():
//   - the float32 noise starts at the 7th significant figure, far below what
//     we print, so it cannot survive the format at any realistic pool size;
//   - a fractional amount never reads as *nothing*. A 0.5 authority award
//     rounded to `0` would be a display that says the sim paid you nothing
//     when it paid you something — the same class of defect as the raw float,
//     in the other direction.
// Every authority-valued surface routes through here so two panels can never
// disagree about what the same number is (the objectives panel's outcome rows
// already rounded while its active rows did not — same reward, two spellings).

/** Decimal places kept. See the header for why it is not 0. */
const DECIMALS = 1;

/**
 * Format an authority amount for display.
 *
 * Non-numeric / missing / non-finite input formats as `'0'` rather than
 * `NaN`/`undefined` leaking into the DOM — every caller here is reading an
 * optional rulesParam mirror where "not published yet" and "zero" are the
 * same thing to a player (matching the widgets' existing `?? 0` fallbacks).
 *
 * @param {unknown} value raw amount (typically a float32 rulesParam read)
 * @returns {string} e.g. `202.5500030517578` -> `'202.6'`, `620` -> `'620'`
 */
export function formatAuthority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const rounded = Number(n.toFixed(DECIMALS));
  // Collapses -0 (and a negative amount too small to print) to '0': a player
  // has no use for a signed zero.
  if (rounded === 0) return '0';
  return String(rounded);
}
