"""Verify web/public/kit/kit.glb against KIT.md basics: names, identity transforms, attributes, extras,
triangle budgets, and the police light-bar `_SIREN` attribute. Exit code 1 on any contract failure."""
import json, struct, sys, os

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "web", "public", "kit", "kit.glb")
data = open(path, "rb").read()
magic, ver, length = struct.unpack_from("<III", data, 0)
clen, ctype = struct.unpack_from("<II", data, 12)
gj = json.loads(data[20:20 + clen])
blen, btype = struct.unpack_from("<II", data, 20 + clen)
BIN = data[28 + clen:28 + clen + blen]
nodes = gj["nodes"]
errors = []

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_acc(i):
    a = gj["accessors"][i]
    bv = gj["bufferViews"][a["bufferView"]]
    fmt, sz = COMP[a["componentType"]]
    nc = NCOMP[a["type"]]
    stride = bv.get("byteStride", sz * nc)
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    out = []
    for k in range(a["count"]):
        vals = struct.unpack_from("<" + fmt * nc, BIN, off + k * stride)
        out.append(vals if nc > 1 else vals[0])
    return out


bad = []
for n in nodes:
    for k in ("translation", "rotation", "scale", "matrix"):
        if k in n:
            bad.append((n["name"], k, n[k]))
attrs = set()
missing = []
tris = {}
color_types = set()
for n in nodes:
    m = gj["meshes"][n["mesh"]]
    t = 0
    for pr in m["primitives"]:
        a = pr["attributes"]
        attrs |= set(a)
        for need in ("POSITION", "NORMAL", "COLOR_0", "_TINT", "_GLOW"):
            if need not in a:
                missing.append((n["name"], need))
        if "COLOR_0" in a:
            acc = gj["accessors"][a["COLOR_0"]]
            color_types.add((acc["componentType"], acc.get("normalized", False), acc["type"]))
        t += gj["accessors"][pr["indices"]]["count"] // 3
    tris[n["name"]] = t

# ---- budgets (KIT.md) --------------------------------------------------------------------------------
STACK = ("landmark", "civic", "factory", "shop", "library", "warehouse", "prefab", "apartment", "office", "megatower")
WHOLE = ("hall", "tollgate", "station", "substation", "shed", "tent", "house", "house2", "shack", "airport")
TREES = ("tree_pine", "tree_pine_tall", "tree_round", "tree_round_small", "tree_birch", "bush", "rock")
VEHICLES = ("car", "van", "truck", "bulldozer", "excavator", "inspector", "police")
SPECIAL = {"cloud": 200, "rain_cloud": 220}


def budget(name):
    if name in SPECIAL:
        return SPECIAL[name]
    if any(name.startswith(s + "_") for s in STACK):
        return 400
    if name in WHOLE:
        return 500
    if name in TREES:
        return 150
    if name in VEHICLES:
        return 260
    if name.startswith("crane_"):
        return 350
    return 500


over = [(k, v, budget(k)) for k, v in tris.items() if v > budget(k)]

# ---- _SIREN on police ----------------------------------------------------------------------------------
siren_report = "police node missing"
by_name = {n["name"]: n for n in nodes}
siren_nodes = [n["name"] for n in nodes for pr in gj["meshes"][n["mesh"]]["primitives"] if "_SIREN" in pr["attributes"]]
if "police" in by_name:
    pr = gj["meshes"][by_name["police"]["mesh"]]["primitives"][0]
    if "_SIREN" not in pr["attributes"]:
        errors.append("police has no _SIREN attribute")
        siren_report = "MISSING"
    else:
        sv = read_acc(pr["attributes"]["_SIREN"])
        pos = read_acc(pr["attributes"]["POSITION"])
        glow = read_acc(pr["attributes"]["_GLOW"])
        col = read_acc(pr["attributes"]["COLOR_0"])
        vals = sorted(set(round(v, 4) for v in sv))
        pos_x = [p[0] for p, s in zip(pos, sv) if s > 0.5]
        neg_x = [p[0] for p, s in zip(pos, sv) if s < -0.5]
        glow_ok = all(g > 0.5 for g, s in zip(glow, sv) if abs(s) > 0.5)
        # COLOR_0 is normalised ubyte/ushort: red half should be red-dominant, blue half blue-dominant
        red_ok = all(c[0] > c[2] for c, s in zip(col, sv) if s > 0.5)
        blue_ok = all(c[2] > c[0] for c, s in zip(col, sv) if s < -0.5)
        if vals != [-1.0, 0.0, 1.0]:
            errors.append(f"police _SIREN values {vals} != [-1, 0, 1]")
        if not pos_x or not neg_x or min(pos_x) < -1e-4 or max(neg_x) > 1e-4:
            errors.append("police _SIREN halves not split at x=0 (+1 must be +X, -1 must be -X)")
        if not (glow_ok and red_ok and blue_ok):
            errors.append(f"police siren glow/colour mismatch glow={glow_ok} red={red_ok} blue={blue_ok}")
        siren_report = (f"values {vals}; +1 verts {len(pos_x)} (x {min(pos_x):.3f}..{max(pos_x):.3f}, red); "
                        f"-1 verts {len(neg_x)} (x {min(neg_x):.3f}..{max(neg_x):.3f}, blue); _GLOW=1 on both: {glow_ok}")

withh = {n["name"]: n.get("extras", {}).get("h") for n in nodes if "extras" in n}
stack_bases = [s + "_base" for s in STACK]
no_h = [b for b in stack_bases if withh.get(b) is None]
if bad:
    errors.append(f"non-identity transforms: {bad}")
if missing:
    errors.append(f"missing attrs: {missing}")
if over:
    errors.append(f"over budget: {over}")
if no_h:
    errors.append(f"bases without extras.h: {no_h}")
if "materials" in gj or "cameras" in gj or "KHR_lights_punctual" in json.dumps(gj.get("extensions", {})):
    errors.append("materials / cameras / lights present")

print("file", path, len(data), "bytes;", "nodes", len(nodes), "meshes", len(gj["meshes"]))
print("scene roots", len(gj["scenes"][0]["nodes"]), "| materials:", "materials" in gj, "| cameras:", "cameras" in gj,
      "| lights:", "KHR_lights_punctual" in json.dumps(gj.get("extensions", {})))
print("attributes seen:", sorted(attrs))
print("COLOR_0 accessor (componentType, normalized, type):", sorted(color_types))
print("non-identity transforms:", bad or "none")
print("missing attrs:", missing or "none")
print("extras h:", withh)
print("_SIREN carried by:", siren_nodes)
print("police _SIREN:", siren_report)
print("triangles:", " ".join(f"{k}={v}" for k, v in tris.items()))
print("over budget:", over or "none")
print("extensionsUsed:", gj.get("extensionsUsed"))
print("names:", " ".join(n["name"] for n in nodes))
print("RESULT:", "OK" if not errors else "FAIL\n  " + "\n  ".join(errors))
sys.exit(1 if errors else 0)
