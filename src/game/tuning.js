/**
 * tuning.js — the numbers that decide how the game feels.
 *
 * This lives on its own because three places need to agree on exactly what a
 * "power" of 0.7 means: the player's flick, the AI's forward search, and the aim
 * preview. If they ever disagree, the dotted line stops predicting the shot and
 * the whole skill loop breaks.
 */

/** N·s delivered at full power by a reference 5.2 g pen. */
export const BASE_IMPULSE = 0.0149;
export const REFERENCE_MASS = 0.0052;

/**
 * Where the power meter stops being safe. Past this the impulse curve turns
 * superlinear: you really do hit harder, and your own pen really does travel far
 * enough to go over the far lip. The risk is physics, not a dice roll.
 */
export const OVERCHARGE_AT = 0.75;
const OVERCHARGE_GAIN = 0.9;

/**
 * Convert a 0..1 power into an impulse for a specific pen.
 * @param {object} spec catalog entry
 * @param {number} power 0..1
 */
export function impulseFor(spec, power) {
  const mass = spec.massG / 1000;
  // Heavier pens get a little more impulse (you flick a brick harder) but never
  // enough to erase the weight penalty — they still start slower than a light pen.
  const massComp = 0.6 + 0.4 * (mass / REFERENCE_MASS);

  // Sliding distance goes as v², so a meter that maps linearly to impulse maps
  // QUADRATICALLY to distance — 65% falls short of the rival and 85% sails off the
  // far edge, which reads as broken physics rather than a mistake you made. Taking
  // the square root here makes the meter roughly linear in distance travelled,
  // which is what a player actually aims with.
  const curve = Math.sqrt(power)
    * (1 + Math.max(0, power - OVERCHARGE_AT) * OVERCHARGE_GAIN);
  return BASE_IMPULSE * massComp * curve;
}
