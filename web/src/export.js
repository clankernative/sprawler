// Export the current view as a presentation PNG or PDF (optionally plain background, info header, summary pages).
import { jsPDF } from 'jspdf'
import { GRADE } from './atlas.js'

const NIGHT = '#02050a'

// CSS2D labels are DOM, not canvas — redraw every visible text run onto the export canvas
function drawLabels(ctx, s) {
  const layer = document.querySelector('.labels')
  if (!layer) return
  for (const el of layer.children) {
    if (el.style.display === 'none') continue
    const cs = getComputedStyle(el)
    const op = Math.min(1, parseFloat(el.style.opacity || cs.opacity || '1'))
    if (op < 0.05) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue
    ctx.globalAlpha = op
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = cs.backgroundColor
      ctx.fillRect(r.left * s, r.top * s, r.width * s, r.height * s)
    }
    const bw = parseFloat(cs.borderTopWidth) || 0
    if (bw) {
      ctx.strokeStyle = cs.borderTopColor
      ctx.lineWidth = bw * s
      ctx.strokeRect(r.left * s, r.top * s, r.width * s, r.height * s)
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

function drawHeader(ctx, W, H, s, A, doc) {
  const sc = A.score
  const ink = doc ? '#1f2630' : '#cfe8ff', dim = doc ? '#6b6558' : '#6f89a6'
  const f = (sz, w = 400) => `${w} ${sz * s}px ui-monospace, 'SF Mono', Menlo, monospace`
  const h = 66 * s
  ctx.fillStyle = doc ? 'rgba(250,247,240,0.95)' : 'rgba(4,10,18,0.9)'
  ctx.fillRect(0, 0, W, h)
  ctx.fillStyle = doc ? 'rgba(31,38,48,.35)' : 'rgba(76,201,255,.45)'
  ctx.fillRect(0, h - s, W, s)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = GRADE[sc.grade] || ink
  ctx.font = f(42, 900)
  ctx.fillText(sc.grade, 18 * s, 50 * s)
  ctx.fillStyle = ink
  ctx.font = f(16, 800)
  ctx.fillText(`SPRAWLER · ${A.project.title}`, 70 * s, 28 * s)
  ctx.fillStyle = dim
  ctx.font = f(11)
  const worst = sc.worst ? ` · worst ${sc.worst.label} ${sc.worst.score} [${sc.worst.grade}]` : ''
  ctx.fillText(`score ${sc.total}/100${worst} · confidence ${Math.round((sc.confidence ?? 1) * 100)}% · ${A.modules.length} modules · ${sc.edges} deps · ${A.violations.length} findings${seamLine(A)}`, 70 * s, 48 * s)
  ctx.textAlign = 'right'
  ctx.fillText(`${A.project.sha || ''}  ${new Date().toISOString().slice(0, 10)}`, W - 18 * s, 28 * s)
  ctx.textAlign = 'left'
  // tier legend along the bottom
  let x = 18 * s
  const y = H - 16 * s
  ctx.fillStyle = doc ? 'rgba(250,247,240,0.85)' : 'rgba(4,10,18,0.75)'
  ctx.fillRect(0, H - 30 * s, W, 30 * s)
  ctx.font = f(10.5, 600)
  ctx.textBaseline = 'middle'
  for (const t of A.tiers) {
    ctx.fillStyle = t.color
    ctx.fillRect(x, y - 5 * s, 10 * s, 10 * s)
    ctx.fillStyle = ink
    ctx.fillText(t.label, x + 15 * s, y)
    x += (ctx.measureText(t.label).width + 38 * s)
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
  const { renderer, composer, scene, floor, stars } = world
  const doc = document.body.classList.contains('doc')
  const pr = renderer.getPixelRatio()
  const s = o.scale || 2
  const saved = { floor: floor.visible, stars: stars.visible, bg: scene.background.clone(), fog: scene.fog.color.clone() }
  if (o.bg === 'plain') {
    floor.visible = false
    stars.visible = false
    scene.background.set(doc ? '#ffffff' : NIGHT)
    scene.fog.color.copy(scene.background)
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
    floor.visible = saved.floor
    stars.visible = saved.stars
    scene.background.copy(saved.bg)
    scene.fog.color.copy(saved.fog)
    renderer.setPixelRatio(pr)
    renderer.setSize(innerWidth, innerHeight)
    composer.setPixelRatio(pr)
    composer.setSize(innerWidth, innerHeight)
  }
  const ctx = out.getContext('2d')
  const W = out.width, H = out.height
  if (o.labels !== false) drawLabels(ctx, s)
  if (o.info) drawHeader(ctx, W, H, s, A, doc)
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
