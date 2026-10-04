# HEX ATLAS city kit — contract between Blender and the three.js engine

The city is generated from atlas data at runtime. Blender only makes the **kit of parts**. The
engine loads `web/public/kit/kit.glb` once and pulls every part out **by node name**, so names,
origins and dimensions below are a hard contract.

Rebuild: `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python art/kit.py`
(writes `art/kit.blend`, `web/public/kit/kit.glb`, previews in `art/previews/`).

## Global conventions

- **Units**: 1 Blender unit = 1 world unit. A standard building lot is **2.4 × 2.4**.
- **Axes**: model Z-up in Blender, export with +Y up. The **front** of every building / vehicle
  faces Blender **−Y** (becomes three.js **+Z**). Vehicles drive toward −Y (front).
- **Origin**: every part's origin is at the **bottom centre of its footprint** (z = 0 is the ground),
  except where noted. Transforms applied (location/rotation/scale = identity on export).
- **One mesh per node**, node name = object name exactly as listed. Modifiers applied. No cameras,
  lights, empties or collections exported. Objects all sit at the world origin in the export.
- **Look**: low-poly, flat-shaded, chunky with a few tasteful 1-segment bevels on silhouette edges.
  Think "SimCity/Townscaper clay model": clean, readable from 100 m up, no tiny noisy detail.
- **Colour comes from vertex colours only** (no textures). Use a byte colour attribute in the
  face-corner domain, exported as `COLOR_0`. Engine uses a single material with `vertexColors`.
- **Custom attributes** (float, point or face-corner domain, exported via "Attributes"; names must
  start with `_` so the glTF exporter keeps them; GLTFLoader exposes them lower-cased):
  - `_TINT` = 1.0 on surfaces the engine may recolour per instance (roofs, awnings, car bodies,
    truck boxes, accent bands), 0.0 elsewhere. Model those surfaces in a neutral light grey
    (`#D8D4CC`) so a multiply tint reads correctly.
  - `_GLOW` = 1.0 on window glass / lamp heads / head- and tail-lights / beacons (lit at night), 0.0
    elsewhere. On framed windows only the pane carries `_GLOW`; the frame grey around it does not.
  - `_SIREN` (only on `police`): +1.0 on the red (left, +X) half of the light bar, −1.0 on the blue
    (right, −X) half, 0.0 elsewhere. Both halves also carry `_GLOW` = 1. The engine flashes them
    alternately, e.g. `glow *= max(0, sign(_siren) * sin(t * k))`. Other meshes do **not** have the
    attribute at all (three.js then reads it as 0 if a shared shader declares it).
  - GLTFLoader exposes the custom attributes **lower-cased**: `_tint`, `_glow`, `_siren`
    (`geometry.getAttribute('_siren')`). `COLOR_0` is exported as normalised unsigned-short VEC4.
- **Budgets** (triangles): building part ≤ 400, whole small building ≤ 500, tree ≤ 150,
  vehicle ≤ 260, crane part ≤ 350, `cloud` ≤ 200, `rain_cloud` ≤ 220. There will be ~6,000
  buildings, ~40,000 trees and ~40,000 cars. `python3 art/check_glb.py` enforces these.

## Palette (sRGB)

| Use | Hex |
|---|---|
| Walls, warm white | `#F3EFE6` |
| Walls, cream | `#E8E1D2` |
| Walls, light stone | `#D9D2C3` |
| Trim / cornices | `#FBFAF6` |
| Neutral tintable (roofs, awnings) | `#D8D4CC` (+ `_TINT`=1) |
| Dark roof / base plinth | `#8E959E` |
| Window glass | `#9DB7C9` (+ `_GLOW`=1) |
| Window frames / doors | `#5E6873` |
| Wood | `#A98463` |
| Concrete | `#C7C3BB` |
| Metal | `#B5BBC2` |
| Construction yellow | `#F2C230` |
| Hazard black | `#2E3238` |
| Leaf greens | `#5FA845` `#4E9440` `#79B95A` `#3F7F3A` (+ variation `#6AAF4C` `#88C063`) |
| Pine greens | `#3E7B45` `#356B3D` (+ variation `#4A8A4E`) |
| Trunk | `#7A5A3E` |
| Rock | `#A7A49C` |
| Dirt | `#B48A5E` |
| Rooftop plant (AC boxes / fan + louvres) | `#C9CED4` / `#7F8893` |
| Police navy (doors, hood stripe) | `#22304A` |
| Siren red / blue (+ `_GLOW`, `_SIREN` ±1) | `#E5484D` / `#3B82F6` |
| Tail-lights (+ `_GLOW`) | `#C4473F` |
| Cloud top / side / belly | `#FBFCFD` / `#E9ECF0` / `#C7CDD6` |
| Rain cloud top / side / belly | `#A3AAB5` / `#878F9B` / `#636B77` |

Colour means something in this app, so buildings stay neutral. Only construction gear is yellow.

## Buildings

**Stackable** archetypes come in three parts so the engine can build any height without stretching:
`<name>_base` (ground floor, origin at its bottom), `<name>_floor` (**exactly 0.5 tall**, origin at
its bottom, repeated N times), `<name>_roof` (origin at its bottom). The engine stacks them as:
base at 0, floors at `H_base + i*0.5`, roof at `H_base + N*0.5`. **`H_base` is written into the base
object's custom property `h`** (exported as glTF extras) and should be 0.6–1.0. Footprint of all three
parts must match.

| Name | Kind | Footprint | Used for |
|---|---|---|---|
| `landmark` | stackable | 2.0 × 2.0 | domain core: art-deco tower, setbacks, roof = crown + spire |
| `civic` | stackable | 2.3 × 2.0 | storage model / kernel: museum, column portico base, cornice roof |
| `factory` | stackable | 2.3 × 2.1 | commands: big doors base, roof = sawtooth + chimney |
| `shop` | stackable | 2.1 × 2.0 | queries: storefront base with striped awning (alternating `_TINT` / white stripes + scalloped valance), dark fascia sign with `_TINT` lettering, `_TINT` blade sign, planters; flat roof + AC units, vents |
| `library` | stackable | 2.2 × 2.0 | shared views: arched windows, hip roof (`_TINT`) |
| `warehouse` | stackable | 2.4 × 2.0 | adapters: loading-dock doors + dock bumpers base, corrugated floor band, shallow gable roof (`_TINT`) |
| `prefab` | stackable | 1.9 × 1.9 | generated code: stacked shipping-container modules, grey |
| `apartment` | stackable | 2.0 × 2.0 | generic residential block, balconies; roof: stair hut, water tank, AC units, satellite dish |
| `office` | stackable | 2.0 × 2.0 | generic glass office tower, horizontal glass bands; roof: plant room, AC row, mast with red beacon |
| `megatower` | stackable | 2.4 × 2.4 | gravity wells: supertall, distinctive crown + antenna (roof ≈ 3 tall) |
| `hall` | whole | 2.4 × 2.4 | composition root: town hall, portico, clock tower (~4 tall) |
| `tollgate` | whole | 2.4 × 2.4 | SDK port: toll plaza canopy over 3 booths, barrier arms |
| `station` | whole | 2.4 × 2.4 | driving adapter: bus station, long canopy |
| `substation` | whole | 2.2 × 2.2 | runtime internal: transformer yard, fence, insulators |
| `shed` | whole | 1.8 × 1.8 | tool: utility shed + water tank |
| `tent` | whole | 1.8 × 1.8 | tests / proofs: white inspection tent with flag |
| `house` | whole | 1.8 × 1.8 | instance binding / suburb: pitched roof (`_TINT`), chimney |
| `house2` | whole | 1.8 × 1.8 | suburb variant: L-shape, garage |
| `shack` | whole | 1.6 × 1.6 | unmapped/loose: makeshift corrugated shack |

**Window detailing** (all `win_floor` storeys — landmark, civic, factory, shop, apartment floors and the
landmark/apartment bases): the recessed core is frame grey `#5E6873`; each bay has its own inset glass
pane (`_GLOW`), wide panes get a centre mullion and a transom bar, and a projecting trim sill ledge runs
under every window row. Roofs carry small kit: AC condensers, vent stacks, water tanks, turbine vents
(warehouse), a satellite dish (apartment) and beacon masts (office, megatower).

## Nature

`tree_pine`, `tree_pine_tall`, `tree_round`, `tree_round_small`, `tree_birch`, `bush`, `rock`.
Trees ≈ 1.6–3.2 tall, canopy radius ≈ 0.6–1.0, chunky faceted canopies (2–3 stacked blobs or 4–5 pine
tiers, lighter towards the top), no `_TINT`. Greens are baked per facet: sunlit tops lighter, undersides
darker, and ~30 % of facets swapped to a neighbouring green for gentle variation. `bush` has a few
blossoms.

| Name | Size (W × D × H) | Notes |
|---|---|---|
| `cloud` | ~6.0 × 3.0 × 2.2 | chunky cumulus, five faceted puffs, flat belly; origin at the bottom centre of the belly (engine places it in the sky). White → light grey by facet, no `_TINT`/`_GLOW`. 200 tris |
| `rain_cloud` | ~6.6 × 3.2 × 2.05 | heavier, darker grey cumulus, same construction and origin. 200 tris |

## Vehicles (front = −Y, length along Y)

| Name | Size (W × L × H) | Notes |
|---|---|---|
| `car` | 0.55 × 1.0 × 0.42 | sedan, body `_TINT` (cabin pillars too), inset glass panes `_GLOW`-free, headlights + tail-lights `_GLOW`, grille, dark wheels with hub caps |
| `van` | 0.6 × 1.15 × 0.6 | delivery van, body `_TINT` |
| `truck` | 0.7 × 1.7 × 0.85 | cab + box, box `_TINT` |
| `bulldozer` | 0.8 × 1.2 × 0.7 | construction yellow, blade at front |
| `excavator` | 0.8 × 1.4 × 0.8 | yellow, arm raised |
| `inspector` | 0.55 × 1.0 × 0.5 | white car with red/blue light bar (light bar `_GLOW`) |
| `police` | 0.55 × 1.08 × 0.46 | police cruiser, same body/orientation as `car` (front −Y, push bar adds 0.025 at the front): white body, navy doors + hood/trunk stripe, black wheels, roof light bar — red half on the car's **left (+X)**, blue half on its **right (−X)**, both `_GLOW` = 1 and `_SIREN` = +1 / −1. No `_TINT` |

## Construction & infrastructure

| Name | Notes |
|---|---|
| `crane_mast` | tower-crane lattice segment, 0.5 × 0.5 footprint, **exactly 1.0 tall**, yellow |
| `crane_top` | slewing unit: cab, jib along −Y ~6 long, counter-jib +Y ~2 with concrete weights, apex; origin at bottom of the slewing ring (sits on top of mast) |
| `crane_hook` | hook block + short cable stub, origin at top of the cable |
| `scaffold` | open frame, unit cube 1 × 1 × 1 (poles + planks + a couple of diagonals), origin bottom centre; engine scales it to wrap a building |
| `foundation` | 2.4 × 2.4 dug pit: dirt walls, concrete footing slab, rebar stubs, origin at ground level (pit goes below z=0, down to −0.4) |
| `rubble` | demolition rubble pile on 2.4 × 2.4, concrete chunks + bent beams |
| `cone` | traffic cone, ~0.25 tall, orange `#F07A2A` with white band |
| `barrier` | striped road barrier, 1.0 wide |
| `streetlight` | 1.8 tall pole + arm, lamp head `_GLOW` |
| `sign_board` | district sign: two posts + blank board 1.6 wide (text is HTML), dark slate `#2F3A45` board, origin bottom centre |
| `bridge_span` | road deck **8 long along X**, 3.2 wide, with railings, origin at deck-bottom centre |
| `bridge_pier` | concrete pier, 0.8 × 2.6 footprint, 3 tall |
| `fountain` | plaza fountain, 1.6 wide (water surface light blue `#8FD0EA`) |
| `flowerbed` | 1.0 × 1.0 planter with flowers |
| `smoke_stack` | tall chimney 0.6 wide × 3 tall for run-down districts |
| `airport` | terminal + control tower, ~6 × 4 footprint (externals live here) |
| `plane` | small airliner ~3 long, white, origin at fuselage bottom |

## Previews (for review, not loaded by the app)

`art/previews/contact.png` — every part on a grid with labels, soft sun + sky light.
`art/previews/vignette.png` — a hand-placed mini district (town hall, a few stacked towers of
different heights, tinted shops, warehouse, crane on a foundation, trees, cars on a road strip, a
police cruiser pulling over a red car on a dirt track, a cloud and a rain cloud), camera at ~40°
looking down, warm sun from the upper left with soft shadows. This is the style test.

Debug renders: `-- --only contact --fast --filter police,cloud --tile 800` renders just those tiles
large into `art/previews/_tiles/`; `-- --only vignette --fast --close X Y` renders a 12-unit close-up
of the vignette around (X, Y) to `art/previews/_close.png`.
