# SPRAWLER → METROPOLIS (city design)

Branch: `explore/blender-models` · 2026-10-03 · status: **built** — see the README for running it and the file map

## 1. Why change the look

The current atlas is a neon "Geometry Wars" map: hex islands on a glowing floor, orange/cyan bezier
arcs, particles, bloom. It reads well on a clean repo (clankernative: 758 modules, 2.6k deps, score S/B)
and falls apart on a real one (Motion.NET: 6,554 modules, 47,454 deps, 1,017 "feature app uses another
feature app" findings). There every dependency is its own glowing line, so the screen becomes a hairball
and the one thing that matters — *which* connections are wrong — is drowned out by the ones that are fine.

A city solves that structurally, not cosmetically:

- **Roads are edge bundling people already understand.** 10,000 trips between two suburbs are one
  highway with heavy traffic, not 10,000 lines.
- **Good architecture looks like good urban planning.** Dense core, clear zoning, a ring road, highways
  between towns, forest left alone between them.
- **Bad architecture looks like sprawl.** Shortcuts bulldozed through the woods, dirt tracks between
  suburbs that were never meant to connect, slow trucks bouncing along them. The tool is called a
  sprawler — this makes the name literal.

## 2. What the references teach

Two videos from the same creator, both in `media-processing-pipeline/runs/`:

**A · cozy village builder** (`20261003T201239Z-1`) — chunky low-poly houses with saturated roofs, dense
lush forest as the default ground, winding dirt paths, river and waterfall, villagers walking jobs.
Steal:
- **Forest is the canvas.** Settlements are clearings. Empty space is never empty — it's woods.
- **Quest panel** (top-left "Starter Quests" with progress + rewards) → our inbox FIX/IMPROVE/CHECK.
- **Resource bar** across the top → our headline numbers.
- **Bottom build bar** of tools → our views/modes.
- **Unit card** (villager: job, state, carrying, position, Assign) → module/vehicle card.
- Placement ghost: green = OK, red ring + "Too close to a building" → instant rule feedback.

**B · WareTrack logistics twin** (`20261003T201011Z-1`) — white/grey clay world, one brand blue reserved
for "ours / selected", trucks and forklifts moving between depots, hubs on a road grid.
Steal:
- **Color means something or it's not used.** The city is neutral; blue = selected, status colors only
  where there's status. This is the single most important rule for a diagnostic tool.
- **KPI cards** top-left (stock 1,412 ▲15 · on-time 96.6% ▲0.4) → score, purity, findings with deltas.
- **Inspector** top-right that changes with what you click (hub, truck, forklift, pallet).
- **Shipment Tracking** timeline at the bottom (Order Confirmed → Picked → Loaded → In Transit →
  Delivered) → our **flows**: entry → op → model/core → port → adapter, with a vehicle driving it.
- **Docks / Forklifts / Trucks** tabbed table bottom-right → live lists (findings, ports, flows).
- Selected truck gets a blue route ribbon on the road ahead of it.
- Site switcher in the top bar → workspace/repo switcher.

**Recommended direction: B's discipline on A's land.** Neutral cream/white-clay buildings and roads, a
lush green forest everywhere else, and color reserved for meaning (blue select, amber drift, red broken).
A alone is too toy-like and too colorful to carry status; B alone has no forest, and the forest is the
whole metaphor.

## 3. The core idea

> **Roads exist exactly where the rules allow a dependency. Everything else has to go through the woods.**

The road network isn't decoration — it's generated from the profile's allow rules (tier `depends`,
`cross`, layer allow matrix). An allowed dependency is routed along roads and drives fast. A violation
has no road, so it cuts a straight-ish dirt track through the forest between the two buildings: trees
cleared, ruts, slow vehicles kicking up dust. More violations on the same pair = a wider, uglier scar.
One look at a district tells you how much forest it has destroyed.

This works for every rule profile (day2, dotnet) without special cases, because it's driven by the same
allow/deny data the judge already uses.

## 4. Concept mapping

### The map (layout)

`computeLayout` already places tiers as concentric rings with the first tier in the center. Keep that;
it's already a city plan.

| Atlas | City | Notes |
|---|---|---|
| Center tier (day2 `app` · dotnet shared/platform) | **Downtown** | densest, tallest |
| SDK / ports tier | **Beltway** — ring road with interchanges | "the only surface apps may touch" = the only road out of downtown |
| Host / adapters tier | **Industrial port district** — warehouses, docks, depots, trucks | effects, storage, transport. This is where WareTrack's look lives |
| Ops / CLI / tooling | **Service yards** — maintenance depots, utility sheds on the outskirts | |
| Company instances / hosts·composition | **Suburbs** — residential towns that commute in | they bind/compose apps |
| Unmapped (`fog`) | **Fog of war** — unexplored map | FULL MAP trophy = map fully explored |
| Externals (`pf.*`, NuGet, crates) | **Airport / seaport** at the map edge | imports from outside the city |
| Bounded context | **District / town** on its own hex plot, own name sign at the edge | |
| Hex grid | **Terrain tiles**, like a hex strategy game | keeps the name and the identity |

### Buildings (modules)

One building per module, instanced. Height = log LOC (as `nodeSize` today), footprint = symbol count.
The layer picks the archetype:

| Layer / role | Building |
|---|---|
| `root` / composition | **Town hall** of the district |
| `core`, `model`, `kernel` | **Civic core** — the district's plaza with landmark buildings, never touching a main road |
| `command` | **Workshops / factories** (they change things) |
| `query`, `view` | **Shops, libraries, kiosks** (they look things up) |
| `port` | **Interchange / toll gate** on the beltway |
| `adapter`, `driven` | **Warehouses with loading docks** |
| `driving` | **Bus station / city gate** (where requests arrive) |
| `generated` | **Prefab grey blocks** |
| `test`, `proof` | **Inspection tents / scaffolding** (hidden by default, like today) |
| `tool` | **Utility sheds** |
| `binding` | **Houses** (suburb homes) |
| `loose` | **Tents and shacks** — unzoned |

### Roads and traffic (edges)

| Edge status | City |
|---|---|
| `clean` (same context) | **Local streets** inside the district |
| `cross` (allowed, cross-context) | **Arterials → beltway → highways**, routed along roads, bundled per context pair. Lane count = log of edge weight |
| `violation` | **Dirt track through the forest**, no road. Width/rut depth = number of violating edges on that pair. Vehicles at ~15% speed, bouncing, dust, red-tinted |
| `test` | **Service roads**, inspection vans, hidden by default |
| `fog` | Roads disappearing into fog |
| Seam (contract handshake) | **Bridge over the river** between the Roc and Rust banks. In sync = intact bridge, `unhandled` = missing planks/collapsed span (fails at runtime), `dead` = bridge to nowhere |

**One car per dependency.** Vehicles replace particles; commands are **trucks** (they carry writes),
queries are **vans/cars**. Motion.NET really does get ~47k cars: one `InstancedMesh`, every car animated
in the vertex shader from a route texture (route id + offset + speed per instance), so the CPU never
touches them. Close up they're low-poly vehicles; at metro zoom they become headlight streaks along the
highways, GTA-at-night style.

### Health and smells

| Atlas | City |
|---|---|
| Context grade S → F | **District condition**: S manicured (parks, trees, clean roads) → D/F run-down (potholes, smoke, boarded windows). Read at a glance from the air |
| `nest` (rat's nest, tangle > 0.55) | **Spaghetti junction** — a knot of overpasses and alleys |
| Cycles | **Gridlocked roundabout** — traffic circling, never leaving |
| Gravity wells | **Mega-tower** casting a long shadow over many districts; traffic jams at its base |
| Phantoms (instance binds a missing app) | **Empty lot with a "coming soon" sign** |
| Score / grade / XP / trophies | **City rating** + the same trophies (PURE CORE, SEALED BORDERS, ONE-WAY STREET already sound like city ordinances) |
| History / churn | **Cranes and scaffolding** on recently changed buildings. REPLAY = time-lapse of the city being built |
| Live rescan | Construction happens live. A new violation = a bulldozer cuts a new dirt track while you watch, plus the existing toast |
| Flows (use cases) | **Shipments**: a vehicle drives the route entry → op → core → port → adapter while the bottom timeline ticks through the stages (WareTrack's Shipment Tracking) |
| Traces (tests) | **One vehicle replaying a real test run**, camera following. A failure = breakdown with smoke + the existing alarm |

## 5. The town's happenings (alerts)

### What "under construction" means

**Construction = uncommitted work.** The working tree is the building site; a commit is the grand
opening. That gives every building a lifecycle driven by `git status` + the scan diff, no new
instrumentation needed:

| Git / scan state | In the world |
|---|---|
| New untracked file | **Foundation pit + tower crane.** Crane height grows with lines written |
| Modified tracked file | **Scaffolding** wrapped around the existing building (renovation) |
| Deleted file | **Wrecking ball**, then a rubble lot until committed |
| Commit lands | Scaffolding drops, crane folds away, **ribbon-cutting confetti**, headline |
| New allowed dependency (uncommitted) | **Orange cones + paving crew** on that road; becomes a normal road on commit |
| New violation (uncommitted) | **Unpermitted construction**: a bulldozer starts cutting a dirt track through the woods, a code-inspector car parks next to it with a red flag. Highest-value alert: the cheapest moment to fix is before the commit |
| New violation (committed) | Track becomes a permanent dirt road, traffic starts using it |
| Violation resolved | Track closes and **the forest grows back** over a few seconds, +XP |
| Seam goes `unhandled` | **Bridge span collapses** into the river; cars queue at the edge |
| Grade drops / rises | District goes grimy with smoke / gets parks, trees, fireworks |
| Test run (trace) | **Inspector van** drives the route; pass = green flag on the site, fail = breakdown smoke + red tape |
| New cycle | Roundabout locks into gridlock |
| Branch switch | "City rezoned" — a quick rebuild sweep across the map |

Agents editing code show up the same way: while a Claude session fixes something, you watch the
construction crew work in that district in real time.

### How you find out — five layers, loudest to quietest

1. **Advisor alert** (interrupts) — critical violation, bridge collapse, district drops a grade. A card
   slides in from the advisor for that kind of problem (Zoning = layer breach, Transit = context
   bleed / port bypass, Utilities = seams, Planning = cycles/nests/wells, Inspector = tests) with
   **FLY THERE · AGENT FIX · LATER**. Siren sound, light camera shake (existing).
2. **Site markers + off-screen arrows** — every active site gets a floating icon bubble above it
   (crane, bulldozer, broken bridge, red flag), like the village game's job bubbles. Sites off screen
   get GTA-style arrows on the screen edge with a distance, so you always know where the action is.
3. **Minimap / radar** (bottom-left) — the whole metro with blinking blips: yellow construction, red
   unpermitted, blue selected. Click to fly.
4. **News ticker — "The Daily Commit"** (bottom strip) — every event as a scrolling headline, newest
   first, click to fly there:
   - *"NEW: query slice breaks ground in Reports"*
   - *"Crm bulldozes shortcut through Pine Woods to Mobile — 3 new violations"*
   - *"Wire bridge collapses: host no longer handles `defer`"*
   - *"Golinks reopens after renovation, grade A → S"*
5. **In the world itself** — cranes, dust, cones, traffic. Visible whenever you look, never pushes.

Plus sound: hammering near active sites, a horn for a new violation, a siren for critical, a crowd
cheer for trophies (the `audio.js` synth already has hooks).

### "While you were away" — the morning paper

When you open the app, a newspaper front page summarizes everything since your last visit: commits
that landed, buildings opened and demolished, new dirt roads, roads reforested, grade changes,
trophies. Each story has a FLY THERE. Last-visit time lives in localStorage.

### Spectator camera

When idle, instead of the current auto-rotate, the camera drifts between active construction sites
like a news chopper. Any input hands control back.

### Quests from events

New problems become quests in the left panel automatically ("Close the dirt road from Crm to Mobile —
+150 XP"), so an alert always ends in something to do. This is the existing inbox with better words.

### What needs to change underneath

- **Backend**: `history.py` already runs `git status --porcelain` but only counts lines. Keep the
  per-file status (new / modified / deleted, + line counts from `git diff --numstat`) and tag each
  module and each edge as committed or working-tree.
- **Event diff**: compare scan N with N−1 (modules, edges, violations, seams, grades, trophies, HEAD)
  and emit typed events `{t, kind, severity, ctx, modules, headline, target}`. Today `main.js:241-244`
  does a partial version of this for toasts; move it to the server so the morning paper can replay
  events from a persisted log.
- **Faster updates**: polling every 2 s is fine for construction to feel live; keep it.

## 6. Camera and levels of detail

Strategy-game camera: fixed ~40° tilt, orbit and zoom, WASD pan (already there), no free-fly by default.

1. **Metro** (whole map) — districts as hex plots with skyline silhouettes, only highways and dirt
   tracks, aggregated per context pair. Motion.NET's 67 contexts give a few hundred roads, not 47k
   lines. Forest is mostly intact on a clean repo and visibly scarred on a messy one — the overview
   answers "how bad is it" before any number does.
2. **District** — individual buildings, local streets, individual dirt paths per violating edge,
   moving traffic.
3. **Building** — inspector card. Its incoming and outgoing deps light up as blue route ribbons.

## 7. UI

| Area | Content | From |
|---|---|---|
| Top bar | workspace switcher, HEAD, LIVE pill, search, views | B |
| Top-left KPI cards | grade + score, purity, findings, each with a delta since last scan | B |
| Left | **Quests** = inbox FIX / IMPROVE / CHECK with SHOW and AGENT FIX | A |
| Top-right | **Inspector** for whatever is selected (district, building, road, bridge, vehicle) | B |
| Bottom-center | **Shipment timeline** when a flow or trace is playing; view bar otherwise | B / A |
| Bottom-right | tabbed lists: Flows · Ports · Bridges · Commits | B |

Panels are rounded cream cards with soft shadows; a monospace face only for paths and numbers. Bloom
and starfield go. Lighting: one warm sun with soft shadows, sky hemisphere, ambient occlusion, AgX
tonemapping, optional tilt-shift at metro zoom.

## 8. How it's built

**The city is generated from atlas data; Blender makes the kit of parts, not the city.**

- **Blender kit** (low-poly, shared palette texture, `.glb`): ~12 building archetypes × 3 sizes with
  roof variants; 3–4 tree types and clusters; car, van, truck; crane and scaffold; bridge spans; town
  hall; interchange; dirt and dust decals; fog cards. Each exported, optimized with
  `gltf-transform optimize --compress meshopt`, loaded once.
- **three.js** (r180, existing scene):
  - `InstancedMesh` per archetype: 6.5k buildings and ~30–50k trees are well inside budget.
  - Terrain: hex tiles tagged `forest | clearing | road | water | fog`. Districts are clearings,
    everything else forest.
  - Roads: A* over the hex grid. Allowed edges route on road tiles (cheap); violations route with road
    tiles forbidden and forest expensive but passable → they carve their own tracks. Road ribbons are
    generated meshes along the routed spline. Clearing forest instances along a track is just removing
    instances.
  - Traffic: instanced vehicles moving along road splines with a per-road speed factor.
  - Existing selection, isolation, Esc stack, inbox, flows, traces, history and live polling stay;
    only their visual layer changes.

## 9. Phases

0. **Style test** — Blender kit v0 (5 buildings, 2 trees, 1 car, road piece) + one hand-made mock
   district rendered in Blender and in three.js. Lock the art direction before writing systems.
1. **Land and buildings** — hex terrain, districts as clearings, buildings from modules, forest.
   No roads yet. Replaces the neon map.
2. **Roads** — routing, beltway, highways, interchanges at ports, dirt tracks for violations, bridges
   for seams.
3. **Traffic** — vehicles, speed by road type, volume by weight.
4. **UI reskin** — cards, inspector, quests, timeline.
5. **Stories** — flows as shipments, traces as vehicle replay, history time-lapse, live construction,
   district condition by grade.

## 10. Decisions

- **Art direction**: hybrid — B's neutral clay city on A's lush forest. Feel: SimCity / GTA, not cozy toy.
- **Total replacement**: the neon map, bloom, starfield and current HUD all go. Existing behaviour
  (selection, Esc stack, inbox, flows, traces, history, live polling, export) is kept and reskinned.
- **One car per dependency**, GPU-animated.
- **Construction = uncommitted work**; alerts per section 5.
- Tuning datasets: clankernative ("clean city") and Motion.NET ("sprawl").

## 11. What shipped (2026-10-03)

Everything in sections 3–9 is implemented, with these specifics:

- **Layout**: districts are ring cities (plaza → ring streets → outer street, radial spokes); the metro is the
  core tier packed in the centre, the other tiers on rings, a ring road in each forest belt and connectors
  through the gaps. Routing is analytic on that polar shape, so 47k routes plan in about a second.
- **Traffic**: one car per dependency, animated in the vertex shader from a route texture; trucks for
  commands, vans for queries; red for rule breaks; boxes at metro zoom; headlights at night.
- **Construction**: backend per-file `git status` + wip edges (Roc imports re-read from HEAD, other languages
  against a session baseline) and a persisted event log (`/api/events`).
- **Alerts**: all five layers + the morning paper + the news-chopper idle camera.
- **Seams**: a river between the emitting and handling tiers, a named bridge per seam.
- **Extras not in the original plan**: night mode, plan (white clay) mode, flow playback as a delivery truck
  with a shipment timeline, and `sprawler demo` — a self-running living city on a sandbox copy.
- **Dropped**: the force-directed "tangle" comparison and island heights by traffic/churn — a building's
  height is its size, a district's condition is its grade.

