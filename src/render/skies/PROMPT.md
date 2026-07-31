# Caldera panorama — generation spec

Target: the loadout screen backdrop (`biomes.js` → `caldera`), used as **both** the
visible sky and the image-based lighting.

## Model

Use a **panorama/skybox** model, not a general text-to-image one. On Replicate,
search the library for `panorama` or `skybox`. A plain FLUX/SDXL render will not
wrap at 360° and the join will show as a hard line in the sky *and* as a bright
streak in every reflection on the pens.

## Prompt

```
360 degree equirectangular panorama, seamless HDRI environment map of a volcanic
caldera at dusk. Vast dark basalt landscape with rivers of glowing orange magma
cracking through cooled black rock. Jagged volcanic ridges on the horizon in
silhouette. Heavy ash haze. Deep crimson and near-black sky overhead, hot orange
glow banding along the horizon, drifting embers. Cinematic, photoreal, high
dynamic range, dramatic natural lighting, no text, no watermark, no people,
no visible sun disc other than the hot glow described.
```

Negative / avoid: `text, watermark, logo, people, buildings, cartoon, tiling
artifacts, fisheye, distorted horizon`.

## Hard requirements

| Spec | Value | Why |
|---|---|---|
| Aspect | **exactly 2:1** (4096×2048 ideal) | anything else distorts on the sphere |
| Horizon | on the **vertical centre line** | it maps to eye level in-game |
| Format | JPG (~300–600 KB) or HDR/EXR | HDR gives far better lighting if available |

## Sun placement — this one actually matters

The biome's `sunAz` / `sunEl` drive the shadow direction of every pen. They must
agree with the brightest area of the panorama or the shadows fall the wrong way.

Caldera is currently `sunAz: 0.62, sunEl: 0.26`, which corresponds to:

- **62% across the image** from the left edge
- **37% down from the top** (i.e. 23° above the horizon)

So put the hot spot / brightest glow there. If the generated image ends up bright
somewhere else, that is fine — tell me where and I will move `sunAz` / `sunEl` to
match rather than regenerating.

## Wiring it up

Drop the file in this folder, then in `src/render/biomes.js` under `caldera`:

```js
sky: {
  image: new URL('./skies/caldera.jpg', import.meta.url).href,
  seamBlend: 0.04,
  // keep every existing field — they remain the fallback and still drive the
  // sun direction, fog and colour grade
  ...
}
```

A missing or unreadable file falls back to the procedural sky, so this cannot
break the build.
