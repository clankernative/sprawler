// Route ribbons: when something is selected, its dependencies light up as glowing lanes along the real
// roads they drive — blue outbound, teal inbound, red where the route breaks a rule. Arrows flow in the
// direction of the dependency, so "who uses whom" reads without a legend.
import * as THREE from 'three'

const OUT = new THREE.Color('#3f7cff'), IN = new THREE.Color('#10b5a6'), BAD = new THREE.Color('#ef4a3c')
const MAX = 260

export class Ribbons {
  constructor(view) {
    this.view = view
    this.mesh = null
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: view.world.uni.uTime },
      transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      // the band keeps a minimum width on screen: wider in world units the further away the camera is
      vertexShader: /* glsl */ `
        attribute vec2 aUV; attribute vec3 aCol; attribute vec2 aSide; attribute float aW;
        varying vec2 vUV; varying vec3 vCol;
        void main(){
          vUV = aUV; vCol = aCol;
          vec4 wc = modelMatrix * vec4(position, 1.0);
          float d = distance(wc.xyz, cameraPosition);
          float hw = max(aW * 0.5, d * 0.0075);
          wc.xz += aSide * hw;
          gl_Position = projectionMatrix * viewMatrix * wc;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUV; varying vec3 vCol;
        void main(){
          float u = abs(vUV.x);
          // a navigation route: solid colour band, soft edge, white chevrons flowing toward the target
          float band = 1.0 - smoothstep(0.72, 1.0, u);
          float ch = fract(vUV.y * 0.16 - u * 0.35 - uTime * 0.8);
          float arrow = (smoothstep(0.0, 0.04, ch) - smoothstep(0.16, 0.22, ch)) * (1.0 - smoothstep(0.55, 0.8, u));
          vec3 c = mix(vCol * 1.5 + 0.05, vec3(1.0), arrow * 0.9);
          gl_FragColor = vec4(c, band * 0.88);
        }`,
    })
  }

  // edges: [edgeIndex, 'out' | 'in']
  show(edges) {
    this.clear()
    const P = this.view.plan, A = this.view.atlas
    if (!edges.length) return
    const pos = [], uv = [], col = [], idx = [], side = [], wid = []
    const seen = new Set()
    let n = 0
    for (const [i, dir] of edges) {
      if (n >= MAX) break
      const r = P.routes[i]
      if (!r) continue
      const c = A.edges[i].status === 'violation' ? BAD : dir === 'out' ? OUT : IN
      for (const piece of r.pieces) {
        // a shared piece (a highway stretch many cars use) is drawn once per direction
        const key = (piece.shared || piece.pts.length + ':' + piece.pts[0]) + dir + (c === BAD)
        if (seen.has(key)) continue
        seen.add(key)
        strip(piece.pts, piece.cls === 'ring' || piece.cls === 'dirt' ? 2.0 : 1.5, c, pos, uv, col, idx, side, wid)
      }
      n++
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2))
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3))
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 2))
    g.setAttribute('aW', new THREE.Float32BufferAttribute(wid, 1))
    g.setIndex(idx)
    this.mesh = new THREE.Mesh(g, this.mat)
    this.mesh.renderOrder = 6
    this.mesh.frustumCulled = false
    this.view.root.add(this.mesh)
  }

  clear() {
    if (!this.mesh) return
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh = null
  }
}

function strip(pts, w, c, pos, uv, col, idx, side, wid) {
  if (pts.length < 2) return
  const base = pos.length / 3
  let L = 0
  for (let i = 0; i < pts.length; i++) {
    if (i) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    const tx = b[0] - a[0], tz = b[1] - a[1], tl = Math.hypot(tx, tz) || 1
    const nx = -tz / tl, nz = tx / tl
    // both vertices sit on the centre line; the shader pushes them out to the on-screen width
    pos.push(pts[i][0], 0.14, pts[i][1], pts[i][0], 0.14, pts[i][1])
    side.push(nx, nz, -nx, -nz)
    wid.push(w, w)
    uv.push(-1, L, 1, L)
    col.push(c.r, c.g, c.b, c.r, c.g, c.b)
    if (i < pts.length - 1) { const j = base + i * 2; idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3) }
  }
}
