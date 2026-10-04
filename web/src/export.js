// Export the current view as a presentation PNG or PDF (optionally plain background, info header, summary pages).
import { jsPDF } from 'jspdf'
import * as THREE from 'three'
import { GRADE } from './city/CityView.js'


// CSS2D labels are DOM, not canvas — repaint each visible label onto the export canvas: every nested
// background (signs, grade badges, pills) as a rounded box, then every text run on top
function drawLabels(ctx, s) {
  const layer = document.querySelector('.labels')
  if (!layer) return
  const clear = (c) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)'
  for (const el of layer.children) {
    if (el.style.display === 'none') continue
    const op = Math.min(1, parseFloat(el.style.opacity || getComputedStyle(el).opacity || '1'))
    if (op < 0.05) continue
    const r0 = el.getBoundingClientRect()
    if (r0.width < 1 || r0.right < 0 || r0.bottom < 0 || r0.left > innerWidth || r0.top > innerHeight) continue
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const cs = getComputedStyle(node)
      if (cs.display === 'none' || clear(cs.backgroundColor)) continue
      const r = node.getBoundingClientRect()
      ctx.globalAlpha = op * parseFloat(cs.opacity || '1')
      ctx.fillStyle = cs.backgroundColor
      ctx.beginPath()
      ctx.roundRect(r.left * s, r.top * s, r.width * s, r.height * s, (parseFloat(cs.borderTopLeftRadius) || 0) * s)
      ctx.fill()
    }
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const txt = n.textContent
      if (!txt.trim()) continue
      const pe = n.parentElement, ps = getComputedStyle(pe)
      if (ps.display === 'none') continue
      const range = document.createRange()
      range.selectNodeContents(n)
      const tr = range.getBoundingClientRect()
      ctx.globalAlpha = op
      ctx.fillStyle = ps.color
      ctx.font = `${ps.fontWeight} ${parseFloat(ps.fontSize) * s}px ${ps.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.fillText(txt.trim(), tr.left * s, (tr.top + tr.height / 2) * s)
    }
  }
  ctx.globalAlpha = 1
}

function seamLine(A) {
  const S = A.seams || []
  if (!S.length) return ''
  const bad = S.reduce((n, x) => n + x.unhandled.length, 0), dead = S.reduce((n, x) => n + x.dead.length, 0)
  return ` · seams ${S.length}${bad ? ` ✕${bad}` : ''}${dead ? ` ◌${dead}` : ''}`
}

// a clean title strip + legend in the city HUD's style
function drawHeader(ctx, W, H, s, A) {
  const sc = A.score
  const ink = '#1d2731', dim = '#6d7883'
  const f = (sz, w = 500) => `${w} ${sz * s}px -apple-system, 'SF Pro Text', Inter, system-ui, sans-serif`
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill() }
  const h = 64 * s
  ctx.fillStyle = 'rgba(252,250,246,0.95)'
  rr(14 * s, 14 * s, W - 28 * s, h, 14 * s)
  ctx.textBaseline = 'middle'
  const g = sc.withheld ? '?' : sc.grade
  ctx.fillStyle = GRADE[g] || dim
  rr(26 * s, 22 * s, 48 * s, 48 * s, 12 * s)
  ctx.fillStyle = '#fff'
  ctx.font = f(26, 800)
  ctx.textAlign = 'center'
  ctx.fillText(g, 50 * s, 47 * s)
  ctx.textAlign = 'left'
  ctx.fillStyle = ink
  ctx.font = f(17, 750)
  ctx.fillText(A.project.title, 88 * s, 37 * s)
  ctx.fillStyle = dim
  ctx.font = f(12)
  const worst = sc.worst ? ` · worst district ${sc.worst.label} ${sc.worst.grade}` : ''
  const tracks = A.violations.length
  ctx.fillText(`city rating ${sc.total}/100${worst} · ${A.modules.length} buildings · ${A.edges.length.toLocaleString()} cars · ${tracks} dirt roads${seamLine(A)}`, 88 * s, 57 * s)
  ctx.textAlign = 'right'
  ctx.fillText(`${A.project.branch || ''} ${A.project.sha || ''} · ${new Date().toISOString().slice(0, 10)}`, W - 30 * s, 37 * s)
  ctx.textAlign = 'left'
  // legend: zoning by tier + what the marks mean
  const items = [...A.tiers.map((t) => [t.color, t.label]), ['#b48a5e', 'dirt road = rule break'], ['#d65a4a', 'red roof = breaks a rule'], ['#f2c230', 'crane = uncommitted']]
  ctx.font = f(11.5, 600)
  let w = 24 * s
  for (const [, l] of items) w += ctx.measureText(l).width + 40 * s
  ctx.fillStyle = 'rgba(252,250,246,0.92)'
  rr(14 * s, H - 46 * s, Math.min(W - 28 * s, w), 32 * s, 10 * s)
  let x = 28 * s
  const y = H - 30 * s
  for (const [c, l] of items) {
    ctx.fillStyle = c
    rr(x, y - 6 * s, 12 * s, 12 * s, 3 * s)
    ctx.fillStyle = ink
    ctx.fillText(l, x + 18 * s, y)
    x += ctx.measureText(l).width + 40 * s
  }
}

function writeSummary(pdf, A, pw, ph) {
  const M = 40
  let y = M
  const line = (txt, { size = 9, bold = false, color = [31, 38, 48], gap = 13 } = {}) => {
    if (y > ph - M) { pdf.addPage([pw, ph], 'landscape'); y = M }
    pdf.setFont('courier', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    pdf.setTextColor(...color)
    pdf.text(String(txt).slice(0, 180), M, y)
    y += gap
  }
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
  const sc = A.score
  pdf.addPage([pw, ph], 'landscape')
  line(`SPRAWLER · ${A.project.title}`, { size: 16, bold: true, gap: 22 })
  line(`score ${sc.total}/100 [${sc.grade}] · confidence ${Math.round((sc.confidence ?? 1) * 100)}% · ${A.project.sha || ''} · ${new Date().toISOString().slice(0, 10)}`, { size: 10, gap: 22 })
  line('BOUNDED CONTEXTS (worst first)', { size: 11, bold: true, gap: 16 })
  line('grade  score  purity  tangle  mods  findings context', { color: [107, 101, 88] })
  for (const c of [...A.contexts].sort((a, b) => a.score - b.score)) {
    const v = c.crit + c.major + c.minor
    line(`${c.grade.padEnd(5)}  ${String(c.score).padStart(5)}  ${String(Math.round(c.purity * 100) + '%').padStart(6)}  ${String(Math.round(c.tangle * 100) + '%').padStart(6)}  ${String(c.modules).padStart(4)}  ${String(v).padStart(7)}  ${c.key}${c.nest ? '  NEST' : ''}`,
      { color: c.crit + c.major ? [192, 40, 61] : [31, 38, 48] })
  }
  y += 10
  line(`FINDINGS · ${A.violations.length}`, { size: 11, bold: true, gap: 16 })
  const SEV = { critical: '#c0283d', major: '#c0283d', minor: '#a8761a' }
  for (const v of A.violations) {
    line(`[${v.severity}] ${v.rule}  ${v.source}${v.line ? ':' + v.line : ''} → ${v.target}`, { color: hex(SEV[v.severity] || '#1f2630') })
  }
  if ((A.seams || []).length) {
    y += 10
    line('CONTRACT SEAMS (not scored)', { size: 11, bold: true, gap: 16 })
    for (const s of A.seams) {
      line(`${s.id.padEnd(10)} matched ${String(s.matched.length).padStart(3)}${s.unhandled.length ? `  UNHANDLED ${s.unhandled.join(',')}` : ''}${s.dead.length ? `  dead ${s.dead.join(',')}` : ''}${!s.unhandled.length && !s.dead.length ? '  in sync' : ''}`,
        { color: s.unhandled.length ? [192, 40, 61] : s.dead.length ? [168, 118, 26] : [46, 138, 87] })
      line(`           ${s.label}`, { color: [107, 101, 88] })
    }
  }
}

function download(href, name) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function exportView(o, { world, A }) {
  const { renderer, composer, scene, sky } = world
  const doc = document.body.classList.contains('doc')
  const pr = renderer.getPixelRatio()
  const s = o.scale || 2
  const saved = { sky: sky.visible, bg: scene.background, fogNear: scene.fog.near, fogFar: scene.fog.far }
  if (o.bg === 'plain') {
    // no sky, no haze: the city model on a clean sheet
    sky.visible = false
    scene.background = new THREE.Color(doc ? '#ffffff' : '#f5f1e8')
    scene.fog.near = 1e6; scene.fog.far = 2e6
  }
  const out = document.createElement('canvas')
  try {
    renderer.setPixelRatio(s)
    renderer.setSize(innerWidth, innerHeight)
    composer.setPixelRatio(s)
    composer.setSize(innerWidth, innerHeight)
    composer.render()
    out.width = renderer.domElement.width
    out.height = renderer.domElement.height
    out.getContext('2d').drawImage(renderer.domElement, 0, 0) // same task as render: no preserveDrawingBuffer needed
  } finally {
    sky.visible = saved.sky
    scene.background = saved.bg
    scene.fog.near = saved.fogNear; scene.fog.far = saved.fogFar
    renderer.setPixelRatio(pr)
    renderer.setSize(innerWidth, innerHeight)
    composer.setPixelRatio(pr)
    composer.setSize(innerWidth, innerHeight)
  }
  const ctx = out.getContext('2d')
  const W = out.width, H = out.height
  if (o.labels !== false) drawLabels(ctx, s)
  if (o.info) drawHeader(ctx, W, H, s, A)
  const name = `sprawler-${A.project.name}-${A.project.sha || 'wip'}-${new Date().toISOString().slice(0, 10)}`
  if (o.format === 'pdf') {
    const pw = 1200, ph = Math.round((1200 * H) / W)
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [pw, ph], compress: true })
    pdf.addImage(out.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, pw, ph)
    if (o.info) writeSummary(pdf, A, pw, ph)
    pdf.save(name + '.pdf')
    return { name: name + '.pdf', w: W, h: H, pages: pdf.getNumberOfPages() }
  }
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'))
  const url = URL.createObjectURL(blob)
  download(url, name + '.png')
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return { name: name + '.png', w: W, h: H, pages: 1 }
}
