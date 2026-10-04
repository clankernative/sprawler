// Roads: asphalt ribbons with markings (highways get edge lines + double yellow), sidewalks along
// district streets, paved plazas, and dirt tracks — ragged scars where a violation cut through the woods.
import * as THREE from 'three'
import { ROAD } from './plan.js'
import { trackWidth } from './ground.js'

const CLS = { street: 0, outer: 1, spoke: 2, arterial: 3, connector: 4, ring: 5 }

// polyline → triangle strip: u across (−1 … 1), v = distance along
function ribbon(pts, w, closed, out, extra) {
  const n = pts.length
  if (n < 2) return
  const L = [0]
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = L[n - 1]
  const base = out.pos.length / 3
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]
    let tx = b[0] - a[0], tz = b[1] - a[1]
    if (closed && (i === 0 || i === n - 1)) { const p = pts[n - 2], q = pts[1]; tx = q[0] - p[0]; tz = q[1] - p[1] }
    const tl = Math.hypot(tx, tz) || 1
    const nx = -tz / tl, nz = tx / tl
    const hw = w / 2
    out.pos.push(pts[i][0] + nx * hw, 0, pts[i][1] + nz * hw, pts[i][0] - nx * hw, 0, pts[i][1] - nz * hw)
    out.uv.push(-1, L[i], 1, L[i])
    for (const [k, v] of Object.entries(extra)) out[k].push(v, v)
    out.len.push(closed ? -1 : total, closed ? -1 : total)
    if (i < n - 1) {
      const j = base + i * 2
      out.idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3)
    }
  }
}

function geom(out, keys) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3))
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(out.uv, 2))
  g.setAttribute('aLen', new THREE.Float32BufferAttribute(out.len, 1))
  for (const k of keys) g.setAttribute(k, new THREE.Float32BufferAttribute(out[k], 1))
  g.setIndex(out.idx)
  g.computeVertexNormals()
  // flat on the ground: normals straight up
  const nrm = g.attributes.normal
  for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0)
  return g
}

function patch(mat, uni, varyings, body, night = '') {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uni.uTime
    sh.uniforms.uNight = uni.uNight
    sh.uniforms.uDoc = uni.uDoc
    const attrs = varyings.map(([t, n]) => `attribute ${t} ${n}; varying ${t} v${n};`).join('\n')
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${attrs}\nvarying vec3 vRw;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${varyings.map(([, n]) => `v${n} = ${n};`).join(' ')}`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRw = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uTime; uniform float uNight; uniform float uDoc; varying vec3 vRw;
${varyings.map(([t, n]) => `varying ${t} v${n};`).join('\n')}
float rh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(rh(i), rh(i+vec2(1,0)), f.x), mix(rh(i+vec2(0,1)), rh(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${night}`)
  }
  // every patched material shares this function's source, so give each its own program
  let h = 0
  for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) | 0
  mat.customProgramCacheKey = () => 'road-' + h
}

export function buildRoads(plan, uni) {
  const group = new THREE.Group()
  // ── asphalt ──
  const A = { pos: [], uv: [], len: [], idx: [], aCls: [] }
  const SW = { pos: [], uv: [], len: [], idx: [], aCls: [] }
  for (const r of plan.roads) {
    const w = ROAD[r.cls]?.w ?? 2.4
    ribbon(r.pts, w, !!r.closed, A, { aCls: CLS[r.cls] ?? 0 })
    if (r.ctx && r.cls !== 'arterial') ribbon(r.pts, w + 1.3, !!r.closed, SW, { aCls: 0 })
  }
  const asphalt = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  patch(asphalt, uni, [['vec2', 'aUV'], ['float', 'aLen'], ['float', 'aCls']], `
    float u = vaUV.x, v = vaUV.y, cls = vaCls;
    float au = abs(u);
    vec3 c = mix(vec3(0.36, 0.38, 0.42), vec3(0.40, 0.42, 0.46), rn(vRw.xz * 1.3) * 0.6);
    float ends = vaLen < 0.0 ? 1.0 : smoothstep(2.5, 4.0, v) * smoothstep(2.5, 4.0, vaLen - v);
    float hw = 0.5 * (cls > 4.5 ? 4.2 : cls > 3.5 ? 3.6 : cls > 2.5 ? 3.0 : 2.3);
    float px = 0.07 / hw; // ~7cm line in u units
    float m = 0.0; vec3 mc = vec3(0.96, 0.96, 0.92);
    if (cls > 4.5) {
      // highway: solid edge lines, double yellow centre, dashed lane lines
      m = max(m, step(1.0 - 2.5 * px, au) * step(au, 1.0 - 0.8 * px));
      float dy = step(abs(au - 1.6 * px), px);
      if (dy > 0.5) { m = 1.0; mc = vec3(0.98, 0.78, 0.22); }
      m = max(m, step(abs(au - 0.52), px) * step(0.5, fract(v / 5.0)));
    } else if (cls > 2.5) {
      m = max(m, step(1.0 - 2.5 * px, au) * step(au, 1.0 - 0.8 * px) * 0.8);
      m = max(m, step(au, px) * step(0.45, fract(v / 4.0)));
    } else {
      m = max(m, step(au, px * 0.8) * step(0.55, fract(v / 3.0)) * 0.7);
    }
    c = mix(c, mc, m * ends * (1.0 - uDoc));
    c = mix(c, vec3(0.80, 0.80, 0.78), uDoc);
    diffuseColor.rgb = pow(c, vec3(2.2));`, `
    // street lamps every 11 units throw warm pools on the asphalt at night
    float pool = pow(max(0.0, 1.0 - abs(fract(vaUV.y / 11.0) - 0.5) * 2.6), 2.0) * (0.55 + 0.45 * (1.0 - abs(vaUV.x)));
    totalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * uNight * (0.05 + pool * 0.32);`)
  const road = new THREE.Mesh(geom(A, ['aCls']), asphalt)
  road.position.y = 0.06
  road.receiveShadow = true
  road.renderOrder = 2
  group.add(road)
  const walkMat = new THREE.MeshStandardMaterial({ color: '#d4cfc4', roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  patch(walkMat, uni, [['vec2', 'aUV']], `
    float seam = step(0.92, fract(vaUV.y / 1.2));
    diffuseColor.rgb *= 1.0 - seam * 0.06;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9), uDoc);`)
  const walk = new THREE.Mesh(geom(SW, []), walkMat)
  walk.position.y = 0.045
  walk.receiveShadow = true
  walk.renderOrder = 1
  group.add(walk)

  // ── plazas ──
  const plazaMat = new THREE.MeshStandardMaterial({ color: '#e6e0d2', roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  patch(plazaMat, uni, [], `
    vec2 p = vRw.xz;
    vec2 g = abs(fract(p / 1.4) - 0.5);
    float seam = step(0.46, max(g.x, g.y));
    diffuseColor.rgb *= 1.0 - seam * 0.07 - rn(floor(p / 1.4)) * 0.04;`)
  for (const d of plan.districts.values()) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(d.streets[0] + 0.2, 40).rotateX(-Math.PI / 2), plazaMat)
    m.position.set(d.x, 0.05, d.z)
    m.receiveShadow = true
    group.add(m)
  }

  // ── dirt: tracks between districts + trampled shortcuts inside them ──
  const D = { pos: [], uv: [], len: [], idx: [], aWip: [], aW: [] }
  for (const t of plan.tracks) ribbon(t.pts, trackWidth(t), false, D, { aWip: t.wip ? 1 : 0, aW: trackWidth(t) })
  const paths = new Map()
  for (const r of plan.routes) {
    if (!r) continue
    for (const p of r.pieces) {
      if (p.cls !== 'path') continue
      const k = p.pts.map((q) => q.map((x) => x.toFixed(1)).join(',')).sort().join('|')
      if (!paths.has(k)) paths.set(k, { pts: p.pts, n: 0 })
      paths.get(k).n++
    }
  }
  for (const p of paths.values()) {
    // shorten so the path starts at the building's door, not inside it
    const [a, b] = p.pts
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1
    const sh = Math.min(1.4, L * 0.3)
    const pts = [[a[0] + (dx / L) * sh, a[1] + (dz / L) * sh], [b[0] - (dx / L) * sh, b[1] - (dz / L) * sh]]
    const mid = [(pts[0][0] + pts[1][0]) / 2 + (-dz / L) * L * 0.08, (pts[0][1] + pts[1][1]) / 2 + (dx / L) * L * 0.08]
    ribbon([pts[0], mid, pts[1]], 0.75 + 0.25 * Math.log2(1 + p.n), false, D, { aWip: 0, aW: 0.8 })
  }
  const dirtMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  patch(dirtMat, uni, [['vec2', 'aUV'], ['float', 'aWip'], ['float', 'aW']], `
    float u = vaUV.x, v = vaUV.y;
    float edge = 0.72 + 0.28 * rn(vec2(v * 0.9, u > 0.0 ? 3.0 : 7.0));
    if (abs(u) > edge) discard;
    vec3 c = mix(vec3(0.60, 0.45, 0.30), vec3(0.70, 0.55, 0.38), rn(vRw.xz * 2.1));
    c = mix(c, vec3(0.78, 0.64, 0.46), vaWip * 0.6);
    // tyre ruts on wide tracks
    float rut = vaW > 1.8 ? (step(abs(abs(u) - 0.42), 0.09) * 0.16) : 0.0;
    c *= 1.0 - rut;
    c *= 0.92 + 0.08 * smoothstep(edge, edge - 0.25, abs(u));
    c = mix(c, vec3(0.86, 0.78, 0.68), uDoc);
    diffuseColor.rgb = pow(c, vec3(2.2));`)
  const dirt = new THREE.Mesh(geom(D, ['aWip', 'aW']), dirtMat)
  dirt.position.y = 0.035
  dirt.receiveShadow = true
  group.add(dirt)
  return { group, road, dirt }
}
