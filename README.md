# PEN FIGHT — Ledge Rules

The last-bench classic, played on a rock plateau above a two-hundred-metre drop.
Flick your pen, knock the rival's pen off the ledge, best of three. Man vs computer.

**Play: https://shivam230.github.io/pen-fight-arena/**

Web, mobile-first, **zero downloaded assets** — every arena, texture, sprite and
sound effect is generated in the browser. ~168 KB gzipped, plus 65 KB of self-hosted type (Rajdhani for UI, Anton for the
wordmark).

```bash
npm install
npm run dev      # http://127.0.0.1:5180
npm run build    # -> dist/
```

## How it plays

Pick a pen on the loadout screen. The arena behind it is live — always the lava
plateau, lit for staging — and the pen turning in front of you is the actual 3D
model you will fight with. Swipe the carousel; the centred pen is the equipped one.

Drag back anywhere on screen and let go. The pen flies opposite your drag, and a
dotted trail shows exactly where it will end up before you commit.

That trail is not an approximation. It is the same rigid-body solver, running from
the same snapshot, that will resolve the shot — so the game is a test of judgement,
not of luck. It turns **green** when the shot knocks the rival off and **red** when
it carries your own pen over the lip.

### Rules

| Rule | Why |
|---|---|
| Pen fully off the ledge = out | The folk rule. Half-hanging still counts as in. |
| Neither side can be knocked out on their **own opening flick** | The traditional "no win off the break", applied to both players — covering only the opener hands a structural advantage to whoever goes second. |
| Both pens off on the same turn = dead heat, round replayed | Traditional tie-break. |
| Best of three; the opener alternates each round | Splits first-mover advantage. |
| **Overcharge** — power past the 75% mark | Genuinely hits harder *and* genuinely risks your own pen. Physics, not a dice roll. |
| **The ledge crumbles** after 8 turns without contact | Two pens can never circle each other forever. |
| **Clean knock** — you win without ever endangering your own pen | Rewards the positional shot over the panic swing, and triggers the replay. |

### The pens

Nine pens off a real Indian school desk — Reynolds 045, Cello Butterflow, Cello
Gripper, Reynolds Trimax, Linc Pentonic, Nataraj 621, Flair Woody, DOMS Inxify and
Rorito Fiberpoint. Each is modelled from its published product details and its
stats *are* its physical properties:

- **mass** — heavier pens start slower but win momentum trades
- **glide** — friction against the rock; the transparent Gripper skates forever, the
  rubber-bodied Trimax stops dead
- **bounce** — how much energy it dumps into whatever it hits
- **length** — reach, and how big a target you are

Montex Hi-Tecpoint, Add Gel and Camlin's ballpoint line were deliberately left out:
their specs could not be sourced without inventing them. Published dimensions are
sparse for this category, so weights and lengths are flagged as estimates in the
loadout screen.

### The replay

A clean knock you land cuts to a cinematic assembled from the recorded turn: a wide
establishing pan, a hard cut to a slow-motion POV riding a few centimetres behind
your barrel, the impact, then a swing outboard to watch the rival's pen go over the
lip. The surface throws the right spray while your pen slides — amber sparks off
basalt, water off wet concrete, crystals off glacier ice, grit off granite.

### The arenas

Five biomes, a fresh procedurally-generated plateau every match. The surface you
fight on is a mechanic — glacier ice has half the friction of dry granite:

Dhauladhar Ledge · Basalt Caldera · Monsoon Terrace · Kaveri Glade · Serac Shelf

## How it's built

```
src/
  game/
    physics.js   2D rigid-body solver — capsules sliding on a plane
    tuning.js    the numbers all three shooters must agree on
    pens.js      the roster
    ai.js        opponent: forward-searches the real solver
    replay.js    turn recorder + the clean-knock shot list
    match.js     rules, turn flow, input
  render/
    stage.js     renderer, light rig, camera, adaptive quality
    arena.js     procedural plateau, cliff, mountains, hazards
    biomes.js    five looks
    sky.js       equirect sky painted once, used as background AND IBL
    post.js      one composite pass: bloom + CA + vignette + grain + ACES
    penMesh.js   pen geometry and materials
    fx.js        weather, impact debris, shockwaves
    noise.js     seeded simplex + fBm
  audio/sfx.js   every sound, synthesized
  ui/            DOM shell
```

**Physics is 2D.** A pen lying on a table is, seen from above, a capsule. Solving in
2D instead of full 3D keeps the whole sim at microseconds a frame while still giving
spin transfer, glancing deflections and pens that pivot when hit off-centre. Surface
drag is sampled at five points along the barrel, which is what makes a spinning pen
bleed spin and a pen shoved sideways stop faster than one shot along its own axis.

**The AI does not cheat.** It clones the world, runs the real solver forward over
candidate flicks, scores where everything ends up, and picks from the best of them.
Search is sliced across frames so it never drops one. Its handicap is search breadth
and execution error, never the physics. There is one tuned skill level, measured at
6–4 in a competent player's favour — winnable, never a walkover.

**Rendering targets a mid-range phone.** Tone mapping is off on the renderer; the
scene draws into a linear HDR target and ACES is applied exactly once by the
composite pass. One shadow-casting directional light with its frustum fitted to the
actual plateau. DPR clamped, with a governor that walks quality down if measured
frame time slips. `transmission` (the genuinely expensive material) is used only on
transparent barrels and only on the top tier.

## Notes for anyone extending it

- **Polar grids lie.** The plateau is a polar mesh, so it samples ~26 times radially
  and 120 times around. Any surface noise above ~15 cycles/m aliases into a
  pinwheel moiré, and `computeVertexNormals` on the degenerate centre fan produces
  radial shading petals. Normals are derived analytically from the height field
  instead, and frequencies are capped.
- **Point sprites take world-space sizes.** `aSize` is metres, projected by
  `uScale = viewportHeight / (2·tan(fov/2))`. Feeding it pixel values gives rain
  streaks a kilometre tall.
- **Colour lift is applied in linear space**, where 0.03 is a heavy wash, not a nudge.
- **`Match` owns scene objects but not the scene.** Call `dispose()` before building
  another one.
- **`#title { display: grid }` is an ID selector** and beats a class-level
  `[hidden] { display: none }`. The hide rules have to be ID-scoped or the loadout
  screen sits permanently on top of the game.
- **A grid column defaults to `auto`, i.e. max-content.** The horizontally
  scrolling pen rail will stretch the whole screen to its scroll width unless the
  column is `minmax(0, 1fr)`.
- **`scrollIntoView()` scrolls every scrollable ancestor**, including the document.
  Set `scrollLeft` on the rail directly instead.
- **`clip-path` discards `box-shadow`.** A chamfered button's outer glow has to be
  a `drop-shadow()` filter, which does follow the clipped shape.
- **Carousel cards are absolutely positioned**, not a flex row: that is what lets
  the strip wrap around (so the first pen still has neighbours either side) and
  lets a long model name overhang a narrow card.
