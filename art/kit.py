"""HEX ATLAS city kit — procedural Blender generator.

Contract: art/KIT.md. Rebuild everything with

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python art/kit.py

Optional args after `--`:
    --no-previews        build + export only
    --only contact       render only the contact sheet (or: vignette)
    --fast               low sample counts for quick iteration
    --filter a,b         contact sheet: only tiles whose label contains one of these (keeps art/previews/_tiles)
    --tile 900           contact tile size in px (for close-up inspection)

Writes art/kit.blend, web/public/kit/kit.glb, art/previews/contact.png, art/previews/vignette.png.

Every part is generated into a `Part` (flat list of polygons + a palette key per polygon), then turned into
one mesh object at the world origin. Palette keys carry the sRGB colour plus the `_TINT` / `_GLOW` flags,
so colour + attributes can never drift apart.
"""

import bpy
import bmesh
import math
import os
import random
import shutil
import subprocess
import sys
from contextlib import contextmanager
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BLEND_OUT = os.path.join(HERE, "kit.blend")
GLB_OUT = os.path.join(REPO, "web", "public", "kit", "kit.glb")
PREVIEW_DIR = os.path.join(HERE, "previews")

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FAST = "--fast" in ARGS
ONLY = ARGS[ARGS.index("--only") + 1] if "--only" in ARGS else None
NO_PREVIEWS = "--no-previews" in ARGS
FILTER = ARGS[ARGS.index("--filter") + 1].split(",") if "--filter" in ARGS else None
TILE = int(ARGS[ARGS.index("--tile") + 1]) if "--tile" in ARGS else 360     # contact tile px (debug close-ups)

# --------------------------------------------------------------------------------------------------
# Palette: key -> (sRGB hex, _TINT, _GLOW, _SIREN)
# --------------------------------------------------------------------------------------------------


def _c(h, tint=0.0, glow=0.0, siren=0.0):
    return (h, tint, glow, siren)


PAL = {
    # KIT.md palette
    "wall": _c("#F3EFE6"), "cream": _c("#E8E1D2"), "stone": _c("#D9D2C3"), "trim": _c("#FBFAF6"),
    "tint": _c("#D8D4CC", tint=1.0), "dark": _c("#8E959E"), "glass": _c("#9DB7C9", glow=1.0),
    "frame": _c("#5E6873"), "wood": _c("#A98463"), "concrete": _c("#C7C3BB"), "metal": _c("#B5BBC2"),
    "yellow": _c("#F2C230"), "hazard": _c("#2E3238"),
    "leaf1": _c("#5FA845"), "leaf2": _c("#4E9440"), "leaf3": _c("#79B95A"), "leaf4": _c("#3F7F3A"),
    "pine1": _c("#3E7B45"), "pine2": _c("#356B3D"), "trunk": _c("#7A5A3E"), "rock": _c("#A7A49C"),
    "dirt": _c("#B48A5E"), "orange": _c("#F07A2A"), "slate": _c("#2F3A45"), "water": _c("#8FD0EA"),
    # small detail colours (named in KIT.md or needed for the stated notes)
    "lamp": _c("#FFF1C9", glow=1.0),        # lamp heads / headlights (lit at night)
    "red": _c("#E5484D", glow=1.0),         # inspector light bar, beacon
    "blue": _c("#3B82F6", glow=1.0),        # inspector light bar
    "carglass": _c("#5F7587"),              # vehicle glass: _GLOW-free per KIT.md
    "taillight": _c("#C4473F", glow=1.0),   # tail lamps glow red at night
    "navy": _c("#22304A"),                  # police doors / hood stripe
    "siren_r": _c("#E5484D", glow=1.0, siren=1.0),    # police light bar, LEFT (+X) half
    "siren_b": _c("#3B82F6", glow=1.0, siren=-1.0),   # police light bar, RIGHT (-X) half
    "cloud_top": _c("#FBFCFD"), "cloud_mid": _c("#E9ECF0"), "cloud_bot": _c("#C7CDD6"),
    "rain_top": _c("#A3AAB5"), "rain_mid": _c("#878F9B"), "rain_bot": _c("#636B77"),
    "leaf5": _c("#6AAF4C"), "leaf6": _c("#88C063"), "pine3": _c("#4A8A4E"),
    "ac": _c("#C9CED4"), "vent": _c("#7F8893"),
    "birch": _c("#EEEAE1"),
    "pink": _c("#E99AB2"), "petal": _c("#F4DE8C"), "lilac": _c("#B8A2DC"),
    # preview-only ground colours (never on kit parts)
    "g_grass": _c("#A9CF7E"), "g_grass2": _c("#9CC672"), "g_road": _c("#7D838A"), "g_line": _c("#F4F1EA"),
    "g_walk": _c("#E2DED5"), "g_plaza": _c("#EAE5DA"), "g_dirt": _c("#C9A47A"), "g_paper": _c("#C9CFBF"),
}


def srgb(h):
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (1, 3, 5))


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# --------------------------------------------------------------------------------------------------
# Geometry builder
# --------------------------------------------------------------------------------------------------

FACES = {"bot": (0, 3, 2, 1), "top": (4, 5, 6, 7), "s": (0, 1, 5, 4), "e": (1, 2, 6, 5),
         "n": (2, 3, 7, 6), "w": (3, 0, 4, 7)}
SIDE_ROT = {"s": 0, "e": 90, "n": 180, "w": -90}


class types_face:
    """Minimal stand-in for a BMFace so normal-based key functions work on hand-built polygons."""
    def __init__(self, normal):
        self.normal = normal


class Part:
    def __init__(self, name):
        self.name = name
        self.V, self.F, self.K = [], [], []
        self.stack = [Matrix.Identity(4)]

    @property
    def M(self):
        return self.stack[-1]

    @contextmanager
    def at(self, x=0.0, y=0.0, z=0.0, rz=0.0, rx=0.0, ry=0.0, s=1.0):
        T = Matrix.Translation((x, y, z))
        R = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_matrix().to_4x4()
        if isinstance(s, (int, float)):
            s = (s, s, s)
        S = Matrix.Diagonal((s[0], s[1], s[2], 1.0))
        self.stack.append(self.M @ T @ R @ S)
        try:
            yield
        finally:
            self.stack.pop()

    @contextmanager
    def face(self, side, W, D, cx=0.0, cy=0.0):
        """Work on one facade as if it were the south (-Y) one: facade at local y = -hd, x across it."""
        fw, hd = (W, D / 2) if side in "sn" else (D, W / 2)
        with self.at(cx, cy, 0, rz=SIDE_ROT[side]):
            yield fw, hd

    # ---- raw polygons -----------------------------------------------------------------------------
    def poly(self, pts, key):
        assert key in PAL, key
        M = self.M
        idx = []
        for p in pts:
            v = M @ Vector(p)
            self.V.append((v.x, v.y, v.z))
            idx.append(len(self.V) - 1)
        if M.determinant() < 0:
            idx.reverse()
        self.F.append(idx)
        self.K.append(key)

    def poly_out(self, pts, key, center):
        """Polygon oriented so its normal points away from `center` (for convex solids)."""
        vs = [Vector(p) for p in pts]
        n = Vector((0, 0, 0))
        for i in range(len(vs)):
            a, b = vs[i], vs[(i + 1) % len(vs)]
            n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        c = sum(vs, Vector()) / len(vs)
        if n.dot(c - Vector(center)) < 0:
            pts = list(pts)[::-1]
        self.poly(pts, key)

    def quad_s(self, u0, v0, u1, v1, y, key):
        """Quad in the plane y (facing -Y), u along X, v along Z."""
        self.poly([(u0, y, v0), (u1, y, v0), (u1, y, v1), (u0, y, v1)], key)

    def arch_s(self, cx, z0, w, h, y, key, segs=4):
        r = w / 2
        zc = z0 + h - r
        pts = [(cx - r, y, z0), (cx + r, y, z0)]
        for i in range(segs + 1):
            a = math.pi * i / segs
            pts.append((cx + r * math.cos(a), y, zc + r * math.sin(a)))
        self.poly(pts, key)

    # ---- boxes ------------------------------------------------------------------------------------
    def _hexa(self, c, key, skip, fk):
        sk = skip.split() if skip else []
        for f, ids in FACES.items():
            if f in sk:
                continue
            self.poly([c[i] for i in ids], fk.get(f, key))

    def box(self, x0, y0, z0, x1, y1, z1, key, skip="", **fk):
        c = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
             (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        self._hexa(c, key, skip, fk)

    def boxc(self, cx, cy, z0, w, d, h, key, skip="", **fk):
        self.box(cx - w / 2, cy - d / 2, z0, cx + w / 2, cy + d / 2, z0 + h, key, skip, **fk)

    def taper(self, x0, y0, x1, y1, z0, tx0, ty0, tx1, ty1, z1, key, skip="", **fk):
        c = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
             (tx0, ty0, z1), (tx1, ty0, z1), (tx1, ty1, z1), (tx0, ty1, z1)]
        self._hexa(c, key, skip, fk)

    def add_bm(self, bm, key, keyfn=None):
        bm.normal_update()
        for f in bm.faces:
            k = keyfn(f) if keyfn else key
            if k is None:
                continue
            self.poly([tuple(v.co) for v in f.verts], k)
        bm.free()

    def bbox(self, x0, y0, z0, x1, y1, z1, key, b=0.03, top=None, edges="all", bottom=False):
        """Box with 1-segment chamfers. edges: all | v (vertical only) | top (top rim + vertical)."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((x0 + (v.co.x + 0.5) * (x1 - x0), y0 + (v.co.y + 0.5) * (y1 - y0),
                           z0 + (v.co.z + 0.5) * (z1 - z0)))
        eps = 1e-6
        sel = []
        for e in bm.edges:
            a, c = e.verts[0].co, e.verts[1].co
            vertical = abs(a.x - c.x) < eps and abs(a.y - c.y) < eps
            toprim = abs(a.z - z1) < eps and abs(c.z - z1) < eps
            if edges == "all" or (edges == "v" and vertical) or (edges == "top" and (vertical or toprim)):
                sel.append(e)
        b = min(b, 0.45 * min(x1 - x0, y1 - y0, z1 - z0))
        bmesh.ops.bevel(bm, geom=sel, offset=b, offset_type="OFFSET", segments=1, profile=0.5,
                        affect="EDGES", clamp_overlap=True)

        def kf(f):
            if f.normal.z > 0.9:
                return top or key
            if f.normal.z < -0.9 and not bottom:
                return None
            return key
        self.add_bm(bm, key, kf)

    # ---- prisms / extrusions ----------------------------------------------------------------------
    def prism(self, n, r0, z0, z1, key, r1=None, cx=0.0, cy=0.0, rot=None, top=True, bot=True,
              topk=None, botk=None, sx=1.0, sy=1.0, ox=0.0, oy=0.0, star=None):
        r1 = r0 if r1 is None else r1
        rot = math.pi / n if rot is None else rot
        m = n * 2 if star else n

        def ring(r, z, dx, dy):
            pts = []
            for i in range(m):
                a = rot + 2 * math.pi * i / m
                rr = r * (star if (star and i % 2) else 1.0)
                pts.append((cx + dx + rr * sx * math.cos(a), cy + dy + rr * sy * math.sin(a), z))
            return pts
        R0 = ring(r0, z0, 0, 0)
        if r1 <= 1e-9:
            apex = (cx + ox, cy + oy, z1)
            for i in range(m):
                self.poly([R0[i], R0[(i + 1) % m], apex], key)
        else:
            R1 = ring(r1, z1, ox, oy)
            for i in range(m):
                j = (i + 1) % m
                self.poly([R0[i], R0[j], R1[j], R1[i]], key)
            if top:
                self.poly(R1, topk or key)
        if bot:
            self.poly(R0[::-1], botk or key)

    def ring(self, n, rin, rout, z0, z1, key, inner=None, topk=None, bot=False, rot=None):
        rot = math.pi / n if rot is None else rot
        P = lambda r, z, i: (r * math.cos(rot + 2 * math.pi * i / n), r * math.sin(rot + 2 * math.pi * i / n), z)
        for i in range(n):
            j = (i + 1) % n
            self.poly([P(rout, z0, i), P(rout, z0, j), P(rout, z1, j), P(rout, z1, i)], key)
            self.poly([P(rin, z0, j), P(rin, z0, i), P(rin, z1, i), P(rin, z1, j)], inner or key)
            self.poly([P(rout, z1, i), P(rout, z1, j), P(rin, z1, j), P(rin, z1, i)], topk or key)
            if bot:
                self.poly([P(rin, z0, i), P(rin, z0, j), P(rout, z0, j), P(rout, z0, i)], key)

    def extrude(self, prof, axis, a0, a1, keys, cap=None, caps=(True, True)):
        """Extrude a 2D profile. axis x: (u,v)=(y,z); y: (x,z); z: (x,y). keys per edge or one key."""
        pts = list(prof)
        n = len(pts)
        if isinstance(keys, str):
            keys = [keys] * n
        keys = list(keys)
        area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
        if area < 0:
            pts = pts[::-1]
            keys = [keys[(n - 2 - i) % n] for i in range(n)]
        if isinstance(cap, str) or cap is None:
            cap = (cap, cap)

        def P(u, v, a):
            return {"x": (a, u, v), "y": (u, a, v), "z": (u, v, a)}[axis]
        flip = axis == "y"
        for i in range(n):
            if keys[i] is None:
                continue
            (u0, v0), (u1, v1) = pts[i], pts[(i + 1) % n]
            q = [P(u0, v0, a0), P(u1, v1, a0), P(u1, v1, a1), P(u0, v0, a1)]
            self.poly(q[::-1] if flip else q, keys[i])
        if caps[1] and cap[1]:
            t = [P(u, v, a1) for u, v in pts]
            self.poly(t[::-1] if flip else t, cap[1])
        if caps[0] and cap[0]:
            b = [P(u, v, a0) for u, v in pts][::-1]
            self.poly(b[::-1] if flip else b, cap[0])

    def bar(self, p0, p1, w, key, n=4, caps=False, rot=None):
        p0, p1 = Vector(p0), Vector(p1)
        z = (p1 - p0).normalized()
        up = Vector((0, 0, 1)) if abs(z.z) < 0.95 else Vector((1, 0, 0))
        x = up.cross(z).normalized()
        y = z.cross(x)
        r = (w / 2) / math.cos(math.pi / n)
        rot = math.pi / n if rot is None else rot
        offs = [(math.cos(rot + 2 * math.pi * i / n) * x + math.sin(rot + 2 * math.pi * i / n) * y) * r
                for i in range(n)]
        A = [tuple(p0 + o) for o in offs]
        B = [tuple(p1 + o) for o in offs]
        for i in range(n):
            j = (i + 1) % n
            self.poly([A[i], A[j], B[j], B[i]], key)
        if caps:
            self.poly(B, key)
            self.poly(A[::-1], key)

    def blob(self, cx, cy, cz, rx, ry, rz, key, seed=0, jit=0.12, keyfn=None, rot=0.0, sub=1):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        rng = random.Random(seed)
        ca, sa = math.cos(rot), math.sin(rot)
        for v in bm.verts:
            k = 1.0 + rng.uniform(-jit, jit)
            x, y, z = v.co.x * rx * k, v.co.y * ry * k, v.co.z * rz * k
            v.co = Vector((cx + x * ca - y * sa, cy + x * sa + y * ca, cz + z))
        self.add_bm(bm, key, keyfn)

    def puff(self, cx, cy, cz, rx, ry, rz, keyfn, seed=0, jit=0.1, sub=2, rot=0.0, floor=0.0, cap=True):
        """Icosphere blob sliced flat at z = floor (cloud puffs): flat dark belly, faceted dome."""
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        rng = random.Random(seed)
        ca, sa = math.cos(rot), math.sin(rot)
        for v in bm.verts:
            k = 1.0 + rng.uniform(-jit, jit)
            x, y, z = v.co.x * rx * k, v.co.y * ry * k, v.co.z * rz * k
            v.co = Vector((cx + x * ca - y * sa, cy + x * sa + y * ca, cz + z))
        if cz - rz < floor:
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, floor), plane_no=(0, 0, 1),
                                         clear_inner=True)
            if cap:
                cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
                bmesh.ops.holes_fill(bm, edges=cut, sides=64)
        self.add_bm(bm, None, keyfn)

    def dome(self, cx, cy, z0, rx, ry, h, keyfn, n=7, rot=0.0, seed=0, jit=0.06, belly=True):
        """Faceted cloud puff: flat belly at z0, two staggered (antiprism) bands, apex. 6n-2 tris."""
        rng = random.Random(seed)
        prof = [(1.0, 0.0, 0.0), (0.94, 0.42, 0.5), (0.6, 0.8, 0.0)]     # (radius, height, phase)
        rings = []
        for r, zf, ph in prof:
            ring = []
            for i in range(n):
                a = rot + 2 * math.pi * (i + ph) / n
                k = 1.0 + rng.uniform(-jit, jit)
                ring.append(Vector((cx + rx * r * k * math.cos(a), cy + ry * r * k * math.sin(a),
                                    z0 + h * zf * (1.0 if zf == 0 else 1.0 + rng.uniform(-jit, jit)))))
            rings.append(ring)
        apex = Vector((cx + rng.uniform(-0.08, 0.08) * rx, cy + rng.uniform(-0.08, 0.08) * ry, z0 + h))
        cen = Vector((cx, cy, z0 + h * 0.4))
        tris = []
        for (R0, R1, ph0) in ((rings[0], rings[1], 0), (rings[1], rings[2], 1)):
            for i in range(n):
                j = (i + 1) % n
                if ph0 == 0:    # R1 is offset +half step
                    tris += [(R0[i], R0[j], R1[i]), (R0[j], R1[j], R1[i])]
                else:           # R0 offset +half, R1 aligned
                    tris += [(R0[i], R1[j], R1[i]), (R0[i], R0[j], R1[j])]
        for i in range(n):
            tris.append((rings[2][i], rings[2][(i + 1) % n], apex))
        for t in tris:
            vs = list(t)
            nrm = (vs[1] - vs[0]).cross(vs[2] - vs[0])
            c = (vs[0] + vs[1] + vs[2]) / 3
            if nrm.dot(c - cen) < 0:
                vs.reverse()
                nrm = -nrm
            k = keyfn(types_face(nrm.normalized()))
            self.poly([tuple(v) for v in vs], k)
        if belly:
            self.poly([tuple(v) for v in rings[0][::-1]], keyfn(types_face(Vector((0, 0, -1)))))

    def hip(self, x0, y0, x1, y1, z0, h, key, ridge=None, bottom=True, botk=None):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        lx, ly = x1 - x0, y1 - y0
        zt = z0 + h
        cen = (cx, cy, z0 + h * 0.3)
        if lx >= ly:
            r = max(0.0, (lx - ly) / 2) if ridge is None else ridge
            R0, R1 = (cx - r, cy, zt), (cx + r, cy, zt)
            faces = [[(x0, y0, z0), (x1, y0, z0), R1, R0], [(x1, y1, z0), (x0, y1, z0), R0, R1],
                     [(x1, y0, z0), (x1, y1, z0), R1], [(x0, y1, z0), (x0, y0, z0), R0]]
        else:
            r = max(0.0, (ly - lx) / 2) if ridge is None else ridge
            R0, R1 = (cx, cy - r, zt), (cx, cy + r, zt)
            faces = [[(x1, y0, z0), (x1, y1, z0), R1, R0], [(x0, y1, z0), (x0, y0, z0), R0, R1],
                     [(x0, y0, z0), (x1, y0, z0), R0], [(x1, y1, z0), (x0, y1, z0), R1]]
        for f in faces:
            dedup = []
            for q in f:
                if not dedup or (Vector(q) - Vector(dedup[-1])).length > 1e-7:
                    dedup.append(q)
            if (Vector(dedup[0]) - Vector(dedup[-1])).length < 1e-7:
                dedup.pop()
            self.poly_out(dedup, key, cen)
        if bottom:
            self.poly([(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)], botk or key)

    def gable(self, axis, a0, a1, u0, u1, z0, zw, zr, wall, roof, t=0.06, over=0.1, fascia="trim",
              soffit="trim", ridge=None):
        """Walls with gable ends (pentagon extrude) + two thick roof slabs with overhang.
        axis: ridge direction ('x' or 'y'); a0..a1 along ridge, u0..u1 across, wall top zw, ridge zr."""
        uc = (u0 + u1) / 2 if ridge is None else ridge
        self.extrude([(u0, z0), (u1, z0), (u1, zw), (uc, zr), (u0, zw)], axis, a0, a1, wall, cap=wall,
                     caps=(True, True))
        self.roof_slabs(axis, a0 - over, a1 + over, u0, u1, zw, zr, uc, roof, t, over, fascia, soffit)

    def roof_slabs(self, axis, a0, a1, u0, u1, zw, zr, uc, roof, t, over, fascia, soffit):
        for (ua, ub) in ((u0, uc), (u1, uc)):
            d = Vector((ub - ua, zr - zw))
            L = d.length
            dn = d / L
            A = Vector((ua, zw)) - dn * over
            B = Vector((ub, zr)) + dn * (t * 0.6)
            nrm = Vector((-dn.y, dn.x)) if (ub > ua) else Vector((dn.y, -dn.x))
            prof = [tuple(A), tuple(B), tuple(B + nrm * t), tuple(A + nrm * t)]
            # edge keys: underside, ridge end, top, eave end
            self.extrude(prof, axis, a0, a1, [soffit, roof, roof, fascia], cap=fascia)


# --------------------------------------------------------------------------------------------------
# Shared building helpers
# --------------------------------------------------------------------------------------------------


def win_floor(p, W, D, h, n=(3, 3), wall="wall", cp=0.15, pw=0.12, inset=0.06, sill=0.1, head=0.06,
              sill_key=None, head_key=None, pier_key=None, glass="glass", vertical=False,
              sill_recess=False, frames=True, mullions=True, transom=True, ledge=True, ledge_key="trim",
              fw_frame=0.028):
    """A storey made of a recessed core + sill/head bands + piers -> deep, shadowed windows.

    frames: the recessed core is window-frame grey and every bay gets its own glass pane inset by
    `fw_frame`, so each window reads as framed glass (only the panes carry _GLOW).
    mullions / transom: thin frame bars across wide panes. ledge: a projecting sill ledge under the row."""
    hw, hd = W / 2, D / 2
    core = "frame" if frames else glass
    p.box(-hw + inset, -hd + inset, sill, hw - inset, hd - inset, h - head, core, skip="top bot")
    if sill > 0:
        if sill_recess:
            p.box(-hw + inset, -hd + inset, 0, hw - inset, hd - inset, sill, sill_key or wall, skip="top bot")
        else:
            p.box(-hw, -hd, 0, hw, hd, sill, sill_key or wall, skip="bot")
            if ledge:
                lo = 0.028
                p.box(-hw - lo, -hd - lo, sill - 0.035, hw + lo, hd + lo, sill, ledge_key, skip="bot")
    if head > 0:
        p.box(-hw, -hd, h - head, hw, hd, h, head_key or wall, skip="top")
    za, zb = (0.0, h) if vertical else (sill, h - head)
    gz0, gz1 = sill, h - head
    pk = pier_key or wall
    for side in "senw":
        nn = n[0] if side in "sn" else n[1]
        with p.face(side, W, D) as (fw, d2):
            x0 = -fw / 2
            p.box(x0, -d2, za, x0 + cp, -d2 + cp, zb, pk, skip="top bot n e")
            span = fw - 2 * cp
            ww = (span - (nn - 1) * pw) / nn
            for i in range(1, nn):
                x = x0 + cp + i * ww + (i - 1) * pw
                p.box(x, -d2, za, x + pw, -d2 + inset, zb, pk, skip="top bot n")
            if not frames:
                continue
            yg = -d2 + inset
            f = min(fw_frame, ww * 0.14)
            for i in range(nn):
                cx = x0 + cp + i * (ww + pw) + ww / 2
                p.quad_s(cx - ww / 2 + f, gz0 + f, cx + ww / 2 - f, gz1 - f, yg - 0.004, glass)
                if mullions and ww > 0.3:
                    p.quad_s(cx - 0.011, gz0 + f, cx + 0.011, gz1 - f, yg - 0.008, "frame")
            if transom and gz1 - gz0 > 0.26:
                zt = gz0 + (gz1 - gz0) * 0.7
                p.quad_s(x0 + cp, zt - 0.011, -x0 - cp, zt + 0.011, yg - 0.008, "frame")


def win_centers(fw, n, cp, pw):
    span = fw - 2 * cp
    ww = (span - (n - 1) * pw) / n
    return [(-fw / 2 + cp + i * (ww + pw) + ww / 2) for i in range(n)], ww


def parapet(p, W, D, z0, h, t, key):
    hw, hd = W / 2, D / 2
    p.box(-hw, -hd, z0, hw, -hd + t, z0 + h, key, skip="bot")
    p.box(-hw, hd - t, z0, hw, hd, z0 + h, key, skip="bot")
    p.box(-hw, -hd + t, z0, -hw + t, hd - t, z0 + h, key, skip="bot s n")
    p.box(hw - t, -hd + t, z0, hw, hd - t, z0 + h, key, skip="bot s n")


def window_decal(p, cx, z0, w, h, y, glass="glass", frame="frame", f=0.025):
    p.quad_s(cx - w / 2 - f, z0 - f, cx + w / 2 + f, z0 + h + f, y - 0.008, frame)
    p.quad_s(cx - w / 2, z0, cx + w / 2, z0 + h, y - 0.016, glass)


def corrugate(p, W, D, z0, z1, key, period=0.2, amp=0.025):
    for side in "senw":
        with p.face(side, W, D) as (fw, hd):
            k = max(2, round(fw / period))
            step = fw / k
            pts = []
            for i in range(k * 2 + 1):
                x = -fw / 2 + i * step / 2
                y = -hd if i % 2 == 0 else -hd + amp
                pts.append((x, y))
            for i in range(len(pts) - 1):
                (xa, ya), (xb, yb) = pts[i], pts[i + 1]
                p.poly([(xa, ya, z0), (xb, yb, z0), (xb, yb, z1), (xa, ya, z1)], key)


def oct_pts(half, ch):
    a, b = half, half - ch
    return [(b, -a), (a, -b), (a, b), (b, a), (-b, a), (-a, b), (-a, -b), (-b, -a)]


def oct_prism(p, half, ch, z0, z1, key, top=None, bot=False):
    p.extrude(oct_pts(half, ch), "z", z0, z1, key, cap=(key if bot else None, top),
              caps=(bot, top is not None))


def column(p, x, y, z0, z1, r=0.065, key="trim", cap=True, n=6):
    p.prism(n, r, z0, z1, key, cx=x, cy=y, top=False, bot=False)
    if cap:
        s = r * 1.5
        p.box(x - s, y - s, z1 - 0.045, x + s, y + s, z1, key, skip="top")


def ac_unit(p, x, y, z, w=0.3, d=0.24, h=0.16, rz=0.0):
    """Rooftop condenser: metal box, dark fan disc on top, louvre lines on the front. ~22 tris."""
    with p.at(x, y, z, rz=rz):
        p.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, "ac", skip="bot")
        r = min(w, d) * 0.36
        p.poly([(r * math.cos(a), r * math.sin(a), h + 0.004) for a in
                (math.pi / 6 + k * math.pi / 3 for k in range(6))], "vent")
        for k in range(3):
            zz = h * (0.25 + 0.22 * k)
            p.quad_s(-w / 2 + 0.03, zz, w / 2 - 0.03, zz + 0.018, -d / 2 - 0.004, "vent")


def water_tank(p, x, y, z, r=0.17, h=0.24, legs=0.2):
    """Wooden rooftop water tank on four legs with a conical cap. ~64 tris."""
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.bar((x + sx * r * 0.7, y + sy * r * 0.7, z), (x + sx * r * 0.6, y + sy * r * 0.6, z + legs), 0.025,
                  "frame", n=3)
    p.prism(8, r, z + legs, z + legs + h, "wood", cx=x, cy=y, top=False, botk="frame")
    p.prism(8, r + 0.006, z + legs + h * 0.3, z + legs + h * 0.36, "frame", cx=x, cy=y, top=False, bot=False)
    p.prism(8, r * 1.08, z + legs + h, z + legs + h + 0.13, "dark", r1=0.0, cx=x, cy=y, bot=True)


def antenna(p, x, y, z, h=0.55, cross=True, beacon=True):
    """Thin mast with a cross-arm and a red (glowing) aircraft beacon. ~24 tris."""
    p.bar((x, y, z), (x, y, z + h), 0.022, "metal", n=3)
    if cross:
        p.bar((x - 0.1, y, z + h * 0.72), (x + 0.1, y, z + h * 0.72), 0.014, "metal", n=3)
    if beacon:
        p.boxc(x, y, z + h, 0.035, 0.035, 0.035, "red", skip="bot")


def dish(p, x, y, z, r=0.11, rz=30.0):
    """Satellite dish on a short post, tilted to the sky. ~26 tris."""
    p.bar((x, y, z), (x, y, z + 0.1), 0.025, "metal", n=3)
    with p.at(x, y, z + 0.12, rz=rz, rx=-55):
        p.prism(6, r * 0.3, -0.05, 0.0, "metal", r1=r, top=True, topk="trim", bot=True, botk="metal")
        p.bar((0, 0, 0.0), (0, 0, r * 0.9), 0.012, "frame", n=3)


def vent_stack(p, x, y, z, r=0.045, h=0.16):
    p.prism(6, r, z, z + h, "metal", cx=x, cy=y, topk="vent", bot=False)


def skylight(p, x0, y0, x1, y1, z):
    p.box(x0, y0, z, x1, y1, z + 0.05, "trim", skip="bot top")
    p.poly([(x0, y0, z + 0.05), (x1, y0, z + 0.05), (x1, y1, z + 0.08), (x0, y1, z + 0.08)], "glass")


# --------------------------------------------------------------------------------------------------
# Part registry
# --------------------------------------------------------------------------------------------------

PARTS = []      # (name, fn, group, h)


def part(name, group, h=None):
    def deco(fn):
        PARTS.append((name, fn, group, h))
        return fn
    return deco


# ==================================================================================================
# STACKABLE BUILDINGS
# ==================================================================================================

# ---- landmark: art-deco tower 2.0 x 2.0 ---------------------------------------------------------
@part("landmark_base", "landmark", h=1.0)
def _(p):
    W = D = 2.0
    p.bbox(-1.0, -1.0, 0, 1.0, 1.0, 0.14, "dark", b=0.03)
    with p.at(z=0.14):
        win_floor(p, W, D, 0.86, n=(3, 3), wall="stone", cp=0.24, pw=0.16, inset=0.07, sill=0.06, head=0.16)
    p.box(-0.2, -0.955, 0.2, 0.2, -0.93, 0.6, "frame", skip="bot top n")
    p.bbox(-0.45, -1.16, 0.64, 0.45, -0.9, 0.71, "trim", b=0.02, bottom=True)
    for x in (-0.36, 0.36):
        p.box(x - 0.025, -1.14, 0.14, x + 0.025, -1.09, 0.64, "frame", skip="top bot")


@part("landmark_floor", "landmark")
def _(p):
    win_floor(p, 2.0, 2.0, 0.5, n=(4, 4), wall="stone", cp=0.22, pw=0.11, inset=0.07, sill=0.13, head=0,
              vertical=True, sill_recess=True, sill_key="frame")


@part("landmark_roof", "landmark")
def _(p):
    p.bbox(-1.04, -1.04, 0, 1.04, 1.04, 0.1, "trim", b=0.03)
    with p.at(z=0.1):
        win_floor(p, 1.6, 1.6, 0.5, n=(3, 3), wall="stone", cp=0.2, pw=0.1, inset=0.06, sill=0.13, head=0,
                  vertical=True, sill_recess=True, sill_key="frame", mullions=False, transom=False)
    p.bbox(-0.86, -0.86, 0.6, 0.86, 0.86, 0.68, "trim", b=0.02)
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.prism(4, 0.13, 0.68, 0.98, "trim", r1=0.0, cx=sx * 0.7, cy=sy * 0.7, rot=math.pi / 4, bot=False)
    with p.at(z=0.68):
        win_floor(p, 1.16, 1.16, 0.45, n=(2, 2), wall="stone", cp=0.18, pw=0.1, inset=0.05, sill=0.12, head=0,
                  vertical=True, sill_recess=True, sill_key="frame", mullions=False, transom=False)
    p.bbox(-0.66, -0.66, 1.13, 0.66, 0.66, 1.2, "trim", b=0.02)
    p.prism(8, 0.46, 1.2, 1.5, "stone", r1=0.42, bot=False, top=False)
    p.prism(8, 0.36, 1.5, 1.72, "glass", bot=False, top=False)
    p.prism(8, 0.44, 1.72, 1.79, "trim", bot=True)
    p.prism(4, 0.3, 1.79, 2.65, "metal", r1=0.0, rot=math.pi / 4, bot=False)
    p.bar((0, 0, 2.5), (0, 0, 3.05), 0.035, "metal")


# ---- civic: museum 2.3 x 2.0 ---------------------------------------------------------------------
@part("civic_base", "civic", h=1.0)
def _(p):
    W, D = 2.3, 2.0
    hw = W / 2
    p.bbox(-hw, -0.7, 0, hw, 1.0, 0.18, "stone", b=0.02)
    for i in range(3):
        p.box(-0.85, -1.0 + 0.1 * i, 0, 0.85, -0.7, 0.06 * (i + 1), "stone", skip="bot n")
    for sx in (-1, 1):
        x0, x1 = sorted((sx * 0.87, sx * hw))
        p.bbox(x0, -1.0, 0, x1, -0.7, 0.26, "stone", b=0.02)
    p.box(-hw + 0.06, -0.42, 0.18, hw - 0.06, 0.96, 0.88, "cream", skip="bot top")
    # door + windows behind the portico
    window_decal(p, 0, 0.18, 0.34, 0.5, -0.42, glass="frame", frame="trim")
    for x in (-0.62, 0.62):
        window_decal(p, x, 0.34, 0.2, 0.36, -0.42)
    for side in "ew":
        with p.face(side, W - 0.12, 1.38, cy=0.27) as (fw, hd):
            for x in (-0.42, 0.0, 0.42):
                window_decal(p, x, 0.34, 0.16, 0.38, -hd)
    for x in (-0.78, -0.47, -0.16, 0.16, 0.47, 0.78):
        column(p, x, -0.58, 0.18, 0.88, r=0.065)
    p.bbox(-hw, -1.0, 0.88, hw, 1.0, 1.0, "trim", b=0.02, bottom=True)


@part("civic_floor", "civic")
def _(p):
    win_floor(p, 2.3, 2.0, 0.5, n=(5, 4), wall="cream", cp=0.17, pw=0.14, inset=0.06, sill=0.13, head=0.09)
    p.box(-1.17, -1.02, 0, 1.17, 1.02, 0.045, "trim", skip="")


@part("civic_roof", "civic")
def _(p):
    p.bbox(-1.19, -1.04, 0, 1.19, 1.04, 0.1, "trim", b=0.03, bottom=True)
    p.box(-1.1, -0.95, 0.1, 1.1, 0.95, 0.26, "cream", skip="bot")
    # low classical gable, pediment to the front
    p.extrude([(-1.13, 0.26), (1.13, 0.26), (1.13, 0.31), (0, 0.66), (-1.13, 0.31)], "y", -1.0, 1.0,
              ["trim", "trim", "tint", "tint", "trim"], cap="trim")
    p.poly([(-0.82, -1.008, 0.33), (0.82, -1.008, 0.33), (0, -1.008, 0.58)], "cream")


# ---- factory 2.3 x 2.1 -------------------------------------------------------------------------
@part("factory_base", "factory", h=0.9)
def _(p):
    W, D = 2.3, 2.1
    hw, hd = W / 2, D / 2
    p.bbox(-hw, -hd, 0, hw, hd, 0.08, "dark", b=0.02)
    p.box(-hw + 0.02, -hd + 0.02, 0.08, hw - 0.02, hd - 0.02, 0.9, "stone", skip="bot top")
    p.box(-hw, -hd, 0.82, hw, hd, 0.9, "concrete", skip="top")
    for cx in (-0.52, 0.52):
        p.box(cx - 0.43, -hd - 0.01, 0.08, cx + 0.43, -hd + 0.03, 0.78, "frame", skip="bot n")
        p.box(cx - 0.37, -hd - 0.03, 0.08, cx + 0.37, -hd - 0.01, 0.72, "metal", skip="bot n")
        for z in (0.24, 0.4, 0.56):
            p.quad_s(cx - 0.37, z, cx + 0.37, z + 0.018, -hd - 0.036, "frame")
    for side in "ew":
        with p.face(side, W - 0.04, D - 0.04) as (fw, d2):
            p.quad_s(-fw / 2 + 0.2, 0.5, fw / 2 - 0.2, 0.7, -d2 - 0.012, "glass")
            for x in (-0.3, 0.3):
                p.quad_s(x - 0.015, 0.5, x + 0.015, 0.7, -d2 - 0.018, "frame")
    with p.face("n", W - 0.04, D - 0.04) as (fw, d2):
        p.quad_s(0.4, 0.08, 0.7, 0.55, -d2 - 0.012, "frame")
        p.bbox(0.32, -d2 - 0.22, 0.6, 0.78, -d2, 0.64, "tint", b=0.01, bottom=True)


@part("factory_floor", "factory")
def _(p):
    win_floor(p, 2.3, 2.1, 0.5, n=(6, 6), wall="stone", cp=0.14, pw=0.045, inset=0.05, sill=0.2, head=0.07,
              pier_key="frame")


@part("factory_roof", "factory")
def _(p):
    W, D = 2.3, 2.1
    p.bbox(-W / 2 - 0.03, -D / 2 - 0.03, 0, W / 2 + 0.03, D / 2 + 0.03, 0.08, "concrete", b=0.02, top="dark",
           bottom=True)
    for i in range(3):
        y0 = -1.0 + i * 0.67
        y1 = y0 + 0.67
        p.extrude([(y0, 0.08), (y1, 0.08), (y1, 0.52), (y1 - 0.05, 0.52)], "x", -1.1, 0.5,
                  [None, "glass", "tint", "tint"], cap="stone")
    p.prism(8, 0.16, 0.08, 1.95, "concrete", r1=0.12, cx=0.85, cy=0.62, top=False, bot=False)
    p.prism(8, 0.155, 1.4, 1.5, "dark", cx=0.85, cy=0.62, top=False, bot=False)
    p.prism(8, 0.15, 1.86, 1.97, "dark", cx=0.85, cy=0.62, topk="hazard", bot=False)
    p.bbox(0.62, -0.75, 0.08, 1.0, -0.35, 0.3, "metal", b=0.02)
    ac_unit(p, 0.82, 0.05, 0.08, w=0.3, d=0.24, h=0.15, rz=90)
    vent_stack(p, 0.65, -0.95, 0.08, r=0.05, h=0.22)


# ---- shop 2.1 x 2.0 ---------------------------------------------------------------------------------
@part("shop_base", "shop", h=0.8)
def _(p):
    W, D = 2.1, 2.0
    hw, hd = W / 2, D / 2
    p.bbox(-hw, -hd, 0, hw, hd, 0.05, "dark", b=0.015)
    p.box(-hw, -hd + 0.1, 0.05, hw, hd, 0.8, "wall", skip="bot top", s="glass")
    p.box(-hw, -hd, 0.05, -hw + 0.14, -hd + 0.1, 0.8, "wall", skip="bot top n")
    p.box(hw - 0.14, -hd, 0.05, hw, -hd + 0.1, 0.8, "wall", skip="bot top n")
    p.box(-hw + 0.14, -hd, 0.6, hw - 0.14, -hd + 0.1, 0.8, "trim", skip="top n")
    for x in (-0.48, 0.48):
        p.box(x - 0.02, -hd + 0.07, 0.05, x + 0.02, -hd + 0.1, 0.6, "frame", skip="top bot n")
    p.box(-0.17, -hd + 0.075, 0.05, 0.17, -hd + 0.1, 0.5, "frame", skip="bot top n")
    p.quad_s(-0.12, 0.1, 0.12, 0.45, -hd + 0.074, "glass")
    # striped awning (tint / white candy stripes; tint stripes take the per-instance colour)
    prof = [(-1.2, 0.46), (-hd + 0.1, 0.59), (-hd + 0.1, 0.63), (-1.2, 0.5)]
    ns = 7
    for i in range(ns):
        xa, xb = -0.9 + i * 1.8 / ns, -0.9 + (i + 1) * 1.8 / ns
        k = "tint" if i % 2 == 0 else "trim"
        p.extrude(prof, "x", xa, xb, [k, None, k, k], cap=k, caps=(i == 0, i == ns - 1))
    # valance: little scalloped lip along the front edge of the awning
    for i in range(ns):
        xa, xb = -0.9 + i * 1.8 / ns, -0.9 + (i + 1) * 1.8 / ns
        k = "tint" if i % 2 == 0 else "trim"
        p.poly([(xa, -1.201, 0.46), (xb, -1.201, 0.46), (xb, -1.201, 0.5), (xa, -1.201, 0.5)][::-1], k)
        p.poly([(xa, -1.201, 0.46), ((xa + xb) / 2, -1.201, 0.42), (xb, -1.201, 0.46)][::-1], k)
    # sign block on the fascia with blocky "lettering"
    p.box(-0.56, -hd - 0.045, 0.64, 0.56, -hd, 0.78, "slate", skip="bot n")
    for i, (lx, lw, lh) in enumerate(((-0.46, 0.09, 0.08), (-0.33, 0.13, 0.06), (-0.16, 0.07, 0.08),
                                      (-0.05, 0.15, 0.06), (0.14, 0.09, 0.08), (0.27, 0.07, 0.06),
                                      (0.38, 0.08, 0.08))):
        p.quad_s(lx, 0.71 - lh / 2, lx + lw, 0.71 + lh / 2, -hd - 0.049, "tint")
    # blade sign on the corner
    p.box(hw - 0.06, -hd - 0.22, 0.66, hw - 0.03, -hd - 0.02, 0.78, "trim", skip="bot")
    p.box(hw - 0.075, -hd - 0.2, 0.68, hw - 0.015, -hd - 0.04, 0.76, "tint", skip="bot top")
    # planter boxes either side of the door
    for x in (-0.3, 0.3):
        p.box(x - 0.09, -hd - 0.06, 0.05, x + 0.09, -hd + 0.06, 0.13, "wood", skip="bot n")
        p.box(x - 0.075, -hd - 0.045, 0.13, x + 0.075, -hd + 0.06, 0.17, "leaf1", skip="bot n", top="leaf3")
    for side in "ew":
        with p.face(side, W, D) as (fw, d2):
            window_decal(p, 0.3, 0.25, 0.4, 0.3, -d2)
    with p.face("n", W, D) as (fw, d2):
        window_decal(p, -0.5, 0.05, 0.3, 0.5, -d2, glass="frame", frame="stone")


@part("shop_floor", "shop")
def _(p):
    win_floor(p, 2.1, 2.0, 0.5, n=(3, 3), wall="wall", cp=0.16, pw=0.32, inset=0.06, sill=0.14, head=0.08)


@part("shop_roof", "shop")
def _(p):
    W, D = 2.1, 2.0
    p.box(-W / 2, -D / 2, 0, W / 2, D / 2, 0.04, "tint", skip="bot")
    parapet(p, W + 0.04, D + 0.04, 0, 0.17, 0.08, "trim")
    p.bbox(0.05, -0.1, 0.04, 0.55, 0.32, 0.27, "metal", b=0.02)
    p.prism(8, 0.13, 0.27, 0.285, "frame", cx=0.3, cy=0.11, bot=False)
    p.bbox(-0.7, 0.2, 0.04, -0.4, 0.5, 0.16, "concrete", b=0.015)
    p.prism(6, 0.05, 0.04, 0.3, "metal", cx=-0.5, cy=-0.45, topk="frame", bot=False)
    ac_unit(p, 0.55, -0.6, 0.04, w=0.32, d=0.24, h=0.15)
    ac_unit(p, -0.15, 0.62, 0.04, w=0.26, d=0.2, h=0.13, rz=90)
    vent_stack(p, -0.75, -0.2, 0.04)


# ---- library 2.2 x 2.0 -----------------------------------------------------------------------------
def _lib_pilasters_and_arches(p, W, D, z0, z1, n, arch_h, arch_w, door=False):
    for side in "senw":
        nn = n[0] if side in "sn" else n[1]
        with p.face(side, W, D) as (fw, hd):
            step = fw / nn
            for i in range(nn + 1):
                x = -fw / 2 + i * step
                x0, x1 = max(-fw / 2, x - 0.05), min(fw / 2, x + 0.05)
                p.box(x0, -hd - 0.035, z0, x1, -hd, z1, "trim", skip="top bot n")
            for i in range(nn):
                cx = -fw / 2 + (i + 0.5) * step
                if door and side == "s" and i == nn // 2:
                    p.arch_s(cx, z0, arch_w + 0.1, arch_h + 0.06, -hd - 0.008, "trim", segs=4)
                    p.arch_s(cx, z0, arch_w, arch_h, -hd - 0.016, "frame", segs=4)
                    continue
                zb = z0 + (z1 - z0 - arch_h) * 0.45
                p.arch_s(cx, zb - 0.02, arch_w + 0.05, arch_h + 0.045, -hd - 0.008, "frame", segs=4)
                p.arch_s(cx, zb, arch_w, arch_h, -hd - 0.016, "glass", segs=4)


@part("library_base", "library", h=0.9)
def _(p):
    W, D = 2.2, 2.0
    p.bbox(-W / 2, -D / 2, 0, W / 2, D / 2, 0.12, "stone", b=0.02)
    p.box(-W / 2 + 0.03, -D / 2 + 0.03, 0.12, W / 2 - 0.03, D / 2 - 0.03, 0.9, "cream", skip="bot top")
    _lib_pilasters_and_arches(p, W - 0.06, D - 0.06, 0.12, 0.82, (5, 4), 0.5, 0.22, door=True)
    p.box(-W / 2, -D / 2, 0.82, W / 2, D / 2, 0.9, "trim", skip="top")
    p.box(-0.32, -1.12, 0, 0.32, -0.97, 0.06, "stone", skip="bot n")


@part("library_floor", "library")
def _(p):
    W, D = 2.2, 2.0
    p.box(-W / 2 + 0.03, -D / 2 + 0.03, 0, W / 2 - 0.03, D / 2 - 0.03, 0.5, "cream", skip="bot top")
    p.box(-W / 2, -D / 2, 0, W / 2, D / 2, 0.05, "trim", skip="bot")
    _lib_pilasters_and_arches(p, W - 0.06, D - 0.06, 0.05, 0.5, (5, 4), 0.32, 0.2)


@part("library_roof", "library")
def _(p):
    p.bbox(-1.15, -1.05, 0, 1.15, 1.05, 0.08, "trim", b=0.025, bottom=True)
    p.hip(-1.12, -1.02, 1.12, 1.02, 0.08, 0.58, "tint", ridge=0.35, bottom=False)
    p.prism(6, 0.13, 0.5, 0.82, "trim", top=False, bot=False)
    p.prism(6, 0.105, 0.6, 0.76, "glass", top=False, bot=False, rot=0)
    p.prism(6, 0.18, 0.82, 1.08, "tint", r1=0.0, bot=True, botk="trim")


# ---- warehouse 2.4 x 2.0 ---------------------------------------------------------------------------
@part("warehouse_base", "warehouse", h=0.9)
def _(p):
    W, D = 2.4, 2.0
    hw, hd = W / 2, D / 2
    p.box(-hw, -hd, 0, hw, hd, 0.3, "concrete", skip="bot")
    p.box(-hw + 0.02, -hd + 0.02, 0.3, hw - 0.02, hd - 0.02, 0.9, "stone", skip="bot top")
    p.box(-hw, -hd, 0.84, hw, hd, 0.9, "trim", skip="top")
    p.box(-hw + 0.1, -1.2, 0, hw - 0.1, -hd, 0.22, "concrete", skip="bot n")
    for cx in (-0.75, 0.0, 0.75):
        p.box(cx - 0.3, -hd - 0.025, 0.22, cx + 0.3, -hd, 0.78, "frame", skip="bot n")
        p.quad_s(cx - 0.25, 0.22, cx + 0.25, 0.73, -hd - 0.03, "metal")
        for z in (0.38, 0.55):
            p.quad_s(cx - 0.25, z, cx + 0.25, z + 0.015, -hd - 0.034, "frame")
        for sx in (-1, 1):
            p.box(cx + sx * 0.27 - 0.035, -1.25, 0.05, cx + sx * 0.27 + 0.035, -1.2, 0.2, "hazard", skip="n")
    p.box(-hw + 0.1, -1.2, 0.81, hw - 0.1, -hd, 0.845, "metal", skip="n")
    with p.face("e", W, D) as (fw, d2):
        window_decal(p, 0.4, 0.3, 0.22, 0.42, -d2, glass="frame", frame="trim")
        window_decal(p, -0.3, 0.55, 0.4, 0.14, -d2)


@part("warehouse_floor", "warehouse")
def _(p):
    corrugate(p, 2.4, 2.0, 0.0, 0.44, "cream", period=0.2, amp=0.028)
    p.box(-1.21, -1.01, 0.44, 1.21, 1.01, 0.5, "trim", skip="top")


@part("warehouse_roof", "warehouse")
def _(p):
    p.extrude([(-1.05, 0.0), (1.05, 0.0), (1.05, 0.05), (0, 0.33), (-1.05, 0.05)], "x", -1.23, 1.23,
              ["dark", "trim", "tint", "tint", "trim"], cap="cream")
    k = 0.28 / 1.05
    for x in (-0.75, 0.0, 0.75):
        y0, y1 = -0.85, -0.35
        z0, z1 = 0.05 + (y0 + 1.05) * k + 0.008, 0.05 + (y1 + 1.05) * k + 0.008
        p.poly([(x - 0.18, y0, z0), (x + 0.18, y0, z0), (x + 0.18, y1, z1), (x - 0.18, y1, z1)], "glass")
    p.box(-0.9, -0.06, 0.3, 0.9, 0.06, 0.37, "metal", skip="bot")
    for x in (-0.6, 0.0, 0.6):      # turbine vents on the back slope
        z = 0.05 + (1.05 - 0.55) * k
        p.prism(6, 0.07, z - 0.02, z + 0.1, "metal", cx=x, cy=0.55, top=False, bot=False)
        p.prism(6, 0.085, z + 0.1, z + 0.17, "ac", r1=0.03, cx=x, cy=0.55, bot=True, botk="vent")


# ---- prefab 1.9 x 1.9 -------------------------------------------------------------------------------
def _container(p, x0, x1, y0, y1, z0, h, key, outer, door=False, window=False):
    z1 = z0 + h
    sk = "top bot " + outer
    p.box(x0, y0, z0, x1, y1, z1, key, skip=sk)
    with p.face(outer, (x1 - x0), (y1 - y0), cx=(x0 + x1) / 2, cy=(y0 + y1) / 2) as (fw, hd):
        k = 9
        step = fw / k
        pts = []
        for i in range(k * 2 + 1):
            pts.append((-fw / 2 + i * step / 2, -hd if i % 2 == 0 else -hd + 0.02))
        for i in range(len(pts) - 1):
            (xa, ya), (xb, yb) = pts[i], pts[i + 1]
            p.poly([(xa, ya, z0 + 0.04), (xb, yb, z0 + 0.04), (xb, yb, z1 - 0.04), (xa, ya, z1 - 0.04)], key)
        p.box(-fw / 2, -hd, z0, fw / 2, -hd + 0.03, z0 + 0.04, "dark", skip="bot top n")
        p.box(-fw / 2, -hd, z1 - 0.04, fw / 2, -hd + 0.03, z1, "dark", skip="bot top n")
        if door:
            p.quad_s(-0.15, z0 + 0.04, 0.15, z1 - 0.06, -hd - 0.012, "frame")
        if window:
            p.quad_s(0.35, z0 + 0.16, 0.7, z1 - 0.12, -hd - 0.012, "glass")
    for (cx, cy) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        p.box(cx - 0.035, cy - 0.035, z0, cx + 0.035, cy + 0.035, z1, "dark",
              skip="top bot")
    for x in (x0, x1):
        with p.face("e" if x == x1 else "w", x1 - x0, y1 - y0, cx=(x0 + x1) / 2, cy=(y0 + y1) / 2) as (fw, hd):
            for u in (-0.12, 0.0, 0.12):
                p.quad_s(u - 0.008, z0 + 0.06, u + 0.008, z1 - 0.06, -hd - 0.01, "dark")


def _prefab_layer(p, z0, door=False):
    _container(p, -0.95, 0.85, -0.95, -0.01, z0, 0.5, "metal", "s", door=door, window=not door)
    _container(p, -0.95, 0.95, 0.01, 0.95, z0, 0.5, "concrete", "n", window=True)


@part("prefab_base", "prefab", h=0.6)
def _(p):
    p.bbox(-0.97, -0.97, 0, 0.97, 0.97, 0.1, "concrete", b=0.02)
    _prefab_layer(p, 0.1, door=True)


@part("prefab_floor", "prefab")
def _(p):
    _prefab_layer(p, 0.0)


@part("prefab_roof", "prefab")
def _(p):
    p.box(-0.95, -0.95, 0, 0.85, -0.01, 0.04, "metal", skip="bot")
    p.box(-0.95, 0.01, 0, 0.95, 0.95, 0.04, "concrete", skip="bot")
    p.bbox(-0.6, 0.3, 0.04, -0.3, 0.6, 0.2, "metal", b=0.015)
    p.bbox(0.2, -0.6, 0.04, 0.4, -0.4, 0.14, "dark", b=0.015)
    p.bar((0.6, 0.6, 0.04), (0.6, 0.6, 0.55), 0.025, "metal")
    p.boxc(0.6, 0.6, 0.55, 0.05, 0.05, 0.05, "glass")
    ac_unit(p, -0.45, -0.5, 0.04, w=0.3, d=0.22, h=0.14)


# ---- apartment 2.0 x 2.0 ---------------------------------------------------------------------------
@part("apartment_base", "apartment", h=0.8)
def _(p):
    W = D = 2.0
    p.bbox(-1, -1, 0, 1, 1, 0.06, "dark", b=0.015)
    with p.at(z=0.06):
        win_floor(p, W, D, 0.74, n=(3, 3), wall="cream", cp=0.18, pw=0.22, inset=0.07, sill=0.0, head=0.18)
    p.box(-0.18, -0.94, 0.06, 0.18, -0.93, 0.5, "frame", skip="bot top n")
    p.bbox(-0.36, -1.2, 0.52, 0.36, -0.93, 0.57, "trim", b=0.015, bottom=True)


@part("apartment_floor", "apartment")
def _(p):
    win_floor(p, 2.0, 2.0, 0.5, n=(3, 3), wall="cream", cp=0.18, pw=0.22, inset=0.06, sill=0.14, head=0.08)
    for cx in (-0.62, 0.62):
        x0, x1 = cx - 0.27, cx + 0.27
        p.box(x0, -1.2, 0.0, x1, -1.0, 0.04, "trim", skip="n")
        p.box(x0, -1.2, 0.04, x1, -1.175, 0.2, "wall", skip="bot n")
        p.box(x0, -1.175, 0.04, x0 + 0.025, -1.0, 0.2, "wall", skip="bot s n")
        p.box(x1 - 0.025, -1.175, 0.04, x1, -1.0, 0.2, "wall", skip="bot s n")


@part("apartment_roof", "apartment")
def _(p):
    p.box(-1, -1, 0, 1, 1, 0.05, "tint", skip="bot")
    parapet(p, 2.04, 2.04, 0, 0.16, 0.08, "trim")
    p.box(-0.7, 0.15, 0.05, -0.15, 0.75, 0.4, "cream", skip="bot")
    p.box(-0.72, 0.13, 0.4, -0.13, 0.77, 0.44, "trim", skip="")
    p.quad_s(-0.55, 0.05, -0.35, 0.32, 0.15 - 0.01, "frame")
    # water tower on legs
    cx, cy = 0.45, 0.3
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.bar((cx + sx * 0.13, cy + sy * 0.13, 0.05), (cx + sx * 0.11, cy + sy * 0.11, 0.3), 0.025, "frame")
    p.prism(8, 0.19, 0.3, 0.58, "wood", cx=cx, cy=cy, top=False)
    p.prism(8, 0.195, 0.36, 0.39, "frame", cx=cx, cy=cy, top=False, bot=False)
    p.prism(8, 0.21, 0.58, 0.72, "dark", r1=0.0, cx=cx, cy=cy, bot=True)
    ac_unit(p, -0.45, -0.45, 0.05)
    ac_unit(p, 0.1, -0.5, 0.05, w=0.26, d=0.22, h=0.14)
    dish(p, -0.55, 0.62, 0.44, rz=200)
    vent_stack(p, 0.6, -0.55, 0.05)


# ---- office 2.0 x 2.0 ------------------------------------------------------------------------------
@part("office_base", "office", h=1.0)
def _(p):
    p.box(-0.9, -0.9, 0, 0.9, 0.9, 0.86, "glass", skip="bot top")
    for sx in (-1, 1):
        for sy in (-1, 1):
            x0, x1 = sorted((sx * 1.0, sx * 0.8))
            y0, y1 = sorted((sy * 1.0, sy * 0.8))
            p.box(x0, y0, 0, x1, y1, 0.86, "stone", skip="top bot")
    for x in (-0.3, 0.3):
        p.box(x - 0.03, -0.93, 0, x + 0.03, -0.9, 0.86, "frame", skip="top bot n")
    p.box(-0.22, -0.91, 0, 0.22, -0.9, 0.42, "frame", skip="top bot n")
    p.box(-1, -1, 0.86, 1, 1, 1.0, "trim", skip="top")
    p.bbox(-0.55, -1.22, 0.52, 0.55, -0.9, 0.58, "trim", b=0.015, bottom=True)


@part("office_floor", "office")
def _(p):
    p.box(-1, -1, 0, 1, 1, 0.16, "trim", skip="bot")
    p.box(-0.97, -0.97, 0.16, 0.97, 0.97, 0.5, "glass", skip="top bot")
    for side in "senw":
        with p.face(side, 2.0, 2.0) as (fw, hd):
            for x in (-0.48, 0.0, 0.48):
                p.box(x - 0.012, -hd + 0.015, 0.16, x + 0.012, -hd + 0.03, 0.5, "frame", skip="top bot n")
            p.box(-1, -1, 0.16, -0.93, -0.93, 0.5, "trim", skip="top bot n e")


@part("office_roof", "office")
def _(p):
    p.box(-1, -1, 0, 1, 1, 0.16, "trim", skip="bot")
    p.box(-0.95, -0.95, 0.16, 0.95, 0.95, 0.18, "tint", skip="bot")
    parapet(p, 2.0, 2.0, 0.16, 0.1, 0.05, "trim")
    p.bbox(-0.55, -0.35, 0.18, 0.55, 0.6, 0.6, "metal", b=0.02)
    with p.face("s", 1.1, 0.95, cy=0.125) as (fw, hd):
        for i in range(5):
            z = 0.26 + i * 0.065
            p.quad_s(-0.45, z, 0.45, z + 0.025, -hd - 0.01, "frame")
    p.bar((0.7, 0.7, 0.18), (0.7, 0.7, 0.9), 0.03, "metal")
    p.bar((0.62, 0.7, 0.55), (0.78, 0.7, 0.55), 0.02, "metal")
    p.boxc(0.7, 0.7, 0.9, 0.045, 0.045, 0.045, "red", skip="bot")
    for x in (-0.55, -0.15, 0.25):
        ac_unit(p, x, -0.7, 0.18, w=0.3, d=0.22, h=0.14)
    vent_stack(p, -0.75, 0.75, 0.18)


# ---- megatower 2.4 x 2.4 ---------------------------------------------------------------------------
MT_CH = 0.5


def _mt_fins(p, half, ch, z0, z1, depth=0.09, w=0.1, mids=True):
    pts = oct_pts(half, ch)
    locs = []
    for i in range(8):
        a, b = Vector(pts[i]), Vector(pts[(i + 1) % 8])
        locs.append(a)
        if mids and (b - a).length > 1.0:
            locs.append(a.lerp(b, 1 / 3))
            locs.append(a.lerp(b, 2 / 3))
    for v in locs:
        ang = math.degrees(math.atan2(v.y, v.x)) + 90
        with p.at(v.x, v.y, 0, rz=ang):
            p.box(-w / 2, -depth, z0, w / 2, 0.06, z1, "trim", skip="top bot n")


@part("megatower_base", "megatower", h=1.0)
def _(p):
    oct_prism(p, 1.2, MT_CH, 0, 0.12, "dark", top="dark")
    oct_prism(p, 1.1, MT_CH * 0.92, 0.12, 1.0, "stone")
    _mt_fins(p, 1.1, MT_CH * 0.92, 0.12, 1.0)
    with p.face("s", 2.2, 2.2) as (fw, hd):
        p.quad_s(-0.38, 0.12, 0.38, 0.86, -hd - 0.01, "frame")
        p.quad_s(-0.32, 0.12, 0.32, 0.8, -hd - 0.02, "glass")
        p.bbox(-0.5, -hd - 0.3, 0.84, 0.5, -hd, 0.9, "trim", b=0.015, bottom=True)
    for side in "enw":
        with p.face(side, 2.2, 2.2) as (fw, hd):
            p.quad_s(-0.3, 0.3, 0.3, 0.86, -hd - 0.012, "glass")


@part("megatower_floor", "megatower")
def _(p):
    oct_prism(p, 1.2, MT_CH, 0, 0.06, "trim", top="trim")
    oct_prism(p, 1.12, MT_CH * 0.93, 0.06, 0.5, "glass")
    _mt_fins(p, 1.12, MT_CH * 0.93, 0.0, 0.5, depth=0.1)


@part("megatower_roof", "megatower")
def _(p):
    oct_prism(p, 1.24, MT_CH, 0, 0.14, "trim", top="trim")
    oct_prism(p, 0.98, MT_CH * 0.82, 0.14, 0.72, "glass")
    _mt_fins(p, 0.98, MT_CH * 0.82, 0.14, 0.72, depth=0.08, mids=False)
    oct_prism(p, 1.02, MT_CH * 0.84, 0.72, 0.8, "trim", top="trim")
    oct_prism(p, 0.76, MT_CH * 0.64, 0.8, 1.25, "glass")
    _mt_fins(p, 0.76, MT_CH * 0.64, 0.8, 1.25, depth=0.07, mids=False)
    oct_prism(p, 0.8, MT_CH * 0.66, 1.25, 1.32, "trim", top="trim")
    p.prism(8, 0.68, 1.32, 2.45, "glass", r1=0.1, top=False, bot=False, rot=math.pi / 8)
    for i in range(8):
        a = math.pi / 8 + i * math.pi / 4
        p.bar((math.cos(a) * 0.72, math.sin(a) * 0.72, 1.32), (math.cos(a) * 0.1, math.sin(a) * 0.1, 2.45),
              0.05, "trim", n=3)
    p.prism(8, 0.12, 2.45, 2.55, "metal", top=True, bot=False)
    p.bar((0, 0, 2.55), (0, 0, 3.15), 0.05, "metal")
    p.boxc(0, 0, 3.15, 0.06, 0.06, 0.06, "red")


# ==================================================================================================
# WHOLE BUILDINGS
# ==================================================================================================

@part("hall", "hall")
def _(p):
    p.bbox(-1.15, -0.95, 0, 1.15, 1.15, 0.15, "stone", b=0.02)
    p.box(-0.55, -1.15, 0, 0.55, -0.95, 0.05, "stone", skip="bot n")
    p.box(-0.55, -1.05, 0.05, 0.55, -0.95, 0.1, "stone", skip="bot n")
    p.box(-1.05, -0.55, 0.15, 1.05, 1.05, 1.0, "wall", skip="bot top")
    with p.face("s", 2.1, 1.6, cy=0.25) as (fw, hd):
        for x in (-0.85, -0.6, 0.6, 0.85):
            window_decal(p, x, 0.38, 0.13, 0.42, -hd)
    for side in "ewn":
        with p.face(side, 2.1, 1.6, cy=0.25) as (fw, hd):
            xs = (-0.5, 0.0, 0.5) if side != "n" else (-0.7, -0.35, 0.35, 0.7)
            for x in xs:
                p.quad_s(x - 0.07, 0.38, x + 0.07, 0.8, -hd - 0.012, "glass")
    p.box(-1.1, -0.6, 1.0, 1.1, 1.1, 1.08, "trim", skip="")
    p.hip(-1.07, -0.57, 1.07, 1.07, 1.08, 0.42, "tint", bottom=False)
    # portico
    for x in (-0.45, -0.15, 0.15, 0.45):
        column(p, x, -0.83, 0.15, 0.86, r=0.06)
    window_decal(p, 0, 0.15, 0.26, 0.45, -0.55, glass="frame", frame="trim")
    p.box(-0.62, -0.97, 0.86, 0.62, -0.5, 0.96, "trim", skip="")
    p.extrude([(-0.64, 0.96), (0.64, 0.96), (0, 1.28)], "y", -0.98, -0.52, [None, "tint", "tint"], cap="trim")
    p.poly([(-0.46, -0.986, 0.99), (0.46, -0.986, 0.99), (0, -0.986, 1.2)], "cream")
    # clock tower
    tx, ty = 0.0, 0.42
    p.box(tx - 0.3, ty - 0.3, 1.2, tx + 0.3, ty + 0.3, 2.62, "wall", skip="bot top")
    p.bbox(tx - 0.34, ty - 0.34, 1.98, tx + 0.34, ty + 0.34, 2.04, "trim", b=0.015, bottom=True)
    for side in "senw":
        with p.face(side, 0.6, 0.6, cx=tx, cy=ty) as (fw, hd):
            p.poly([(0.17 * math.cos(a), -hd - 0.01, 2.32 + 0.17 * math.sin(a))
                    for a in (math.pi / 8 + k * math.pi / 4 for k in range(8))], "trim")
            p.quad_s(-0.014, 2.31, 0.014, 2.45, -hd - 0.02, "frame")
            p.quad_s(-0.014, 2.306, 0.1, 2.334, -hd - 0.021, "frame")
    p.box(tx - 0.24, ty - 0.24, 2.62, tx + 0.24, ty + 0.24, 3.02, "frame", skip="bot top")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.boxc(tx + sx * 0.25, ty + sy * 0.25, 2.62, 0.1, 0.1, 0.4, "wall", skip="bot top")
    p.box(tx - 0.35, ty - 0.35, 2.58, tx + 0.35, ty + 0.35, 2.64, "trim", skip="")
    p.bbox(tx - 0.37, ty - 0.37, 3.02, tx + 0.37, ty + 0.37, 3.1, "trim", b=0.02, bottom=True)
    p.prism(4, 0.46, 3.1, 3.85, "tint", r1=0.0, cx=tx, cy=ty, rot=math.pi / 4, bot=False)
    p.bar((tx, ty, 3.8), (tx, ty, 4.08), 0.025, "metal")


@part("tollgate", "tollgate")
def _(p):
    for cx in (-0.8, 0.0, 0.8):
        p.box(cx - 0.14, -0.62, 0, cx + 0.14, 0.62, 0.07, "concrete", skip="bot")
        p.box(cx - 0.11, -0.2, 0.07, cx + 0.11, 0.2, 0.46, "wall", skip="bot top")
        with p.face("s", 0.22, 0.4, cx=cx) as (fw, hd):
            p.quad_s(-0.08, 0.2, 0.08, 0.4, -hd - 0.01, "glass")
        with p.face("n", 0.22, 0.4, cx=cx) as (fw, hd):
            p.quad_s(-0.08, 0.2, 0.08, 0.4, -hd - 0.01, "glass")
        for side in "ew":
            with p.face(side, 0.22, 0.4, cx=cx) as (fw, hd):
                p.quad_s(-0.14, 0.2, 0.14, 0.4, -hd - 0.01, "glass")
        p.bbox(cx - 0.14, -0.23, 0.46, cx + 0.14, 0.23, 0.5, "tint", b=0.01)
        for sy in (-0.45, 0.45):
            p.bar((cx, sy, 0.07), (cx, sy, 0.86), 0.06, "metal")
        if cx < 0.7:
            p.box(cx + 0.12, -0.36, 0.06, cx + 0.18, -0.3, 0.28, "hazard", skip="bot")
            for i in range(4):
                x0 = cx + 0.18 + i * 0.12
                p.box(x0, -0.345, 0.24, x0 + 0.12, -0.315, 0.27, "hazard" if i % 2 else "trim",
                      skip=("" if i in (0, 3) else "e w"))
    p.bbox(-1.2, -0.55, 0.86, 1.2, 0.55, 0.98, "trim", b=0.03, bottom=True)
    p.box(-1.18, -0.565, 0.89, 1.18, -0.55, 0.95, "tint", skip="top bot n")
    p.box(-1.18, 0.55, 0.89, 1.18, 0.565, 0.95, "tint", skip="top bot s")
    for cx in (-1.0, -0.4, 0.4, 1.0):
        p.poly([(cx - 0.15, -0.25, 0.855), (cx - 0.15, 0.25, 0.855), (cx + 0.15, 0.25, 0.855),
                (cx + 0.15, -0.25, 0.855)], "lamp")


@part("station", "station")
def _(p):
    p.bbox(-1.2, -0.62, 0, 1.2, 1.2, 0.08, "concrete", b=0.02)
    p.box(-1.2, -0.66, 0, 1.2, -0.62, 0.06, "trim", skip="bot n")
    p.box(-1.1, 0.55, 0.08, 1.1, 1.15, 0.72, "wall", skip="bot top")
    p.quad_s(-0.95, 0.12, 0.55, 0.6, 0.55 - 0.012, "glass")
    for x in (-0.55, -0.2, 0.15):
        p.quad_s(x - 0.012, 0.12, x + 0.012, 0.6, 0.55 - 0.02, "frame")
    p.quad_s(0.68, 0.08, 0.95, 0.55, 0.55 - 0.012, "frame")
    p.bbox(-1.15, 0.5, 0.72, 1.15, 1.2, 0.8, "trim", b=0.02, bottom=True)
    p.extrude([(-0.78, 0.86), (0.55, 0.8), (0.55, 0.85), (-0.8, 0.9)], "x", -1.18, 1.18, "tint", cap="trim")
    for x in (-0.9, -0.3, 0.3, 0.9):
        p.bar((x, -0.55, 0.08), (x, -0.55, 0.87), 0.05, "metal")
    p.box(-1.12, -0.58, 0.82, 1.12, -0.52, 0.86, "metal", skip="")
    for bx in (-0.6, 0.0, 0.6):
        p.box(bx - 0.2, 0.25, 0.16, bx + 0.2, 0.37, 0.19, "wood", skip="")
        p.box(bx - 0.2, 0.35, 0.19, bx + 0.2, 0.38, 0.3, "wood", skip="")
        for sx in (-1, 1):
            p.box(bx + sx * 0.16 - 0.015, 0.28, 0.08, bx + sx * 0.16 + 0.015, 0.34, 0.16, "frame", skip="top bot")
    p.bar((1.05, -0.4, 0.08), (1.05, -0.4, 0.62), 0.03, "frame")
    p.bbox(0.93, -0.43, 0.5, 1.17, -0.37, 0.66, "slate", b=0.01)


@part("substation", "substation")
def _(p):
    p.box(-1.1, -1.1, 0, 1.1, 1.1, 0.04, "concrete", skip="bot")
    for side in "senw":
        with p.face(side, 2.16, 2.16) as (fw, hd):
            xs = (-fw / 2,) if side != "s" else (-fw / 2, -0.35, 0.35)
            for x in xs:
                p.bar((x, -hd, 0.04), (x, -hd, 0.52), 0.04, "metal")
            spans = [(-fw / 2, fw / 2)] if side != "s" else [(-fw / 2, -0.35), (0.35, fw / 2)]
            for a, b in spans:
                for z in (0.22, 0.49):
                    p.bar((a, -hd, z), (b, -hd, z), 0.022, "metal", n=3)
    for cx in (-0.45, 0.45):
        p.box(cx - 0.24, 0.0, 0.04, cx + 0.24, 0.42, 0.5, "metal", skip="bot")
        p.box(cx - 0.26, -0.02, 0.46, cx + 0.26, 0.44, 0.52, "dark", skip="bot")
        p.box(cx - 0.18, -0.03, 0.1, cx + 0.18, 0.0, 0.4, "dark", skip="bot top n")
        for x in (-0.12, 0.12):
            p.prism(6, 0.035, 0.52, 0.76, "trim", cx=cx + x, cy=0.21, top=False, bot=False)
            p.prism(6, 0.055, 0.6, 0.62, "trim", cx=cx + x, cy=0.21, top=True, bot=False)
            p.prism(6, 0.055, 0.68, 0.7, "trim", cx=cx + x, cy=0.21, top=True, bot=False)
            p.prism(4, 0.03, 0.76, 0.8, "hazard", cx=cx + x, cy=0.21, bot=False)
    for x in (-0.95, 0.95):
        p.bar((x, 0.78, 0.04), (x, 0.78, 1.05), 0.06, "metal")
    p.bar((-1.0, 0.78, 1.02), (1.0, 0.78, 1.02), 0.05, "metal")
    for x in (-0.45, 0.45):
        p.prism(6, 0.03, 0.84, 1.0, "trim", cx=x, cy=0.78, top=False, bot=True)
    p.box(-0.95, -0.85, 0.04, -0.4, -0.45, 0.42, "wall", skip="bot top")
    p.quad_s(-0.85, 0.04, -0.68, 0.33, -0.86, "frame")
    p.bbox(-1.0, -0.9, 0.42, -0.35, -0.4, 0.47, "tint", b=0.015, bottom=True)


@part("shed", "shed")
def _(p):
    p.gable("x", -0.8, 0.25, -0.15, 0.65, 0.0, 0.5, 0.78, "wood", "tint", t=0.05, over=0.08)
    p.quad_s(-0.45, 0.0, -0.2, 0.42, -0.15 - 0.01, "trunk")
    p.quad_s(-0.05, 0.22, 0.13, 0.38, -0.15 - 0.01, "glass")
    cx, cy = 0.45, -0.4
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.bar((cx + sx * 0.2, cy + sy * 0.2, 0.0), (cx + sx * 0.17, cy + sy * 0.17, 0.62), 0.04, "metal")
    p.bar((cx - 0.2, cy - 0.2, 0.3), (cx + 0.2, cy - 0.2, 0.3), 0.025, "metal")
    p.prism(10, 0.3, 0.6, 1.02, "metal", cx=cx, cy=cy, top=False)
    p.prism(10, 0.305, 0.75, 0.78, "dark", cx=cx, cy=cy, top=False, bot=False)
    p.prism(10, 0.32, 1.02, 1.18, "metal", r1=0.05, cx=cx, cy=cy, bot=True)
    p.prism(6, 0.13, 0.0, 0.18, "wood", cx=-0.55, cy=-0.55, topk="trunk")


@part("tent", "tent")
def _(p):
    hw, y0, y1 = 0.65, -0.55, 0.75
    p.box(-hw, y0, 0, hw, y1, 0.48, "trim", skip="bot top")
    p.poly([(-0.25, y0 - 0.01, 0.0), (0.25, y0 - 0.01, 0.0), (0.0, y0 - 0.01, 0.42)], "frame")
    p.poly([(-0.3, y0 - 0.02, 0.0), (-0.22, y0 - 0.02, 0.0), (0.0, y0 - 0.02, 0.43)], "trim")
    p.poly([(0.22, y0 - 0.02, 0.0), (0.3, y0 - 0.02, 0.0), (0.0, y0 - 0.02, 0.43)], "trim")
    p.box(-hw - 0.03, y0 - 0.03, 0.4, hw + 0.03, y1 + 0.03, 0.5, "tint", skip="top")
    p.prism(4, (hw + 0.05) * math.sqrt(2), 0.5, 1.12, "trim", r1=0.0, cy=0.1, rot=math.pi / 4, bot=False)
    p.bar((0.78, -0.72, 0), (0.78, -0.72, 1.35), 0.03, "metal")
    for s in (0.0, 0.006):
        pts = [(0.78, -0.72 + s, 1.33), (0.78, -0.72 + s, 1.13), (0.78 - 0.38, -0.72 + s, 1.23)]
        p.poly(pts if s else pts[::-1], "tint")
    p.box(-0.7, -0.78, 0, -0.45, -0.6, 0.16, "wood", skip="bot")


@part("house", "house")
def _(p):
    p.box(-0.66, -0.46, 0, 0.66, 0.5, 0.08, "stone", skip="bot")
    p.gable("x", -0.62, 0.62, -0.42, 0.46, 0.08, 0.62, 1.0, "wall", "tint", t=0.06, over=0.12)
    p.box(0.25, 0.12, 0.7, 0.42, 0.29, 1.18, "stone", skip="bot")
    p.box(0.23, 0.1, 1.18, 0.44, 0.31, 1.23, "dark", skip="")
    with p.face("s", 1.24, 0.88, cy=0.02) as (fw, hd):
        p.quad_s(-0.1, 0.08, 0.1, 0.46, -hd - 0.01, "frame")
        for x in (-0.38, 0.38):
            window_decal(p, x, 0.26, 0.2, 0.2, -hd)
        p.extrude([(-hd - 0.18, 0.5), (-hd, 0.56), (-hd, 0.59), (-hd - 0.18, 0.53)], "x", -0.18, 0.18,
                  "tint", cap="tint")
    with p.face("n", 1.24, 0.88, cy=0.02) as (fw, hd):
        for x in (-0.3, 0.3):
            window_decal(p, x, 0.26, 0.2, 0.2, -hd)
    for side in "ew":
        with p.face(side, 1.24, 0.88, cy=0.02) as (fw, hd):
            window_decal(p, 0.0, 0.62, 0.14, 0.14, -hd)


@part("house2", "house2")
def _(p):
    ox = -0.05
    with p.at(ox, 0, 0):
        p.box(-0.78, -0.73, 0, 0.4, 0.78, 0.06, "stone", skip="bot")
        p.gable("x", -0.75, 0.38, 0.0, 0.75, 0.06, 0.6, 0.95, "wall", "tint", t=0.06, over=0.1)
        p.gable("y", -0.7, 0.05, -0.75, -0.2, 0.06, 0.58, 0.88, "wall", "tint", t=0.06, over=0.1)
        p.box(0.38, -0.35, 0, 0.88, 0.62, 0.48, "cream", skip="bot top")
        p.extrude([(-0.42, 0.48), (0.68, 0.53), (0.68, 0.58), (-0.42, 0.53)], "x", 0.36, 0.92,
                  ["trim", "tint", "tint", "trim"], cap="trim")
        p.quad_s(0.45, 0.0, 0.81, 0.38, -0.36, "metal")
        for z in (0.1, 0.2, 0.3):
            p.quad_s(0.45, z, 0.81, z + 0.012, -0.365, "dark")
        p.quad_s(0.02, 0.06, 0.2, 0.44, -0.01, "frame")
        window_decal(p, -0.475, 0.28, 0.22, 0.2, -0.7)
        with p.face("n", 1.13, 0.75, cx=-0.185, cy=0.375) as (fw, hd):
            for x in (-0.3, 0.25):
                window_decal(p, x, 0.28, 0.22, 0.2, -hd)
        with p.face("w", 0.55, 1.45, cx=-0.475, cy=0.025) as (fw, hd):
            for x in (-0.4, 0.35):
                window_decal(p, x, 0.28, 0.2, 0.2, -hd)


@part("shack", "shack")
def _(p):
    with p.at(0, 0, 0, rz=4):
        p.box(-0.5, -0.35, 0, 0.45, 0.4, 0.5, "metal", skip="bot top")
        p.quad_s(-0.48, 0.02, -0.12, 0.45, -0.36, "dirt")
        p.quad_s(0.05, 0.0, 0.3, 0.42, -0.37, "wood")
        p.quad_s(-0.38, 0.22, -0.2, 0.36, -0.37, "glass")
        p.poly([(-0.4, -0.375, 0.2), (-0.37, -0.375, 0.2), (-0.17, -0.375, 0.38), (-0.2, -0.375, 0.38)], "wood")
        with p.face("e", 0.95, 0.75, cx=-0.025, cy=0.025) as (fw, hd):
            p.quad_s(-0.3, 0.05, 0.15, 0.4, -hd - 0.01, "wood")
        p.extrude([(-0.5, 0.52), (0.52, 0.66), (0.52, 0.7), (-0.5, 0.56)], "x", -0.6, 0.55,
                  ["dark", "metal", "metal", "metal"], cap="metal")
        p.poly([(-0.1, -0.2, 0.592), (0.35, -0.2, 0.592), (0.35, 0.2, 0.647), (-0.1, 0.2, 0.647)], "dirt")
        p.bar((0.3, 0.25, 0.6), (0.3, 0.25, 0.92), 0.05, "hazard", n=6)
        p.prism(6, 0.13, 0.0, 0.32, "dirt", cx=0.62, cy=-0.25, topk="hazard")
        p.bbox(-0.68, -0.6, 0, -0.42, -0.36, 0.22, "wood", b=0.015)
        p.bar((0.62, 0.45, 0.0), (0.5, 0.42, 0.62), 0.04, "wood")


# ==================================================================================================
# NATURE
# ==================================================================================================

LEAF_ALT = {"leaf1": "leaf5", "leaf2": "leaf1", "leaf3": "leaf6", "leaf4": "leaf2", "leaf5": "leaf3",
            "leaf6": "leaf3", "pine1": "pine3", "pine2": "pine1", "pine3": "pine1"}


def leaf_shade(top, mid, bot, t=0.45, seed=None, var=0.3):
    """Key by facet normal (sunlit tops lighter, undersides darker). With a seed, ~var of the facets swap
    to a neighbouring green so canopies get a gentle, baked colour variation."""
    rng = random.Random(seed) if seed is not None else None

    def fn(f):
        k = top if f.normal.z > t else (bot if f.normal.z < -0.25 else mid)
        if rng is not None and rng.random() < var:
            k = LEAF_ALT.get(k, k)
        return k
    return fn


def trunk(p, h, r=0.08, key="trunk", n=6, x=0.0, y=0.0, lean=(0.0, 0.0)):
    p.prism(n, r, 0.0, h, key, r1=r * 0.75, cx=x, cy=y, ox=lean[0], oy=lean[1], top=False, bot=False)


def pine_tier(p, r, z0, z1, k_side, k_bot, rot, star=0.8, n=7, seed=None):
    if seed is None:
        p.prism(n, r, z0, z1, k_side, r1=0.0, rot=rot, star=star, botk=k_bot)
        return
    # per-facet variation: alternate ridge facets get the neighbouring green
    q = Part("_tier")
    q.prism(n, r, z0, z1, k_side, r1=0.0, rot=rot, star=star, botk=k_bot)
    rng = random.Random(seed)
    for f, k in zip(q.F, q.K):
        if k == k_side and rng.random() < 0.3:
            k = LEAF_ALT.get(k, k)
        p.poly([q.V[i] for i in f], k)


@part("tree_pine", "nature")
def _(p):
    trunk(p, 0.42, r=0.09)
    tiers = [(0.74, 0.3, 0.98, "pine2"), (0.62, 0.68, 1.36, "pine1"), (0.48, 1.04, 1.74, "pine3"),
             (0.32, 1.42, 2.12, "leaf2")]
    for i, (r, z0, z1, k) in enumerate(tiers):
        pine_tier(p, r, z0, z1, k, "pine2", rot=i * 0.45, seed=100 + i)


@part("tree_pine_tall", "nature")
def _(p):
    trunk(p, 0.6, r=0.09)
    tiers = [(0.64, 0.42, 1.15, "pine2"), (0.56, 0.86, 1.6, "pine2"), (0.48, 1.3, 2.05, "pine1"),
             (0.38, 1.74, 2.5, "pine1"), (0.27, 2.18, 3.15, "pine3")]
    for i, (r, z0, z1, k) in enumerate(tiers):
        pine_tier(p, r, z0, z1, k, "pine2", rot=i * 0.45, star=0.84, n=6, seed=110 + i)


@part("tree_round", "nature")
def _(p):
    trunk(p, 0.75, r=0.11, lean=(0.02, 0.01))
    p.bar((0.0, 0.0, 0.45), (0.26, 0.08, 0.85), 0.07, "trunk", n=4)
    # layered canopy: broad lower crown, offset upper crown, side tuft
    p.blob(0.0, 0.0, 1.3, 0.84, 0.8, 0.62, "leaf1", seed=3, keyfn=leaf_shade("leaf3", "leaf1", "leaf2", 0.55, seed=1),
           rot=0.3, sub=2, jit=0.07)
    p.blob(-0.12, -0.08, 1.86, 0.56, 0.54, 0.44, "leaf1", seed=11,
           keyfn=leaf_shade("leaf6", "leaf5", "leaf1", 0.5, seed=2), rot=2.0)
    p.blob(0.42, 0.24, 1.0, 0.42, 0.4, 0.34, "leaf1", seed=7, keyfn=leaf_shade("leaf3", "leaf2", "leaf4", seed=3),
           rot=1.1)


@part("tree_round_small", "nature")
def _(p):
    trunk(p, 0.5, r=0.085)
    p.blob(0.0, 0.0, 0.92, 0.62, 0.6, 0.5, "leaf2", seed=5, keyfn=leaf_shade("leaf1", "leaf2", "leaf4", 0.55, seed=4),
           rot=0.7, sub=2, jit=0.07)
    p.blob(0.08, 0.05, 1.32, 0.38, 0.36, 0.3, "leaf2", seed=6, keyfn=leaf_shade("leaf6", "leaf1", "leaf2", 0.5, seed=5),
           rot=0.2)


@part("tree_birch", "nature")
def _(p):
    trunk(p, 1.35, r=0.06, key="birch", lean=(-0.03, 0.02))
    for z in (0.4, 0.82):
        p.prism(6, 0.062, z, z + 0.05, "hazard", r1=0.058, top=False, bot=False)
    p.bar((0.0, 0.0, 0.9), (0.2, -0.06, 1.25), 0.045, "birch")
    p.blob(0.0, 0.0, 1.78, 0.5, 0.48, 0.78, "leaf3", seed=21,
           keyfn=leaf_shade("leaf6", "leaf3", "leaf1", seed=6, var=0.35), rot=0.4, sub=2, jit=0.07)
    p.blob(0.24, -0.06, 1.3, 0.3, 0.28, 0.34, "leaf3", seed=23, keyfn=leaf_shade("leaf3", "leaf5", "leaf2", seed=7))


@part("bush", "nature")
def _(p):
    p.blob(0.0, 0.0, 0.24, 0.4, 0.38, 0.3, "leaf2", seed=31, keyfn=leaf_shade("leaf1", "leaf2", "leaf4", seed=8),
           sub=2, jit=0.07)
    p.blob(0.24, 0.08, 0.17, 0.25, 0.24, 0.2, "leaf2", seed=33, keyfn=leaf_shade("leaf6", "leaf5", "leaf2", seed=9))
    p.blob(-0.2, 0.1, 0.16, 0.24, 0.22, 0.18, "leaf2", seed=35, keyfn=leaf_shade("leaf3", "leaf1", "leaf4", seed=10))
    # a few blossoms
    rng = random.Random(12)
    for k in range(4):
        a = k * 1.7 + rng.uniform(-0.3, 0.3)
        e = math.radians(rng.uniform(40, 62))
        x, y, z = 0.4 * math.cos(e) * math.cos(a), 0.38 * math.cos(e) * math.sin(a), 0.24 + 0.3 * math.sin(e)
        col = ["pink", "petal", "trim", "pink"][k]
        with p.at(x, y, z - 0.02, rz=rng.uniform(0, 90)):
            p.prism(3, 0.07, 0.0, 0.05, col, r1=0.0, botk=col)


@part("rock", "nature")
def _(p):
    sh = lambda f: "concrete" if f.normal.z > 0.6 else ("rock" if f.normal.z > -0.2 else "dark")
    p.blob(0.0, 0.0, 0.1, 0.42, 0.34, 0.28, "rock", seed=44, jit=0.1, keyfn=sh, rot=0.4)
    p.blob(0.34, 0.18, 0.05, 0.2, 0.17, 0.15, "rock", seed=45, jit=0.12, keyfn=sh, rot=1.2)
    p.blob(-0.3, 0.22, 0.03, 0.13, 0.12, 0.09, "rock", seed=46, jit=0.12, keyfn=sh)


# ---- clouds (float above the city; origin at the bottom centre of the flat belly) ------------------
def cloud_shade(top, mid, bot):
    return lambda f: top if f.normal.z > 0.5 else (bot if f.normal.z < -0.5 else mid)


@part("cloud", "nature")
def _(p):
    sh = cloud_shade("cloud_top", "cloud_mid", "cloud_bot")
    #        cx     cy    z0    rx    ry    h
    puffs = [(0.0, 0.05, 0.0, 1.55, 1.4, 2.2),
             (-1.75, 0.1, 0.0, 1.25, 1.1, 1.45),
             (1.8, -0.1, 0.0, 1.3, 1.15, 1.6),
             (-0.6, -0.55, 0.0, 1.05, 0.9, 1.25),
             (0.75, 0.6, 0.0, 1.05, 0.88, 1.5)]
    for i, (cx, cy, z0, rx, ry, h) in enumerate(puffs):
        p.dome(cx, cy, z0, rx, ry, h, sh, n=7, rot=i * 0.9, seed=70 + i)


@part("rain_cloud", "nature")
def _(p):
    sh = cloud_shade("rain_top", "rain_mid", "rain_bot")
    puffs = [(0.0, 0.0, 0.0, 1.7, 1.5, 2.05),
             (-1.95, 0.1, 0.0, 1.45, 1.25, 1.5),
             (2.0, -0.05, 0.0, 1.5, 1.3, 1.6),
             (-0.65, 0.7, 0.0, 1.2, 0.85, 1.4),
             (0.75, -0.7, 0.0, 1.2, 0.85, 1.45)]
    for i, (cx, cy, z0, rx, ry, h) in enumerate(puffs):
        p.dome(cx, cy, z0, rx, ry, h, sh, n=7, rot=i * 1.1, seed=80 + i)


# ==================================================================================================
# VEHICLES (front = -Y)
# ==================================================================================================

def wheel(p, x, y, r, w, key="hazard", hub="metal"):
    with p.at(x, y, r, ry=90):
        outer_top = x > 0
        p.prism(8, r, -w / 2, w / 2, key, top=outer_top, bot=not outer_top, rot=0)
        if hub:     # flat hub-cap decal on the outer face (2 tris instead of a 10-tri boss)
            zc = (w / 2 + 0.006) if outer_top else (-w / 2 - 0.006)
            q = r * 0.48
            pts = [(-q, 0, zc), (0, -q, zc), (q, 0, zc), (0, q, zc)]
            p.poly(pts if outer_top else pts[::-1], hub)


def quad_on(p, c, u0, u1, v0, v1, key, off=0.005):
    """Decal on a planar quad c = (bl, br, tr, tl) (CCW seen from outside): bilinear sub-rect, pushed out."""
    bl, br, tr, tl = (Vector(v) for v in c)
    n = (br - bl).cross(tl - bl).normalized()

    def P(u, v):
        return (bl.lerp(br, u)).lerp(tl.lerp(tr, u), v) + n * off
    p.poly([tuple(P(u0, v0)), tuple(P(u1, v0)), tuple(P(u1, v1)), tuple(P(u0, v1))], key)


def sedan(p, body="tint", roof="tint", glass="carglass"):
    for x in (-0.232, 0.232):
        for y in (-0.31, 0.31):
            wheel(p, x, y, 0.105, 0.085)
    p.bbox(-0.265, -0.5, 0.075, 0.265, 0.5, 0.25, body, b=0.055)
    # cabin: body-coloured greenhouse with inset glass so the pillars read
    bx0, by0, bx1, by1, z0 = -0.228, -0.2, 0.228, 0.27, 0.25
    tx0, ty0, tx1, ty1, z1 = -0.185, -0.08, 0.185, 0.2, 0.4
    p.taper(bx0, by0, bx1, by1, z0, tx0, ty0, tx1, ty1, z1, body, skip="bot", top=roof)
    A, B, C, D = (bx0, by0, z0), (bx1, by0, z0), (bx1, by1, z0), (bx0, by1, z0)
    a, b, c, d = (tx0, ty0, z1), (tx1, ty0, z1), (tx1, ty1, z1), (tx0, ty1, z1)
    quad_on(p, (A, B, b, a), 0.07, 0.93, 0.1, 0.86, glass)                 # windshield
    quad_on(p, (C, D, d, c), 0.1, 0.9, 0.14, 0.84, glass)                  # rear window
    quad_on(p, (B, C, c, b), 0.08, 0.47, 0.12, 0.82, glass)                # east: u runs front -> rear
    quad_on(p, (B, C, c, b), 0.53, 0.9, 0.12, 0.82, glass)
    quad_on(p, (D, A, a, d), 0.53, 0.92, 0.12, 0.82, glass)                # west: u runs rear -> front
    quad_on(p, (D, A, a, d), 0.1, 0.47, 0.12, 0.82, glass)
    yf = -0.5 - 0.006
    p.quad_s(-0.225, 0.155, -0.12, 0.205, yf, "lamp")
    p.quad_s(0.12, 0.155, 0.225, 0.205, yf, "lamp")
    p.quad_s(-0.1, 0.13, 0.1, 0.19, yf, "frame")                            # grille
    with p.face("n", 0.53, 1.0) as (fw, hd):
        p.quad_s(-0.225, 0.165, -0.12, 0.21, -hd - 0.006, "taillight")
        p.quad_s(0.12, 0.165, 0.225, 0.21, -hd - 0.006, "taillight")
    p.box(-0.25, -0.525, 0.07, 0.25, -0.48, 0.125, "frame", skip="n bot")
    p.box(-0.25, 0.48, 0.07, 0.25, 0.525, 0.125, "frame", skip="s bot")


@part("car", "vehicles")
def _(p):
    sedan(p)


@part("van", "vehicles")
def _(p):
    for x in (-0.255, 0.255):
        for y in (-0.36, 0.38):
            wheel(p, x, y, 0.11, 0.09)
    p.bbox(-0.3, -0.42, 0.08, 0.3, 0.575, 0.6, "tint", b=0.05)
    p.bbox(-0.29, -0.575, 0.08, 0.29, -0.32, 0.34, "tint", b=0.05)
    p.taper(-0.27, -0.43, 0.27, -0.4, 0.34, -0.25, -0.38, 0.25, -0.36, 0.56, "carglass", skip="bot top n")
    for side in "ew":
        with p.face(side, 0.6, 1.15) as (fw, hd):
            u0, u1 = (-0.4, -0.15) if side == "e" else (0.15, 0.4)
            p.quad_s(u0, 0.36, u1, 0.54, -hd - 0.006, "carglass")
    p.quad_s(-0.25, 0.2, -0.15, 0.26, -0.575 - 0.006, "lamp")
    p.quad_s(0.15, 0.2, 0.25, 0.26, -0.575 - 0.006, "lamp")
    p.quad_s(-0.12, 0.17, 0.12, 0.27, -0.575 - 0.006, "frame")             # grille
    for side in "ew":                                                      # side door seam + rub strip
        with p.face(side, 0.6, 1.15) as (fw, hd):
            u0, u1 = (-0.4, 0.55) if side == "e" else (-0.55, 0.4)
            p.quad_s(u0, 0.2, u1, 0.235, -hd - 0.004, "frame")
    p.box(-0.28, 0.575, 0.08, 0.28, 0.61, 0.14, "frame", skip="s bot")      # rear bumper
    with p.face("n", 0.6, 1.15) as (fw, hd):
        p.quad_s(-0.005, 0.12, 0.005, 0.55, -hd - 0.006, "frame")
        p.quad_s(-0.26, 0.22, -0.2, 0.3, -hd - 0.006, "taillight")
        p.quad_s(0.2, 0.22, 0.26, 0.3, -hd - 0.006, "taillight")
    p.box(-0.28, -0.6, 0.08, 0.28, -0.56, 0.14, "frame", skip="n bot")


@part("truck", "vehicles")
def _(p):
    for x in (-0.29, 0.29):
        for y in (-0.55, 0.36, 0.62):
            wheel(p, x, y, 0.13, 0.11, hub=None)
    p.box(-0.22, -0.7, 0.12, 0.22, 0.82, 0.22, "frame", skip="")
    p.bbox(-0.33, -0.85, 0.13, 0.33, -0.36, 0.72, "wall", b=0.05)
    p.taper(-0.31, -0.86, 0.31, -0.84, 0.42, -0.29, -0.8, 0.29, -0.78, 0.68, "carglass", skip="bot top n")
    for side in "ew":
        with p.face(side, 0.66, 1.7) as (fw, hd):
            u0, u1 = (-0.82, -0.6) if side == "e" else (0.6, 0.82)
            p.quad_s(u0, 0.44, u1, 0.64, -hd - 0.006, "carglass")
    p.quad_s(-0.29, 0.22, -0.19, 0.28, -0.85 - 0.006, "lamp")
    p.quad_s(0.19, 0.22, 0.29, 0.28, -0.85 - 0.006, "lamp")
    p.box(-0.32, -0.88, 0.12, 0.32, -0.84, 0.2, "frame", skip="n bot")
    p.bbox(-0.35, -0.3, 0.22, 0.35, 0.85, 0.85, "tint", b=0.025, edges="v")
    p.quad_s(-0.15, 0.2, 0.15, 0.36, -0.85 - 0.006, "frame")                # grille
    with p.face("n", 0.7, 1.7) as (fw, hd):                                 # box doors + tail lamps
        p.quad_s(-0.006, 0.26, 0.006, 0.82, -hd - 0.005, "frame")
        for x in (-0.06, 0.06):
            p.quad_s(x - 0.008, 0.42, x + 0.008, 0.62, -hd - 0.006, "frame")
        p.quad_s(-0.3, 0.16, -0.22, 0.2, -hd - 0.006, "taillight")
        p.quad_s(0.22, 0.16, 0.3, 0.2, -hd - 0.006, "taillight")
    for side in "ew":                                                       # accent band on the box
        with p.face(side, 0.7, 1.7) as (fw, hd):
            u0, u1 = (-0.28, 0.83) if side == "e" else (-0.83, 0.28)
            p.quad_s(u0, 0.3, u1, 0.33, -hd - 0.004, "trim")


def tracks(p, x0, y0, y1, w=0.12, h=0.22):
    for sx in (-1, 1):
        xa, xb = sorted((sx * x0, sx * (x0 + w)))
        p.bbox(xa, y0, 0.0, xb, y1, h, "hazard", b=0.07, edges="all")
        with p.face("e" if sx > 0 else "w", 2 * (x0 + w), y1 - y0, cy=(y0 + y1) / 2) as (fw, hd):
            p.quad_s(-(y1 - y0) / 2 + 0.1, 0.06, (y1 - y0) / 2 - 0.1, 0.15, -hd - 0.004, "frame")


@part("bulldozer", "vehicles")
def _(p):
    tracks(p, 0.27, -0.4, 0.5, w=0.13)
    p.bbox(-0.27, -0.32, 0.17, 0.27, 0.45, 0.4, "yellow", b=0.03)
    p.bbox(-0.22, -0.34, 0.4, 0.22, 0.02, 0.5, "yellow", b=0.025)
    p.box(-0.21, 0.04, 0.4, 0.21, 0.42, 0.66, "carglass", skip="bot top")
    p.box(-0.24, 0.0, 0.66, 0.24, 0.46, 0.7, "yellow", skip="")
    for sx in (-1, 1):
        p.box(sx * 0.21 - 0.02, 0.4, 0.4, sx * 0.21 + 0.02, 0.44, 0.66, "yellow", skip="top bot")
    p.bar((0.12, -0.15, 0.48), (0.12, -0.15, 0.68), 0.04, "hazard", n=4)
    p.extrude([(-0.6, 0.02), (-0.5, 0.02), (-0.52, 0.18), (-0.47, 0.33), (-0.55, 0.34), (-0.62, 0.2)],
              "x", -0.4, 0.4, ["hazard", "yellow", "yellow", "yellow", "yellow", "yellow"], cap="yellow")
    for sx in (-1, 1):
        p.bar((sx * 0.3, -0.5, 0.15), (sx * 0.3, -0.05, 0.22), 0.05, "dark")
    p.bar((0, -0.5, 0.22), (0, -0.3, 0.35), 0.06, "metal")


@part("excavator", "vehicles")
def _(p):
    tracks(p, 0.26, -0.45, 0.6, w=0.14)
    p.prism(8, 0.22, 0.2, 0.25, "dark", cy=0.1, bot=False, top=False)
    p.bbox(-0.33, -0.2, 0.25, 0.33, 0.55, 0.47, "yellow", b=0.03)
    p.box(-0.33, 0.45, 0.24, 0.33, 0.7, 0.45, "dark", skip="bot")
    p.box(-0.33, -0.32, 0.52, -0.06, 0.08, 0.76, "carglass", skip="bot top")
    p.box(-0.35, -0.34, 0.76, -0.04, 0.1, 0.8, "yellow", skip="")
    p.box(-0.33, -0.32, 0.47, -0.06, 0.08, 0.52, "yellow", skip="top")
    p.box(0.05, 0.22, 0.47, 0.3, 0.42, 0.58, "yellow", skip="bot")
    p.bar((0.22, 0.3, 0.58), (0.22, 0.3, 0.7), 0.035, "hazard", n=4)
    # boom + stick + bucket (raised), crisp side profiles extruded across X
    bx0, bx1 = 0.04, 0.16
    p.extrude([(-0.08, 0.36), (-0.02, 0.48), (-0.36, 0.8), (-0.5, 0.82), (-0.55, 0.74), (-0.42, 0.68)],
              "x", bx0, bx1, "yellow", cap="yellow")
    p.extrude([(-0.47, 0.8), (-0.55, 0.75), (-0.66, 0.36), (-0.6, 0.34)], "x", bx0 + 0.015, bx1 - 0.015,
              "yellow", cap="yellow")
    p.bar((bx1 + 0.012, -0.08, 0.4), (bx1 + 0.012, -0.36, 0.7), 0.03, "metal", n=4)
    p.extrude([(-0.7, 0.26), (-0.58, 0.28), (-0.55, 0.42), (-0.64, 0.46), (-0.72, 0.4)], "x", 0.0, 0.2,
              ["hazard", "yellow", "yellow", "yellow", "yellow"], cap="yellow")


@part("inspector", "vehicles")
def _(p):
    sedan(p, body="trim", roof="trim")
    for side in "ew":
        with p.face(side, 0.53, 1.0) as (fw, hd):
            p.quad_s(-0.46, 0.15, 0.46, 0.19, -hd - 0.006, "frame")
    p.box(-0.16, 0.0, 0.401, 0.0, 0.1, 0.47, "red", skip="bot")
    p.box(0.0, 0.0, 0.401, 0.16, 0.1, 0.47, "blue", skip="bot")
    p.box(-0.17, 0.02, 0.401, 0.17, 0.08, 0.44, "frame", skip="bot top")


@part("police", "vehicles")
def _(p):
    sedan(p, body="trim", roof="trim")
    for side in "ew":                                  # navy doors, both sides
        with p.face(side, 0.53, 1.0) as (fw, hd):
            p.quad_s(-0.2, 0.095, 0.22, 0.238, -hd - 0.004, "navy")
    p.poly([(-0.085, -0.46, 0.2505), (0.085, -0.46, 0.2505), (0.085, -0.2, 0.2505), (-0.085, -0.2, 0.2505)],
           "navy")                                     # hood stripe
    p.poly([(-0.085, 0.29, 0.2505), (0.085, 0.29, 0.2505), (0.085, 0.47, 0.2505), (-0.085, 0.47, 0.2505)],
           "navy")                                     # trunk stripe
    # push bar
    p.box(-0.17, -0.55, 0.08, 0.17, -0.525, 0.17, "hazard", skip="bot n")
    # light bar: LEFT (+X, driver side) red, RIGHT (-X) blue; both _GLOW, _SIREN = +1 / -1
    p.box(-0.175, -0.0, 0.4, 0.175, 0.1, 0.418, "hazard", skip="bot")
    p.box(0.008, 0.008, 0.418, 0.165, 0.092, 0.462, "siren_r", skip="bot w")
    p.box(-0.165, 0.008, 0.418, -0.008, 0.092, 0.462, "siren_b", skip="bot e")
    p.box(-0.008, 0.02, 0.418, 0.008, 0.08, 0.455, "hazard", skip="bot s n")


# ==================================================================================================
# CONSTRUCTION & INFRASTRUCTURE
# ==================================================================================================

@part("crane_mast", "construction")
def _(p):
    h = 0.22
    C = [(-h, -h), (h, -h), (h, h), (-h, h)]
    for x, y in C:
        p.bar((x, y, 0.0), (x, y, 1.0), 0.055, "yellow")
    for i in range(4):
        (xa, ya), (xb, yb) = C[i], C[(i + 1) % 4]
        p.bar((xa, ya, 0.025), (xb, yb, 0.025), 0.035, "yellow")
        if i % 2 == 0:
            p.bar((xa, ya, 0.03), (xb, yb, 0.97), 0.03, "yellow")
        else:
            p.bar((xb, yb, 0.03), (xa, ya, 0.97), 0.03, "yellow")


@part("crane_top", "construction")
def _(p):
    p.prism(8, 0.3, 0.0, 0.12, "dark", bot=True)
    p.bbox(-0.32, -0.32, 0.12, 0.32, 0.32, 0.22, "yellow", b=0.02, bottom=True)
    p.box(0.24, -0.5, 0.22, 0.6, -0.12, 0.52, "yellow", skip="bot", s="glass", w="glass")
    for x, y in ((-0.2, -0.2), (0.2, -0.2), (0.2, 0.2), (-0.2, 0.2)):
        p.bar((x, y, 0.22), (0, 0, 1.6), 0.045, "yellow", n=4)
    # jib: triangular lattice along -Y
    L0, L1 = -0.2, -6.0
    zb, zt = 0.24, 0.62
    p.bar((-0.17, L0, zb), (-0.08, L1, zb), 0.04, "yellow")
    p.bar((0.17, L0, zb), (0.08, L1, zb), 0.04, "yellow")
    p.bar((0.0, L0, zt), (0.0, L1 + 0.1, zb + 0.08), 0.04, "yellow")
    nseg = 9
    for i in range(nseg):
        t0, t1 = i / nseg, (i + 1) / nseg
        ya, yb = L0 + (L1 - L0) * t0, L0 + (L1 - L0) * t1
        xa, xb = 0.17 - 0.09 * t0, 0.17 - 0.09 * t1
        za = zt + (zb + 0.08 - zt) * t0
        zbb = zt + (zb + 0.08 - zt) * t1
        top_a = (0.0, ya, za)
        top_b = (0.0, yb, zbb)
        if i % 2 == 0:
            p.bar((-xa, ya, zb), top_b, 0.025, "yellow", n=3)
            p.bar((xa, ya, zb), top_b, 0.025, "yellow", n=3)
        else:
            p.bar(top_a, (-xb, yb, zb), 0.025, "yellow", n=3)
            p.bar(top_a, (xb, yb, zb), 0.025, "yellow", n=3)
    # counter-jib along +Y
    for sx in (-1, 1):
        p.bar((sx * 0.2, 0.2, zb), (sx * 0.2, 2.2, zb), 0.05, "yellow")
    p.box(-0.2, 0.2, zb - 0.02, 0.2, 2.2, zb + 0.01, "metal", skip="")
    for i, y in enumerate((1.45, 1.7, 1.95)):
        p.box(-0.24, y, zb - 0.32, 0.24, y + 0.22, zb + 0.18, "concrete", skip="")
    p.bar((0, 0, 1.6), (0, -3.6, zt - 0.1), 0.02, "frame", n=3)
    p.bar((0, 0, 1.6), (-0.18, 2.15, zb + 0.02), 0.02, "frame", n=3)
    p.bar((0, 0, 1.6), (0.18, 2.15, zb + 0.02), 0.02, "frame", n=3)
    p.box(-0.12, -3.2, zb - 0.1, 0.12, -2.95, zb - 0.01, "dark", skip="")


@part("crane_hook", "construction")
def _(p):
    p.bar((-0.03, 0, 0.0), (-0.03, 0, -0.8), 0.015, "frame", n=3)
    p.bar((0.03, 0, 0.0), (0.03, 0, -0.8), 0.015, "frame", n=3)
    p.bbox(-0.09, -0.06, -0.96, 0.09, 0.06, -0.8, "yellow", b=0.02, bottom=True)
    p.box(-0.09, -0.061, -0.92, 0.09, 0.061, -0.88, "hazard", skip="top bot e w")
    p.bar((0, 0, -0.96), (0, 0, -1.04), 0.03, "metal")
    p.bar((0, 0, -1.04), (0.05, 0, -1.1), 0.028, "metal")
    p.bar((0.05, 0, -1.1), (0.02, 0, -1.15), 0.028, "metal")
    p.bar((0.02, 0, -1.15), (-0.04, 0, -1.11), 0.028, "metal")


@part("scaffold", "construction")
def _(p):
    h = 0.48
    C = [(-h, -h), (h, -h), (h, h), (-h, h)]
    for x, y in C:
        p.bar((x, y, 0.0), (x, y, 1.0), 0.03, "metal")
    for i in range(4):
        (xa, ya), (xb, yb) = C[i], C[(i + 1) % 4]
        for z in (0.5, 0.98):
            p.bar((xa, ya, z), (xb, yb, z), 0.022, "metal")
        if i % 2 == 0:
            p.bar((xa, ya, 0.02), (xb, yb, 0.48), 0.018, "metal", n=3)
    w = 0.12
    p.box(-0.5, -0.5, 0.47, 0.5, -0.5 + w, 0.495, "wood", skip="")
    p.box(-0.5, 0.5 - w, 0.47, 0.5, 0.5, 0.495, "wood", skip="")
    p.box(-0.5, -0.5 + w, 0.47, -0.5 + w, 0.5 - w, 0.495, "wood", skip="s n")
    p.box(0.5 - w, -0.5 + w, 0.47, 0.5, 0.5 - w, 0.495, "wood", skip="s n")


@part("foundation", "construction")
def _(p):
    o, i, zb = 1.2, 1.02, -0.4
    # rim (ground level) as a frame
    p.poly([(-o, -o, 0), (o, -o, 0), (i, -i, 0), (-i, -i, 0)], "dirt")
    p.poly([(o, -o, 0), (o, o, 0), (i, i, 0), (i, -i, 0)], "dirt")
    p.poly([(o, o, 0), (-o, o, 0), (-i, i, 0), (i, i, 0)], "dirt")
    p.poly([(-o, o, 0), (-o, -o, 0), (-i, -i, 0), (-i, i, 0)], "dirt")
    b = 0.9
    # pit walls (sloped, facing inward)
    walls = [((-i, -i), (i, -i), (b, -b), (-b, -b)), ((i, -i), (i, i), (b, b), (b, -b)),
             ((i, i), (-i, i), (-b, b), (b, b)), ((-i, i), (-i, -i), (-b, -b), (-b, b))]
    for (a0, a1, b1, b0) in walls:
        p.poly([(a0[0], a0[1], 0), (b0[0], b0[1], zb), (b1[0], b1[1], zb), (a1[0], a1[1], 0)], "trunk")
    p.poly([(-b, -b, zb), (b, -b, zb), (b, b, zb), (-b, b, zb)], "dirt")
    p.box(-0.72, -0.72, zb, 0.72, 0.72, zb + 0.1, "concrete", skip="bot")
    for sx in (-1, 1):
        p.box(-0.76, sx * 0.72 - 0.02, zb, 0.76, sx * 0.72 + 0.02, zb + 0.16, "wood", skip="bot")
        p.box(sx * 0.72 - 0.02, -0.7, zb, sx * 0.72 + 0.02, 0.7, zb + 0.16, "wood", skip="bot s n")
    for gx in (-0.5, -0.17, 0.17, 0.5):
        for gy in (-0.5, -0.17, 0.17, 0.5):
            p.bar((gx, gy, zb + 0.1), (gx, gy, zb + 0.34), 0.022, "frame", n=3)


@part("rubble", "construction")
def _(p):
    sh = lambda f: "concrete" if f.normal.z > 0.55 else ("dirt" if f.normal.z > -0.2 else "trunk")
    p.blob(0.0, 0.0, -0.02, 1.05, 0.9, 0.34, "concrete", seed=51, jit=0.2, keyfn=sh)
    rng = random.Random(7)
    keys = ["concrete", "stone", "wall", "cream", "dark", "concrete", "stone", "wall", "concrete", "cream"]
    for k in range(11):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(0.15, 0.95)
        x, y = math.cos(a) * rr, math.sin(a) * rr * 0.85
        s = rng.uniform(0.11, 0.22)
        z = max(0.03, 0.3 * (1 - rr * rr)) + s * 0.2
        with p.at(x, y, z, rz=rng.uniform(0, 90), rx=rng.uniform(-30, 30), ry=rng.uniform(-30, 30)):
            p.box(-s, -s * 0.75, -s * 0.45, s, s * 0.75, s * 0.45, keys[k % len(keys)], skip="")
    p.bar((-0.6, -0.4, 0.12), (0.0, -0.2, 0.42), 0.06, "frame")
    p.bar((0.0, -0.2, 0.42), (0.35, 0.3, 0.33), 0.06, "frame")
    p.bar((0.5, -0.6, 0.05), (0.8, 0.2, 0.28), 0.05, "metal")
    p.bar((-0.2, 0.5, 0.2), (-0.8, 0.7, 0.42), 0.03, "frame", n=3)


@part("cone", "construction")
def _(p):
    p.box(-0.09, -0.09, 0, 0.09, 0.09, 0.025, "orange", skip="bot")
    p.prism(8, 0.075, 0.025, 0.11, "orange", r1=0.056, top=False, bot=False)
    p.prism(8, 0.056, 0.11, 0.16, "trim", r1=0.044, top=False, bot=False)
    p.prism(8, 0.044, 0.16, 0.25, "orange", r1=0.014, bot=False)


@part("barrier", "construction")
def _(p):
    for sx in (-0.42, 0.42):
        p.bar((sx, -0.12, 0.0), (sx, 0.0, 0.48), 0.035, "frame")
        p.bar((sx, 0.12, 0.0), (sx, 0.0, 0.48), 0.035, "frame")
        p.box(sx - 0.04, -0.15, 0, sx + 0.04, 0.15, 0.03, "hazard", skip="bot")
    n = 5
    for i in range(n):
        x0 = -0.5 + i * (1.0 / n)
        p.box(x0, -0.035, 0.34, x0 + 1.0 / n, 0.0, 0.48, "orange" if i % 2 == 0 else "trim",
              skip="" if i in (0, n - 1) else "e w")


@part("streetlight", "construction")
def _(p):
    p.prism(6, 0.07, 0.0, 0.12, "frame", r1=0.055, bot=False, top=True)
    p.prism(6, 0.035, 0.12, 1.78, "frame", r1=0.026, top=False, bot=False)
    p.bar((0, 0.0, 1.74), (0, -0.42, 1.8), 0.03, "frame")
    p.taper(-0.07, -0.58, 0.07, -0.36, 1.72, -0.05, -0.55, 0.05, -0.39, 1.82, "frame", bot="lamp")


@part("sign_board", "construction")
def _(p):
    for x in (-0.68, 0.68):
        p.bbox(x - 0.04, -0.04, 0, x + 0.04, 0.04, 1.0, "metal", b=0.012)
    p.bbox(-0.8, -0.05, 0.42, 0.8, 0.02, 0.96, "slate", b=0.02, bottom=True)


@part("bridge_span", "construction")
def _(p):
    p.box(-4, -1.6, 0.0, 4, 1.6, 0.3, "concrete", skip="top")
    p.box(-4, -1.3, 0.3, 4, 1.3, 0.32, "dark", skip="bot")
    for sy in (-1, 1):
        y0, y1 = sorted((sy * 1.3, sy * 1.6))
        p.box(-4, y0, 0.3, 4, y1, 0.4, "concrete", skip="bot")
        yc = sy * 1.53
        p.bar((-4, yc, 0.72), (4, yc, 0.72), 0.06, "metal")
        p.bar((-4, yc, 0.56), (4, yc, 0.56), 0.035, "metal", n=3)
        for k in range(9):
            x = -3.9 + k * 0.975
            p.box(x - 0.03, yc - 0.03, 0.4, x + 0.03, yc + 0.03, 0.72, "metal", skip="top bot")
    for k in range(5):
        x = -3.2 + k * 1.6
        p.poly([(x - 0.3, -0.04, 0.322), (x + 0.3, -0.04, 0.322), (x + 0.3, 0.04, 0.322), (x - 0.3, 0.04, 0.322)],
               "trim")
    for sy in (-0.9, 0.9):
        p.box(-4, sy - 0.25, -0.35, 4, sy + 0.25, 0.0, "concrete", skip="top")


@part("bridge_pier", "construction")
def _(p):
    p.bbox(-0.4, -1.3, 0, 0.4, 1.3, 0.2, "concrete", b=0.03)
    p.bbox(-0.28, -0.95, 0.2, 0.28, 0.95, 2.72, "concrete", b=0.1, edges="v")
    p.bbox(-0.4, -1.3, 2.72, 0.4, 1.3, 3.0, "concrete", b=0.04, bottom=True)


@part("fountain", "construction")
def _(p):
    p.ring(8, 0.66, 0.8, 0.0, 0.24, "stone", inner="stone", topk="trim", rot=math.pi / 8)
    p.poly([(0.665 * math.cos(math.pi / 8 + k * math.pi / 4), 0.665 * math.sin(math.pi / 8 + k * math.pi / 4), 0.17)
            for k in range(8)], "water")
    p.prism(8, 0.12, 0.17, 0.62, "stone", r1=0.08, top=False, bot=False)
    p.prism(8, 0.34, 0.6, 0.68, "stone", r1=0.38, top=False, botk="stone")
    p.poly([(0.36 * math.cos(math.pi / 8 + k * math.pi / 4), 0.36 * math.sin(math.pi / 8 + k * math.pi / 4), 0.672)
            for k in range(8)], "water")
    p.prism(6, 0.06, 0.67, 0.86, "stone", r1=0.04, top=False, bot=False)
    p.prism(6, 0.09, 0.86, 1.02, "water", r1=0.0, bot=True)


@part("flowerbed", "construction")
def _(p):
    p.box(-0.5, -0.5, 0, 0.5, -0.42, 0.24, "stone", skip="bot")
    p.box(-0.5, 0.42, 0, 0.5, 0.5, 0.24, "stone", skip="bot")
    p.box(-0.5, -0.42, 0, -0.42, 0.42, 0.24, "stone", skip="bot s n")
    p.box(0.42, -0.42, 0, 0.5, 0.42, 0.24, "stone", skip="bot s n")
    p.poly([(-0.42, -0.42, 0.2), (0.42, -0.42, 0.2), (0.42, 0.42, 0.2), (-0.42, 0.42, 0.2)], "trunk")
    sh = leaf_shade("leaf3", "leaf1", "leaf2")
    p.blob(-0.18, 0.1, 0.25, 0.22, 0.2, 0.12, "leaf1", seed=61, keyfn=sh)
    p.blob(0.18, -0.12, 0.25, 0.22, 0.2, 0.12, "leaf1", seed=62, keyfn=sh)
    rng = random.Random(3)
    cols = ["pink", "petal", "trim", "lilac"]
    for k in range(10):
        x, y = rng.uniform(-0.33, 0.33), rng.uniform(-0.33, 0.33)
        z = 0.31 + rng.uniform(0, 0.05)
        with p.at(x, y, z, rz=rng.uniform(0, 90)):
            p.prism(4, 0.06, 0.0, 0.035, cols[k % 4], r1=0.0, rot=0, botk=cols[k % 4])


@part("smoke_stack", "construction")
def _(p):
    p.bbox(-0.3, -0.3, 0, 0.3, 0.3, 0.25, "concrete", b=0.03)
    p.prism(8, 0.25, 0.25, 3.0, "concrete", r1=0.17, top=False, bot=False)
    p.prism(8, 0.215, 2.0, 2.1, "dark", r1=0.21, top=False, bot=False)
    p.prism(8, 0.19, 2.82, 3.0, "hazard", r1=0.185, topk="hazard", bot=False)


@part("airport", "construction")
def _(p):
    p.box(-3.0, -2.0, 0, 3.0, 0.0, 0.02, "concrete", skip="bot")
    p.box(-2.8, 0.1, 0, 1.6, 1.7, 0.66, "wall", skip="bot top", s="glass")
    for x in (-2.2, -1.4, -0.6, 0.2, 1.0):
        p.box(x - 0.03, 0.06, 0, x + 0.03, 0.1, 0.66, "frame", skip="top bot n")
    p.extrude([(-0.15, 0.66), (1.85, 0.66), (1.85, 0.72), (1.2, 0.88), (0.4, 0.9), (-0.15, 0.76)],
              "x", -2.9, 1.7, ["trim", "trim", "tint", "tint", "tint", "trim"], cap="trim")
    p.box(-1.2, -0.7, 0.28, -0.95, 0.1, 0.52, "wall", skip="n")
    p.box(-1.25, -0.9, 0.0, -0.9, -0.7, 0.55, "wall", skip="bot")
    p.quad_s(-1.2, 0.34, -0.95, 0.48, -0.9 - 0.01, "glass")
    p.bar((-1.07, -0.6, 0.0), (-1.07, -0.6, 0.28), 0.05, "metal")
    tx, ty = 2.35, 0.9
    p.bbox(tx - 0.42, ty - 0.42, 0, tx + 0.42, ty + 0.42, 0.3, "wall", b=0.03)
    p.prism(8, 0.2, 0.3, 2.2, "wall", r1=0.16, cx=tx, cy=ty, top=False, bot=False)
    p.prism(8, 0.3, 2.2, 2.28, "trim", cx=tx, cy=ty, bot=True)
    p.prism(8, 0.3, 2.28, 2.55, "glass", r1=0.38, cx=tx, cy=ty, top=False, bot=False)
    p.prism(8, 0.4, 2.55, 2.7, "dark", r1=0.12, cx=tx, cy=ty, bot=True)
    p.bar((tx, ty, 2.7), (tx, ty, 3.05), 0.03, "metal")
    p.boxc(tx, ty, 3.05, 0.05, 0.05, 0.05, "red")
    for k in range(4):
        x = -2.4 + k * 1.3
        p.poly([(x, -1.3, 0.025), (x + 0.6, -1.3, 0.025), (x + 0.6, -1.24, 0.025), (x, -1.24, 0.025)], "yellow")


@part("plane", "construction")
def _(p):
    r = 0.17
    with p.at(0, 0, r):
        with p.at(rx=-90):
            p.prism(8, r, -1.0, 1.05, "trim", top=False, bot=False, rot=0)
            p.prism(8, r, 1.05, 1.48, "trim", r1=0.04, oy=-0.02, top=True, bot=False, rot=0)
            p.prism(8, r, -1.0, -1.5, "trim", r1=0.05, oy=0.1, top=True, bot=False, rot=0)
        p.taper(-0.13, -1.34, 0.13, -1.2, 0.02, -0.1, -1.29, 0.1, -1.18, 0.1, "carglass", skip="bot e w n top")
        for sx in (-1, 1):
            with p.face("e" if sx > 0 else "w", 2 * r * 0.93, 2.0) as (fw, hd):
                p.quad_s(-0.85, 0.04, 0.85, 0.075, -hd - 0.005, "carglass")
        for sx in (-1, 1):
            p.extrude([(sx * 0.12, -0.25), (sx * 1.45, 0.28), (sx * 1.45, 0.46), (sx * 0.12, 0.25)],
                      "z", -0.1, -0.06, "trim", cap="trim")
            with p.at(sx * 0.55, -0.05, -0.15, rx=-90):
                p.prism(6, 0.075, -0.1, 0.25, "metal", top=True, bot=True, topk="frame", botk="hazard")
            p.extrude([(sx * 0.03, 1.1), (sx * 0.55, 1.36), (sx * 0.55, 1.47), (sx * 0.03, 1.4)],
                      "z", 0.06, 0.09, "trim", cap="trim")
        p.extrude([(1.0, 0.1), (1.48, 0.12), (1.52, 0.62), (1.3, 0.62)], "x", -0.02, 0.02, "tint", cap="tint")


# ==================================================================================================
# Build, attributes, export
# ==================================================================================================

def tri_count(part):
    return sum(len(f) - 2 for f in part.F)


def make_mesh(part, name=None):
    name = name or part.name
    me = bpy.data.meshes.new(name)
    me.from_pydata(part.V, [], part.F)
    me.validate(clean_customdata=False)
    nl = sum(len(f) for f in part.F)
    cols, tints, glows, sirens = [], [], [], []
    for f, k in zip(part.F, part.K):
        h, t, g, sr = PAL[k]
        c = srgb(h)
        for _ in f:
            cols.extend((c[0], c[1], c[2], 1.0))
            tints.append(t)
            glows.append(g)
            sirens.append(sr)
    assert len(me.loops) == nl, (name, len(me.loops), nl)
    ca = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    ca.data.foreach_set("color_srgb", cols)
    me.attributes.new("_TINT", "FLOAT", "CORNER").data.foreach_set("value", tints)
    me.attributes.new("_GLOW", "FLOAT", "CORNER").data.foreach_set("value", glows)
    if any(sirens):     # only parts with a flashing light bar carry _SIREN (+1 red half, -1 blue half)
        me.attributes.new("_SIREN", "FLOAT", "CORNER").data.foreach_set("value", sirens)
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = me.color_attributes.find("Col")
    me.polygons.foreach_set("use_smooth", [False] * len(me.polygons))
    me.update()
    return me


def preview_material():
    m = bpy.data.materials.get("kit_preview")
    if m:
        return m
    m = bpy.data.materials.new("kit_preview")
    m.use_nodes = True
    m.use_backface_culling = True   # match three.js FrontSide so flipped faces show up in previews
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N.get("Principled BSDF")
    col = N.new("ShaderNodeAttribute"); col.attribute_name = "Col"
    tin = N.new("ShaderNodeAttribute"); tin.attribute_name = "_TINT"
    glo = N.new("ShaderNodeAttribute"); glo.attribute_name = "_GLOW"
    obj = N.new("ShaderNodeObjectInfo")
    sub = N.new("ShaderNodeVectorMath"); sub.operation = "SUBTRACT"; sub.inputs[1].default_value = (1, 1, 1)
    L.new(obj.outputs["Color"], sub.inputs[0])
    sc = N.new("ShaderNodeVectorMath"); sc.operation = "SCALE"
    L.new(sub.outputs[0], sc.inputs[0]); L.new(tin.outputs["Fac"], sc.inputs["Scale"])
    add = N.new("ShaderNodeVectorMath"); add.operation = "ADD"; add.inputs[1].default_value = (1, 1, 1)
    L.new(sc.outputs[0], add.inputs[0])
    mul = N.new("ShaderNodeVectorMath"); mul.operation = "MULTIPLY"
    L.new(col.outputs["Color"], mul.inputs[0]); L.new(add.outputs[0], mul.inputs[1])
    L.new(mul.outputs[0], bsdf.inputs["Base Color"])
    rough = N.new("ShaderNodeMath"); rough.operation = "MULTIPLY_ADD"
    L.new(glo.outputs["Fac"], rough.inputs[0]); rough.inputs[1].default_value = -0.5; rough.inputs[2].default_value = 0.85
    L.new(rough.outputs[0], bsdf.inputs["Roughness"])
    night = N.new("ShaderNodeValue"); night.name = "night"; night.outputs[0].default_value = 0.0
    em = N.new("ShaderNodeMath"); em.operation = "MULTIPLY"
    L.new(glo.outputs["Fac"], em.inputs[0]); L.new(night.outputs[0], em.inputs[1])
    L.new(mul.outputs[0], bsdf.inputs["Emission Color"])
    L.new(em.outputs[0], bsdf.inputs["Emission Strength"])
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.35
    return m


def build_kit():
    scene = bpy.context.scene
    scene.name = "Kit"
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    coll = bpy.data.collections.new("KIT")
    scene.collection.children.link(coll)
    mat = preview_material()
    report = []
    objs = {}
    for name, fn, group, h in PARTS:
        p = Part(name)
        fn(p)
        me = make_mesh(p)
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        if h is not None:
            ob["h"] = float(h)
        objs[name] = ob
        report.append((name, group, tri_count(p), h))
    return objs, report


def export_glb(objs):
    os.makedirs(os.path.dirname(GLB_OUT), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objs.values():
        ob.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(objs.values()))
    bpy.ops.export_scene.gltf(
        filepath=GLB_OUT, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_attributes=True, export_extras=True, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True,
        export_materials="NONE", export_cameras=False, export_lights=False, export_texcoords=False,
        export_normals=True, export_animations=False)


# ==================================================================================================
# Previews
# ==================================================================================================

def setup_render(scene, w, h, samples):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    ee = scene.eevee
    ee.taa_render_samples = samples
    for attr, val in (("use_raytracing", True), ("use_shadows", True), ("shadow_ray_count", 2),
                      ("shadow_step_count", 8), ("use_gtao", True), ("gtao_distance", 1.2),
                      ("fast_gi_distance", 2.0)):
        if hasattr(ee, attr):
            try:
                setattr(ee, attr, val)
            except Exception:
                pass
    vs = scene.view_settings
    vs.view_transform = "AgX"
    try:
        vs.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    vs.exposure = -0.1
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"


def setup_world(scene, strength=1.0):
    w = bpy.data.worlds.new(scene.name + "_world")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.62, 0.74, 0.92, 1)
    bg.inputs["Strength"].default_value = strength
    return w


def add_sun(scene, rot=(50, 0, -40), energy=4.0, angle=6.0, color=(1.0, 0.9, 0.76)):
    ld = bpy.data.lights.new(scene.name + "_sun", "SUN")
    ld.energy = energy
    ld.angle = math.radians(angle)
    ld.color = color
    if hasattr(ld, "shadow_softness_factor"):
        pass
    ob = bpy.data.objects.new(scene.name + "_sun", ld)
    ob.rotation_euler = [math.radians(a) for a in rot]
    scene.collection.objects.link(ob)
    return ob


def inst(scene, src, x=0.0, y=0.0, z=0.0, rz=0.0, s=None, color=None, coll=None):
    ob = bpy.data.objects.new(src.name + "_i", src.data)
    ob.location = (x, y, z)
    ob.rotation_euler = (0, 0, math.radians(rz))
    if s is not None:
        ob.scale = s
    if color is not None:
        ob.color = (*color, 1.0)
    (coll or scene.collection).objects.link(ob)
    return ob


def ground_obj(scene, part, name):
    me = make_mesh(part, name)
    me.materials.append(preview_material())
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


def stack(scene, objs, arch, floors, x, y, rz=0.0, color=None):
    b = objs[arch + "_base"]
    hb = b["h"]
    inst(scene, b, x, y, 0, rz, color=color)
    for i in range(floors):
        inst(scene, objs[arch + "_floor"], x, y, hb + i * 0.5, rz, color=color)
    inst(scene, objs[arch + "_roof"], x, y, hb + floors * 0.5, rz, color=color)


def hex_to_lin(h):
    return tuple(srgb_to_lin(c) for c in srgb(h))


# ---- contact sheet -----------------------------------------------------------------------------------

def render_contact(objs, report):
    scene = bpy.data.scenes.new("Contact")
    bpy.context.window.scene = scene if bpy.context.window else None
    setup_render(scene, TILE, TILE, 16 if FAST else 48)
    setup_world(scene, 0.4)
    add_sun(scene, rot=(48, 0, -150), energy=3.6, angle=4)
    g = Part("contact_ground")
    g.box(-500, -500, -0.6, 500, 500, -0.5, "g_paper", skip="bot")
    gob = ground_obj(scene, g, "contact_ground")
    cam_d = bpy.data.cameras.new("contact_cam")
    cam_d.type = "ORTHO"
    cam = bpy.data.objects.new("contact_cam", cam_d)
    scene.collection.objects.link(cam)
    scene.camera = cam
    d = Vector((-0.55, -1.0, 0.78)).normalized()
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()

    tiles = []
    stacks = [("landmark", 3), ("civic", 1), ("factory", 1), ("shop", 1), ("library", 1), ("warehouse", 1),
              ("prefab", 2), ("apartment", 3), ("office", 4), ("megatower", 6)]
    tri = {r[0]: r[2] for r in report}
    entries = []
    for arch, n in stacks:
        entries.append((f"{arch} (base+{n}+roof)", [(arch + "_base", 0)] +
                        [(arch + "_floor", objs[arch + "_base"]["h"] + i * 0.5) for i in range(n)] +
                        [(arch + "_roof", objs[arch + "_base"]["h"] + n * 0.5)]))
        for suf in ("_base", "_floor", "_roof"):
            entries.append((f"{arch}{suf}  {tri[arch + suf]}t", [(arch + suf, 0)]))
    for name, fn, group, h in PARTS:
        if any(name.endswith(s) for s in ("_base", "_floor", "_roof")):
            continue
        entries.append((f"{name}  {tri[name]}t", [(name, 0)]))

    tmp = os.path.join(PREVIEW_DIR, "_tiles")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    spacing = 40.0
    cols = 9
    rng = random.Random(2)
    car_cols = ["#C9D7E3", "#E7C7B8", "#BFD3C0", "#E9DFC4"]
    if FILTER:
        entries = [e for e in entries if any(f in e[0] for f in FILTER)]
    for idx, (label, items) in enumerate(entries):
        gx, gy = (idx % cols) * spacing, (idx // cols) * spacing
        placed = []
        for nm, z in items:
            placed.append(inst(scene, objs[nm], gx, gy, z))
        pts = [Vector(ob.location) + Vector(c) for ob in placed for c in ob.bound_box]
        below = any(nm in ("foundation", "crane_hook", "bridge_span") for nm, _ in items)
        gz = min(min(p.z for p in pts), 0.0) if below else 0.0
        gob.location = (0, 0, gz + 0.5 - 0.001)
        rot = cam.rotation_euler.to_matrix()
        right, up, fwd = rot.col[0], rot.col[1], -rot.col[2]
        us = [p.dot(right) for p in pts]
        vs = [p.dot(up) for p in pts]
        cu, cv = (min(us) + max(us)) / 2, (min(vs) + max(vs)) / 2
        ext = max(max(us) - min(us), max(vs) - min(vs))
        cam_d.ortho_scale = max(ext * 1.12, 0.6)
        center = sum(pts, Vector()) / len(pts)
        cf = center.dot(fwd)
        cam.location = right * cu + up * cv + fwd * cf - fwd * 60
        cam_d.clip_end = 200
        scene.render.filepath = os.path.join(tmp, f"{idx:03d}.png")
        bpy.ops.render.render(write_still=True, scene=scene.name)
        tiles.append((scene.render.filepath, label))
        for ob in placed:
            bpy.data.objects.remove(ob, do_unlink=True)
    # montage
    out = os.path.join(PREVIEW_DIR, "contact.png")
    cmd = ["magick", "montage"]
    for path, label in tiles:
        cmd += ["-label", label, path]
    font = "/System/Library/Fonts/Supplemental/Arial.ttf"
    cmd += ["-depth", "8", "-font", font, "-pointsize", "11", "-tile", f"{cols}x", "-geometry", "174x174+3+3",
            "-background", "#EFEDE7", "-fill", "#3a3f46", out]
    subprocess.run(cmd, check=True)
    subprocess.run(["magick", out, "-gravity", "north", "-background", "#EFEDE7", "-splice", "0x44",
                    "-font", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "-pointsize", "20",
                    "-fill", "#2F3A45", "-annotate", "+0+12",
                    f"HEX ATLAS city kit — {len(PARTS)} parts", "-depth", "8", out], check=True)
    if not FILTER:
        shutil.rmtree(tmp, ignore_errors=True)
    return out


# ---- vignette ----------------------------------------------------------------------------------------

def render_vignette(objs):
    scene = bpy.data.scenes.new("Vignette")
    setup_render(scene, 1600, 1000, 24 if FAST else 128)
    setup_world(scene, 0.85)
    add_sun(scene, rot=(50, 0, -140), energy=4.4, angle=4)
    O = objs
    rng = random.Random(11)

    # ---- ground: grass, roads, sidewalks, plazas
    g = Part("vig_ground")
    pit = (2.6 - 1.2, -1.2, 2.6 + 1.2, 1.2)

    def holed(x0, y0, x1, y1, z0, z1, key, hole=pit):
        hx0, hy0, hx1, hy1 = hole
        if x1 <= hx0 or x0 >= hx1 or y1 <= hy0 or y0 >= hy1:
            g.box(x0, y0, z0, x1, y1, z1, key, skip="bot")
            return
        for bx in ((x0, y0, hx0, y1), (hx1, y0, x1, y1), (hx0, y0, hx1, hy0), (hx0, hy1, hx1, y1)):
            if bx[2] - bx[0] > 1e-6 and bx[3] - bx[1] > 1e-6:
                g.box(bx[0], bx[1], z0, bx[2], bx[3], z1, key, skip="bot")
    holed(-60, -40, 60, 60, -0.1, 0.0, "g_grass")
    road_y = -3.0
    g.box(-60, road_y - 1.2, 0.0, 60, road_y + 1.2, 0.012, "g_road", skip="bot")
    for sy in (-1, 1):
        y0, y1 = sorted((road_y + sy * 1.2, road_y + sy * 1.75))
        g.box(-60, y0, 0.0, 60, y1, 0.05, "g_walk", skip="bot")
    for k in range(-30, 30):
        x = k * 1.6
        g.box(x, road_y - 0.04, 0.012, x + 0.8, road_y + 0.04, 0.016, "g_line", skip="bot")
    # cross street (north)
    cx0 = 0.0
    g.box(cx0 - 1.2, road_y + 1.75, 0.0, cx0 + 1.2, 30, 0.012, "g_road", skip="bot")
    for sx in (-1, 1):
        x0, x1 = sorted((cx0 + sx * 1.2, cx0 + sx * 1.75))
        g.box(x0, road_y + 1.75, 0.0, x1, 30, 0.05, "g_walk", skip="bot")
    for k in range(0, 18):
        y = road_y + 2.2 + k * 1.6
        g.box(cx0 - 0.04, y, 0.012, cx0 + 0.04, y + 0.8, 0.016, "g_line", skip="bot")
    # lot paving (district blocks)
    for (x0, x1) in ((-11.4, -1.75), (1.75, 11.4)):
        holed(x0, road_y + 1.75, x1, 6.6, 0.0, 0.03, "g_plaza")
    # plaza in front of hall across the road
    g.box(-7.3, -9.0, 0.0, -2.3, road_y - 1.75, 0.03, "g_plaza", skip="bot")
    # dirt patch around construction site
    g.box(3.75, 1.3, 0.0, 6.25, 3.9, 0.034, "g_dirt", skip="bot")
    # dirt track: spur off the main road, then east past the houses (police traffic stop scene)
    TY = -10.3
    g.box(0.5, TY - 0.5, 0.0, 1.5, road_y - 1.75, 0.02, "g_dirt", skip="bot")
    g.box(0.5, TY - 0.5, 0.0, 24.0, TY + 0.5, 0.02, "g_dirt", skip="bot")
    for o in (-0.24, 0.24):     # tyre ruts
        g.box(0.75 + o + 0.25 - 0.06, TY + 0.5, 0.02, 0.75 + o + 0.25 + 0.06, road_y - 1.75, 0.024, "dirt", skip="bot")
        g.box(1.5, TY + o - 0.06, 0.02, 24.0, TY + o + 0.06, 0.024, "dirt", skip="bot")
    ground_obj(scene, g, "vig_ground")

    # ---- buildings row 1 (y=0) & row 2 (y=2.6) & row 3 (y=5.2)
    R1, R2, R3 = 0.0, 2.55, 5.1
    W = [-10.0, -7.6, -5.0, -2.6]
    E = [2.6, 5.0, 7.6, 10.0]
    stack(scene, O, "shop", 1, W[0], R1, color=hex_to_lin("#E39A8C"))
    stack(scene, O, "shop", 2, W[1], R1, color=hex_to_lin("#8FB9D9"))
    inst(scene, O["hall"], W[2], R1)
    stack(scene, O, "apartment", 4, W[3], R1)
    stack(scene, O, "office", 6, E[1], R1)
    inst(scene, O["scaffold"], E[1], R1, 0, s=(2.25, 2.25, 2.6))
    stack(scene, O, "civic", 1, E[2], R1)
    stack(scene, O, "shop", 0, E[3], R1, color=hex_to_lin("#A9D19A"))

    stack(scene, O, "apartment", 6, W[0], R2)
    stack(scene, O, "landmark", 9, W[1], R2)
    stack(scene, O, "office", 12, W[2] + 0.1, R2 + 0.3)
    stack(scene, O, "prefab", 3, W[3], R2)
    stack(scene, O, "megatower", 18, E[0], R2 + 0.2)
    stack(scene, O, "warehouse", 1, E[2], R2)
    stack(scene, O, "factory", 1, E[3], R2)

    # construction site: pit + crane on the front lot, staging yard behind it
    inst(scene, O["foundation"], E[0], R1)
    mx, my = E[0] + 0.45, R1 + 0.45
    zb = -0.3
    for i in range(10):
        inst(scene, O["crane_mast"], mx, my, zb + i * 1.0)
    rz = 90.0
    inst(scene, O["crane_top"], mx, my, zb + 10.0, rz=rz)
    ca, sa = math.cos(math.radians(rz)), math.sin(math.radians(rz))
    jy = -3.08
    inst(scene, O["crane_hook"], mx - jy * sa, my + jy * ca, zb + 10.0 + 0.14)
    inst(scene, O["excavator"], E[0] - 0.25, R1 - 0.2, -0.3, rz=-35)
    inst(scene, O["rubble"], E[1] + 0.2, R2 + 0.3, 0.03, rz=20)
    inst(scene, O["bulldozer"], E[1] - 0.75, R2 - 0.2, 0.034, rz=-25)
    inst(scene, O["truck"], E[1] + 1.15, R2 - 0.35, 0.034, rz=170, color=hex_to_lin("#E9DFC4"))

    stack(scene, O, "apartment", 2, W[1], R3)
    stack(scene, O, "library", 2, W[2], R3)
    stack(scene, O, "office", 3, E[0], R3)
    inst(scene, O["station"], E[2], R3)
    inst(scene, O["substation"], E[3], R3)
    inst(scene, O["tent"], W[3], R3)
    inst(scene, O["shed"], W[0], R3)

    # ---- south of the road: plaza, fountain, park, houses
    inst(scene, O["fountain"], -4.8, -6.6)
    for x in (-6.6, -3.0):
        inst(scene, O["flowerbed"], x, -6.0)
    inst(scene, O["sign_board"], -9.0, -5.4, rz=0)
    houses = [("house", 3.4, -6.6, 0), ("house2", 6.2, -6.6, 0), ("house", 9.0, -6.8, 8),
              ("house2", 11.8, -6.4, -6), ("shack", 13.6, -8.6, 20)]
    for nm, x, y, r in houses:
        inst(scene, O[nm], x, y, rz=r, color=None)

    # streetlights
    for k in range(-5, 6):
        x = k * 2.6 + 1.3
        inst(scene, O["streetlight"], x, road_y + 1.55, rz=0)
        inst(scene, O["streetlight"], x + 1.3, road_y - 1.55, rz=180)
    # cars
    car_cols = [None, "#9FB8D6", "#E3A18E", "#B9D3B0", None, "#E9D58F", "#C7B8E0", None, "#8FB7B1"]
    lane_e, lane_w = road_y - 0.55, road_y + 0.55
    xs = [-12.5, -9.2, -6.4, -1.8, 3.0, 6.8, 9.5, 12.0]
    for i, x in enumerate(xs):
        nm = ["car", "van", "car", "truck", "car", "car", "van", "car"][i]
        col = car_cols[i % len(car_cols)]
        inst(scene, O[nm], x, lane_e, 0, rz=90, color=hex_to_lin(col) if col else None)
    for i, x in enumerate([-11.0, -7.8, -4.0, 1.5, 4.6, 8.2, 11.2]):
        nm = ["car", "car", "inspector", "van", "car", "truck", "car"][i]
        col = car_cols[(i + 3) % len(car_cols)]
        inst(scene, O[nm], x, lane_w, 0, rz=-90, color=hex_to_lin(col) if col else None)
    for i, y in enumerate([0.5, 4.2, 8.0]):
        inst(scene, O["car"], cx0 + 0.55, y, 0, rz=180, color=hex_to_lin(car_cols[(i + 1) % 9] or "#FFFFFF"))
    inst(scene, O["van"], cx0 - 0.55, 2.4, 0, rz=0, color=hex_to_lin("#E3A18E"))
    # construction gear on the sidewalk
    for k in range(4):
        inst(scene, O["cone"], E[0] - 1.0 + k * 0.55, road_y + 1.45, 0.05)
    inst(scene, O["barrier"], E[0] + 1.35, road_y + 1.45, 0.05)
    # traffic stop on the dirt track: red car pulled onto the shoulder, police cruiser behind it
    inst(scene, O["car"], 9.3, -10.62, 0.02, rz=84, color=hex_to_lin("#E0483E"))
    inst(scene, O["police"], 7.95, -10.55, 0.02, rz=80)
    inst(scene, O["cone"], 7.1, -10.85, 0.02)
    inst(scene, O["car"], 3.2, -10.08, 0.02, rz=-90, color=hex_to_lin("#E9D58F"))
    # weather
    inst(scene, O["cloud"], -12.0, 8.5, 8.0, rz=15)
    inst(scene, O["rain_cloud"], 17.0, 1.0, 8.5, rz=-20, s=(0.9, 0.9, 0.9))

    # ---- forest: dense outside the district, sparser park trees
    trees = ["tree_round", "tree_round", "tree_pine", "tree_pine", "tree_pine_tall", "tree_round_small",
             "tree_round_small", "tree_birch"]
    occupied = []

    def free(x, y, r):
        return all((x - ox) ** 2 + (y - oy) ** 2 > (r + orr) ** 2 for ox, oy, orr in occupied)

    def in_city(x, y):
        if -12.0 < x < 12.0 and road_y - 2.0 < y < 6.6:
            return True
        if -1.9 < x < 1.9 and y > road_y:
            return True
        if -7.6 < x < -2.0 and -9.2 < y < road_y:
            return True
        if 2.2 < x < 14.6 and -9.6 < y < -5.3:
            return True
        if 0.1 < x < 1.9 and -11.1 < y < road_y:          # dirt spur
            return True
        if 0.1 < x < 24.5 and -11.1 < y < -9.5:           # dirt track
            return True
        return False
    for i in range(6500):
        x, y = rng.uniform(-38, 38), rng.uniform(-16, 46)
        if in_city(x, y):
            continue
        r = 0.48
        if not free(x, y, r):
            continue
        dense = y > 6.8 or abs(x) > 12.5
        if not dense and rng.random() < 0.55:
            continue
        if y < -10.5 and rng.random() < 0.5:
            continue
        nm = rng.choice(trees) if dense else rng.choice(["tree_round", "tree_round_small", "tree_birch", "bush"])
        s = rng.uniform(0.85, 1.2)
        inst(scene, O[nm], x, y, 0, rz=rng.uniform(0, 360), s=(s, s, s * rng.uniform(0.95, 1.1)))
        occupied.append((x, y, r * s))
        if rng.random() < 0.15:
            bx, by = x + rng.uniform(-0.8, 0.8), y + rng.uniform(-0.8, 0.8)
            if not in_city(bx, by):
                inst(scene, O[rng.choice(["bush", "rock", "bush"])], bx, by, 0, rz=rng.uniform(0, 360))
    for x, y in ((-2.0, -7.6), (-7.0, -8.4), (-2.6, -5.6)):
        inst(scene, O["tree_round_small"], x, y, 0.03, rz=rng.uniform(0, 360))

    cam_d = bpy.data.cameras.new("vig_cam")
    cam_d.lens = 38
    cam_d.clip_end = 400
    cam = bpy.data.objects.new("vig_cam", cam_d)
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0.6, 1.8, 2.2))
    dist = 39.0
    if "--close" in ARGS:
        target, dist = Vector((float(ARGS[ARGS.index("--close") + 1]), float(ARGS[ARGS.index("--close") + 2]), 0.8)), 12.0
        scene.render.filepath = os.path.join(PREVIEW_DIR, "_close.png")
    pitch = math.radians(40)
    yaw = math.radians(-22)
    d = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    cam.location = target + d * dist
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    if "--close" not in ARGS:
        scene.render.filepath = os.path.join(PREVIEW_DIR, "vignette.png")
    bpy.ops.render.render(write_still=True, scene=scene.name)
    return scene.render.filepath


# ==================================================================================================

def main():
    objs, report = build_kit()
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    export_glb(objs)
    print("\nKIT REPORT")
    for name, group, tris, h in report:
        print(f"  {name:22s} {group:12s} {tris:5d} tris" + (f"  h={h}" if h is not None else ""))
    print(f"  total parts: {len(report)}; glb: {os.path.getsize(GLB_OUT)} bytes")
    if not NO_PREVIEWS:
        if ONLY in (None, "contact"):
            render_contact(objs, report)
        if ONLY in (None, "vignette"):
            render_vignette(objs)
    bpy.context.preferences.filepaths.save_version = 0   # no kit.blend1 backups
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)


main()
