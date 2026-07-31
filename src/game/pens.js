/**
 * pens.js — the roster.
 *
 * Nine pens every Indian school desk has seen. Physical specs are drawn from
 * product listings where a number is published and estimated from standard Indian
 * ballpoint dimensions (135–148mm long, 8–11mm barrel, 4–9g) where it is not —
 * `estimated: true` marks the latter. Three commonly-requested pens (Montex
 * Hi-Tecpoint, Add Gel, Camlin's ballpoint line) were left out on purpose: their
 * specs could not be sourced without inventing them.
 *
 * Balance model — every stat is a real physical property, not an arbitrary number,
 * so the fiction and the mechanics never disagree:
 *   massG     heavier ⇒ moves slower for the same flick, but wins momentum trades
 *             and resists being shoved. Lighter ⇒ long range, gets launched.
 *   glide     coefficient of friction against the arena. Low ⇒ skates forever
 *             (smooth plastic). High ⇒ stops dead (rubber grip biting the stone).
 *   bounce    restitution. High ⇒ more energy dumped into whatever you hit.
 *   lengthMm  reach: a longer barrel is a bigger target and a wider hitting face.
 */

/** Shared plastic-family surface presets used by the mesh builder. */
export const FINISH = {
  CLEAR: 'clear',       // fully transparent polystyrene — real transmission
  FROSTED: 'frosted',   // translucent, scattered
  GLOSS: 'gloss',       // opaque high-shine injection plastic
  MATTE: 'matte',       // soft-touch matte
  METALLIC: 'metallic', // metallic-pigment barrel
  RUBBER: 'rubber',     // grip sleeve
};

export const PENS = [
  {
    id: 'reynolds045',
    name: 'Reynolds 045',
    brand: 'Reynolds',
    tagline: 'The one everybody had.',
    blurb:
      'Fine Carbure. Plain white barrel, no grip, no gimmick. The neutral duelling ' +
      'pen — nothing it does is spectacular and nothing it does is bad.',
    lengthMm: 143, diameterMm: 9, massG: 5.2, estimated: true,
    glide: 0.30, bounce: 0.42,
    profile: 'round',
    body: { finish: FINISH.GLOSS, color: 0xf4f2ec },
    accent: 0x1b53b8,
    grip: null,
    ribs: { from: 0.30, to: 0.52, count: 9 },
    clip: { color: 0x1b53b8, style: 'slim' },
    tip: { color: 0xc9ccd2, metal: true },
    cap: { type: 'cap', color: 0x1b53b8, length: 0.20 },
    print: 'REYNOLDS 045',
  },
  {
    id: 'butterflow',
    name: 'Cello Butterflow',
    brand: 'Cello',
    tagline: 'Heavy metal.',
    blurb:
      'Metallic-finish barrel with an ink window and a click top. The heft is real — ' +
      'it shoves anything lighter clean off the ledge, but it is slow off the flick.',
    lengthMm: 145, diameterMm: 10, massG: 7.2, estimated: true,
    glide: 0.34, bounce: 0.38,
    profile: 'round',
    body: { finish: FINISH.METALLIC, color: 0x2f6fd0 },
    accent: 0x0e2f66,
    grip: { style: 'wave', color: 0x18345f, from: 0.62, to: 0.82 },
    inkWindow: { from: 0.34, to: 0.46 },
    clip: { color: 0x0e2f66, style: 'wide' },
    tip: { color: 0xd6d9de, metal: true },
    cap: { type: 'click', color: 0x0e2f66, length: 0.16 },
    print: 'BUTTERFLOW 0.7',
  },
  {
    id: 'gripper',
    name: 'Cello Gripper',
    brand: 'Cello',
    tagline: 'See-through and slippery.',
    blurb:
      'Fully transparent barrel, cap and clip. Almost no friction against stone — it ' +
      'keeps skating long after everything else has stopped. Brilliant, and terrifying.',
    lengthMm: 140, diameterMm: 9, massG: 5.0, estimated: true,
    glide: 0.24, bounce: 0.50,
    profile: 'round',
    body: { finish: FINISH.CLEAR, color: 0xeaf4ff },
    accent: 0x1450c8,
    grip: { style: 'ribbed', color: 0x1450c8, from: 0.60, to: 0.80, translucent: true },
    clip: { color: 0x2a6bdc, style: 'slim', translucent: true },
    tip: { color: 0xb9bec6, metal: true },
    cap: { type: 'cap', color: 0x2a6bdc, length: 0.22, translucent: true },
    print: 'GRIPPER',
  },
  {
    id: 'trimax',
    name: 'Reynolds Trimax',
    brand: 'Reynolds',
    tagline: 'Three flat sides. Won\'t roll.',
    blurb:
      'A triangular soft-touch body — the whole barrel is the grip. Heaviest pen on ' +
      'the desk and the grippiest. It stops where you put it and refuses to be moved.',
    lengthMm: 145, diameterMm: 11, massG: 8.0, estimated: true,
    glide: 0.44, bounce: 0.30,
    profile: 'triangle',
    body: { finish: FINISH.MATTE, color: 0x18324f },
    accent: 0x39b7e8,
    grip: null,
    clip: { color: 0x39b7e8, style: 'wide' },
    tip: { color: 0xa9aeb6, metal: true },
    cap: { type: 'cap', color: 0x39b7e8, length: 0.20 },
    print: 'TRIMAX 0.5',
  },
  {
    id: 'pentonic',
    name: 'Linc Pentonic',
    brand: 'Linc',
    tagline: 'Matte black, quiet menace.',
    blurb:
      'Charcoal matte barrel with a rubberised band. Heavy enough to hit hard, smooth ' +
      'enough to travel. The all-rounder that most people settle on.',
    lengthMm: 144, diameterMm: 10, massG: 7.0, estimated: true,
    glide: 0.30, bounce: 0.44,
    profile: 'round',
    body: { finish: FINISH.MATTE, color: 0x24262b },
    accent: 0xff5a1f,
    grip: { style: 'smooth', color: 0x14161a, from: 0.60, to: 0.80 },
    clip: { color: 0xff5a1f, style: 'slim' },
    tip: { color: 0xc4c8ce, metal: true },
    cap: { type: 'cap', color: 0x14161a, length: 0.21, accentRing: true },
    print: 'PENTONIC 0.7',
  },
  {
    id: 'nataraj',
    name: 'Nataraj 621',
    brand: 'Nataraj',
    tagline: 'Six flat sides, feather light.',
    blurb:
      'Hexagonal barrel that sits dead flat and never rolls. Light as anything, so it ' +
      'covers the whole plateau on one flick — and leaves it just as fast.',
    lengthMm: 140, diameterMm: 8, massG: 4.2, estimated: true,
    glide: 0.26, bounce: 0.46,
    profile: 'hex',
    body: { finish: FINISH.GLOSS, color: 0xe8442e },
    accent: 0x14181d,
    grip: null,
    ribs: null,
    clip: { color: 0x14181d, style: 'slim' },
    tip: { color: 0xb9bec6, metal: true },
    cap: { type: 'cap', color: 0x14181d, length: 0.19 },
    print: 'NATARAJ',
  },
  {
    id: 'flair',
    name: 'Flair Woody',
    brand: 'Flair',
    tagline: 'Too light to fight with.',
    blurb:
      'Faux-woodgrain barrel, barely four grams. Fastest pen here by a mile and the ' +
      'first one over the edge when anything real connects. High risk, high theatre.',
    lengthMm: 138, diameterMm: 8, massG: 3.9, estimated: true,
    glide: 0.22, bounce: 0.52,
    profile: 'round',
    body: { finish: FINISH.GLOSS, color: 0xa9713c, grain: true },
    accent: 0x3f2513,
    grip: null,
    clip: { color: 0x3f2513, style: 'slim' },
    tip: { color: 0xbcc0c7, metal: true },
    cap: { type: 'cap', color: 0x3f2513, length: 0.18 },
    print: 'FLAIR',
  },
  {
    id: 'doms',
    name: 'DOMS Inxify',
    brand: 'DOMS',
    tagline: 'Dual-tone newcomer.',
    blurb:
      'Half gloss, half matte, textured grip, needle tip. No nostalgia attached yet — ' +
      'it just quietly does everything competently.',
    lengthMm: 142, diameterMm: 9, massG: 6.0, estimated: true,
    glide: 0.29, bounce: 0.40,
    profile: 'round',
    body: { finish: FINISH.GLOSS, color: 0x1fa87a, twoTone: 0x0e1b26 },
    accent: 0xffd23f,
    grip: { style: 'ribbed', color: 0x0e1b26, from: 0.60, to: 0.82 },
    clip: { color: 0xffd23f, style: 'wide' },
    tip: { color: 0xc9ccd2, metal: true, needle: true },
    cap: { type: 'click', color: 0x0e1b26, length: 0.15 },
    print: 'INXIFY 0.7',
  },
  {
    id: 'rorito',
    name: 'Rorito Fiberpoint',
    brand: 'Rorito',
    tagline: 'Fat triangle, rubber skin.',
    blurb:
      'Triangular barrel with a soft grip that bites into stone. Doesn\'t travel far, ' +
      'doesn\'t need to — park it on the centre line and dare the other pen to come.',
    lengthMm: 140, diameterMm: 10, massG: 5.4, estimated: true,
    glide: 0.38, bounce: 0.36,
    profile: 'triangle',
    body: { finish: FINISH.FROSTED, color: 0x8f4fd6 },
    accent: 0xf2e9ff,
    grip: { style: 'ribbed', color: 0x2b1440, from: 0.58, to: 0.80 },
    clip: { color: 0xf2e9ff, style: 'slim' },
    tip: { color: 0xb4b9c1, metal: true, needle: true },
    cap: { type: 'cap', color: 0x2b1440, length: 0.20 },
    print: 'FIBERPOINT',
  },
];

export const PEN_BY_ID = Object.fromEntries(PENS.map((p) => [p.id, p]));

/** 0..1 bars for the loadout screen, normalised across the roster. */
export function penStats(spec) {
  const range = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return {
    // Momentum delivered per unit of flick, i.e. how hard it hits.
    power: range(spec.massG * (1 + spec.bounce), 5.0, 11.0),
    // How far it travels on a given flick: light + slippery goes furthest.
    speed: range(1 / (spec.massG * spec.glide), 0.28, 1.25),
    // Resistance to being shoved off: mass plus grip.
    stability: range(spec.massG * 0.09 + spec.glide, 0.55, 1.20),
    // Barrel reach.
    reach: range(spec.lengthMm, 136, 147),
  };
}
