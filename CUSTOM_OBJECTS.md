# Creating Custom OpenRCT2 Stall Objects

A playbook for taking a generated sprite sheet and turning it into a placeable
`.parkobj` ride/stall object. Captures every mistake I made building the
Monad Coffee shop so the next one only takes one try.

This focuses on **stalls** (drink/food/ATM/info kiosks — the 1-tile shops).
Same ideas apply to other ride objects but the sprite count and offsets differ.

---

## 1. The big picture

A stall `.parkobj` is a zip with one `object.json` plus PNG sprites:

```
monad.ride.coffee.parkobj
├── object.json
└── images/
    ├── preview.png   # 112×112, the menu cell thumbnail
    ├── ne.png        # rotation views, ~50-60×60-80 each
    ├── se.png
    ├── sw.png
    └── nw.png
```

Stalls need **7 image entries** in `object.json`: the preview is referenced
3× (legacy: `kMaxRideTypesPerRideEntry = 3`, one tab icon per ride type slot),
then the 4 rotations. The game renders rotation views via
`base_image_id + direction(0..3)` — see `paint/track/shops/Shop.cpp:47`.

Drop the `.parkobj` in `~/Library/Application Support/OpenRCT2/object/`.
OpenRCT2 scans that directory on launch.

---

## 2. Prompting the sprite sheet

The sprite-sheet prompt has two failure modes that ate hours:

**Failure A — colors disappear.** OpenRCT2's JSON image importer uses
`ImportMode::Default` (see `drawing/ImageImporter.cpp:235`), which only matches
**exact** RGB values against the `StandardPalette`. Any color that doesn't
exactly equal a palette entry becomes transparent (palette index 0). Smooth
illustrative artwork → every pixel transparent → empty cells in the build menu.

**Failure B — chroma key collides with content.** Earlier versions used a grey
"transparent" background (~`(227,227,227)`). Same shade as off-white signage.
Bg-keying erased the white pixels in the artwork.

Mitigations baked into the prompt:

1. **Lock the palette** — list ~14 exact hex values (verified to be in
   `StandardPalette`) and tell the generator that off-palette pixels won't
   survive. Generators still drift slightly (Gemini gave `(252, 2, 250)` when
   asked for `#FF00FF`), so quantization is still required, but it's a small
   fix-up rather than recovering from a total miss.
2. **Use a magenta `#FF00FF` chroma key** — saturated, not in the RCT2
   palette, doesn't appear in any naturalistic art. Crop is trivial:
   "everything not magenta is content."
3. **Specify dimetric (cabinet) projection at 2:1** explicitly — the 1-tile
   floor diamond is **64 px wide × 31 px tall**. Pixel-art rules
   (no anti-aliasing, hard 3-tone shading, top-left light) keep the result in
   palette and consistent with native RCT2 art.
4. **Be specific about the logo.** First attempt described Monad's mark as a
   stylized "M" with peaks and a swirl — completely wrong. Always include a
   reference image or explicit shape description.
5. **Size the rotations small** (e.g. 64×80 each). When the prompt asks for
   192-tall rotations, the in-world stall ends up 2.5× the size of every other
   shop and overflows the tile.
6. **Tall stalls (e.g. balloons with a floating bouquet) want 64×88 rotations
   and a higher `clearance` value** in `object.json` — coffee used 64, balloon
   used 80. Otherwise the bouquet gets clipped or causes Z-order issues.
7. **Don't ask for cart drop shadows on the magenta ground.** The shadow is
   drawn as a translucent purple ellipse, which blends with magenta into
   colors like `(136,1,129)` or `(89,35,119)` — these don't pass the strict
   `is_magenta()` check, so flood-fill connects every sprite through single-
   pixel shadow chains and the whole sheet becomes one component. Either omit
   the shadows, OR extend the magenta check (see build pipeline step 1).

Verify candidate hex values against the palette before committing them to the
prompt:

```python
import re
header = open('src/openrct2/drawing/ImageImporter.h').read()
m = re.search(r'StandardPalette\s*=\s*\{\s*\{(.+?)\}\s*\};', header, re.DOTALL)
block = re.sub(r'//[^\n]*', '', m.group(1))
# struct is PaletteBGRA, NOT RGBA — swap order:
rct2 = [(int(r), int(g), int(b))
        for b, g, r, _ in re.findall(r'\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}', block)]
```

The struct order trap is real — `PaletteBGRA` (`drawing/ColourPalette.h:9-15`)
stores `Blue, Green, Red, Alpha` in memory, so the C++ initializer
`{ 111, 27, 0, 255 }` is `B=111, G=27, R=0` (a blue), not RGB `(111, 27, 0)`
(an orange). Get this wrong and every "purple" you ask for comes out pink.

---

## 3. Build pipeline (the script)

The `scripts/build-stall.py`-style script does the following:

1. **Find sprites.** Flood-fill connected non-magenta regions with a tolerance
   (Gemini's magenta varies `(250±5, 0..40, 250±5)`). Filter components below
   ~200 px to ignore stray noise. Largest component → menu preview. Next four
   by area → rotation views. (Generators don't always produce exactly 5
   sprites; flood-fill is the only reliable approach.) **`is_magenta()` must
   also catch magenta-tinged shadow pixels** when the art has cart shadows on
   the chroma-key floor — otherwise sprites merge across shadows. Extra rule:
   pixels with `g < 50 and r > 80 and b > 80 and abs(r - b) < 50` are also bg.
2. **Order the rotations.** Sort the 4 rotation bboxes by `(top, left)` for a
   stable assignment, then expose a `ROTATION_OFFSET` (0..3) constant that
   cyclically shifts the assignment. If the kiosk faces wrong in-game, bump
   the offset by 1, rebuild, retest.
3. **Resize for in-world placement.** Constrain by **width**, not height —
   stalls must fit a 1-tile footprint. `ROTATION_MAX_W = 56` keeps the
   building inside the ~64 px tile. Heights end up around 60-80, matching
   native RCT2 stalls. Bigger than this and the kiosk overhangs the tile.
4. **Build the menu preview** at 112×112 (matches the build-menu cell, see
   `windows/NewRide.cpp:499`). Resize the kiosk crop to fit, paste centered
   into a transparent 112 canvas. The other native stalls have a full
   path-and-peeps mini-scene baked in here — we just give the kiosk on
   transparent and accept the slightly-different look.
5. **Preserve narrow whites through downscale.** Heavy LANCZOS downscale
   blends white signs into surrounding purple, which then quantize to grey or
   purple. Build a binary "whiteness mask" of the *source*, downscale the
   mask, and force any output pixel where the mask was >~30% back to white.
   Without this, the awning sign and cup highlights vanish.
6. **Quantize to RCT2 palette.** Use `PIL.Image.quantize(palette=pal_img,
   dither=Image.Dither.NONE)` with the parsed StandardPalette. Index 0 is
   reserved for transparent — any opaque pixel that lands at index 0 must be
   bumped to index 1 (otherwise the renderer treats it as transparent and you
   get holes in the building).
7. **Save as P-mode PNG.** Set `"palette": "keep"` on each image entry in
   `object.json`. That tells OpenRCT2 to read the PNG as already-paletted and
   skip the lossy exact-RGB-match path entirely.
8. **Compute offsets.** For an `H`-tall in-world rotation:
   - `x_offset = -W / 2` (centred horizontally on the tile)
   - `y_offset = -(H - 16)`. The tile floor diamond is **always 31 px tall**
     regardless of sprite height, so `diamond_half = 16` is constant. (An
     earlier formula `diamond_half ≈ H * 31/128 / 2` was wrong — it shrunk
     the diamond proportionally with the sprite, which doesn't match RCT2's
     fixed-size tile diamond.)
   - **Add manual `X_NUDGE` / `Y_NUDGE` constants** to the script for
     per-shop fine-tuning. The above formula gets close but each design needs
     a few pixels of adjustment. If the placed shop appears upper-right of
     the highlighted tile, use `Y_NUDGE > 0` (sprite moves down) and
     `X_NUDGE < 0` (sprite moves left). Start with `(±3, ±6)`.
   - Without these, the building floats above the tile or sinks into it.

   For the **preview** image, use `(0, 0)`. The Object Selection window draws
   into a clipped DPI starting at (0, 0) — negative offsets put the icon
   outside the visible region. The new-ride build menu uses
   `GfxDrawSpriteRawMasked`, which **uses the mask sprite's offsets, not the
   colour image's** (`Drawing.Sprite.cpp:983`), so colour-image offsets there
   are ignored anyway.
9. **Write the index entry.** `object.json` for a drink stall:

   ```json
   {
     "id": "monad.ride.coffee",
     "objectType": "ride",
     "properties": {
       "type": "drink_stall",
       "category": "stall",
       "clearance": 64,
       "sells": "coffee",
       "disablePainting": true,
       "carsPerFlatRide": 1,
       "carColours": [[["black", "black", "black"]]]
     },
     "images": [
       {"path": "images/preview.png", "x": 0, "y": 0, "palette": "keep"},
       {"path": "images/preview.png", "x": 0, "y": 0, "palette": "keep"},
       {"path": "images/preview.png", "x": 0, "y": 0, "palette": "keep"},
       {"path": "images/ne.png", "x": -28, "y": -55, "palette": "keep"},
       {"path": "images/se.png", "x": -28, "y": -52, "palette": "keep"},
       {"path": "images/sw.png", "x": -28, "y": -47, "palette": "keep"},
       {"path": "images/nw.png", "x": -28, "y": -49, "palette": "keep"}
     ],
     "strings": { "name": {"en-GB": "Monad Coffee"}, ... }
   }
   ```

   `sells` accepts the keys mapped in `ShopHandlers.cpp:328+`. Other ride
   types: `food_stall`, `drink_stall`, `cash_machine`, `first_aid`,
   `information_kiosk`, `toilets`, `shop`. **Use `shop` (not `drink_stall`)**
   for things that aren't food/drinks — the original RCT2 balloon, hat,
   t-shirt, and umbrella stalls are all `type: "shop"` with their respective
   `sells` value (`balloon`, `hat`, `tshirt`, `umbrella`). Cross-reference
   `build/object/rct2/ride/rct2.ride.<x>.json` for the right combo before
   inventing one.
10. **Zip into a `.parkobj`.** Plain zip. Drop into the user object directory.
11. **Delete `objects.idx`** (`~/Library/Application Support/OpenRCT2/objects.idx`)
    so the game rescans on next launch.

---

## 4. Iterating without losing your mind

Once the parkobj is built, the next launch shows new sprites — but only if
the game actually restarts. Things that bit me:

- **The game caches loaded objects in memory.** Editing `.parkobj` on disk
  while the game is running has no effect. Cmd+Q, verify with
  `ps -ax | grep openrct`, relaunch.
- **`kill <pid>` (SIGTERM) is sometimes ignored** by the SDL event loop. Use
  `kill -9` if Cmd+Q doesn't work.
- **Saved parks store their own object list.** A new shop dropped into the
  user dir won't appear in an old save's build menu unless you either start a
  fresh park, or open Object Selection (scenario editor / cheats menu) and
  tick the new object on.
- **Use `rctctl shops catalog | grep -i <name>`** to confirm the object is
  loaded by the running headless game without needing to navigate the UI.

Common visual symptoms and fixes:

| Symptom | Cause | Fix |
|---|---|---|
| Empty/red preview cell | Sprite size = 32×32, way smaller than the 112×112 cell | Build a 112×112 preview image |
| Tiny dot in upper-left of preview cell | Preview offsets are negative; sprite drawn outside the clipped DPI | Set preview `x: 0, y: 0` |
| Whole cell solid color, no kiosk | Image colors all became transparent (no exact palette match) | Quantize PNG to RCT2 palette, use `"palette": "keep"` |
| White areas show as transparent / grass shows through | White pixels lost during downscale, quantized to wrong indices | Whiteness-mask preservation step |
| Whites disappear during bg removal | Bg-keying tolerance too loose; (251,251,249) treated as bg grey | Strict tolerance (≤8) for per-pixel keying, looser only for finding sprite gaps |
| Pink instead of purple | Parsed palette as RGB but the C++ struct is BGRA | Read entries as `(B, G, R)`, emit `(R, G, B)` |
| Building 2-3× larger than other stalls | Sprite resized to 112-192 tall instead of native ~60-80 | Constrain by max width (~56), not height |
| Wrong rotation (back showing for path-facing tile) | Generator's "rotations" don't map 1:1 to RCT2 directions | Cycle `ROTATION_OFFSET` 0..3 until it lands |
| New parkobj content not appearing | Game still running with old in-memory copy | Fully quit and relaunch; `rm objects.idx` first |
| Whole sheet found as one big sprite (flood-fill returns <5 components) | Cart shadows on the magenta ground are magenta-tinged purple — not pure magenta — and bridge sprites | Extend `is_magenta()` to catch shadow blends: `g < 50 and r > 80 and b > 80 and abs(r - b) < 50` |
| Placed shop appears upper-right of the highlighted tile | Default offset formula isn't perfect for every sprite design — and the old `diamond_half ∝ H` formula was just wrong | Use fixed `diamond_half = 16`; add `X_NUDGE`/`Y_NUDGE` constants and iterate (`Y_NUDGE > 0` shifts down; `X_NUDGE < 0` shifts left) |

---

## 5. Quick reference: directory layout

- **User object dir** (where the parkobj lives, scanned on launch):
  `~/Library/Application Support/OpenRCT2/object/`
- **Object index** (delete to force rescan):
  `~/Library/Application Support/OpenRCT2/objects.idx`
- **Built-in objects** (read-only, shipped with the game):
  `build/OpenRCT2.app/Contents/Resources/object/`
- **RCT2 palette source** (parse for quantization):
  `src/openrct2/drawing/ImageImporter.h` — `StandardPalette` block
- **Palette struct** (BGRA, not RGBA):
  `src/openrct2/drawing/ColourPalette.h` — `PaletteBGRA`
- **Stall paint logic** (how rotations map to direction):
  `src/openrct2/paint/track/shops/Shop.cpp`
- **Build-menu preview rendering**:
  `src/openrct2-ui/windows/NewRide.cpp:506` (uses
  `GfxDrawSpriteRawMasked` with `SPR_NEW_RIDE_MASK`)
- **Object Selection preview rendering**:
  `src/openrct2-ui/windows/EditorObjectSelection.cpp:1118` (calls
  `RideObject::DrawPreview` which draws at `(0, 0)` of a clipped DPI)

---

## 6. Skeleton: what the build script actually does

```
parse RCT2 palette from ImageImporter.h (BGR → RGB swap!)
load sprite sheet
find magenta-bg connected components (flood-fill)
  └ is_magenta() catches both pure #FF00FF AND magenta-tinged shadows
    (g < 50 and r > 80 and b > 80 and abs(r-b) < 50)
biggest = preview, next 4 by area = rotations
sort rotations by (top, left); apply ROTATION_OFFSET cyclic shift
crop each component, key out magenta pixels to alpha=0
build whiteness mask of each rotation crop, downscale, force whites
resize rotations to fit (MAX_W × MAX_H) box
build 112×112 preview canvas, paste resized kiosk centered
quantize each image to RCT2 palette, save as P-mode PNG
write object.json:
  - preview offsets (0, 0); 3 entries
  - rotation offsets (-W/2 + X_NUDGE, -(H - 16) + Y_NUDGE); 4 entries
  - "palette": "keep" on every entry
zip into .parkobj
delete objects.idx
```

The Monad Coffee build script (`/tmp/build_monad_coffee.py` in the original
session) is the worked example.
