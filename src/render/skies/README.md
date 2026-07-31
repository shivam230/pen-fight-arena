# Panorama skies (optional)

Drop a **2:1 equirectangular** panorama here and point a biome at it:

```js
// src/render/biomes.js
sky: {
  image: new URL('./skies/caldera.jpg', import.meta.url).href,
  seamBlend: 0.04,   // 0 disables; 0.04 = blend the outer 4% into the wrap
  // the procedural fields below are still used as the fallback and for the
  // sun direction, fog and grade, so keep them
  sunAz: 0.62, sunEl: 0.26, ...
}
```

The image becomes **both** the visible sky and the image-based lighting, so the
pens are lit by it and reflect it rather than sitting in front of it.

Requirements:
- **2:1 aspect** (e.g. 4096×2048). Anything else will distort.
- Horizon on the centre line.
- `sunAz` / `sunEl` in the biome must still point at the bright spot in the
  image, or the shadows will fall the wrong way. `sunAz` is measured in turns
  where 0.5 is the centre of the image; `sunEl` is 0 at the horizon, 1 at zenith.

If the panorama isn't perfectly seamless, `seamBlend` cross-fades the two edges.
Without it the wrap shows up as a hard vertical line in the sky *and* as a bright
streak in every reflection, because the same texture drives the lighting.

A missing or unreadable file falls back to the procedural sky rather than failing
the match.
