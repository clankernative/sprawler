// ⌘K command palette: one box to jump anywhere (districts, buildings, quests, flows, bridges) and do
// anything (views, night, plan, export…). Fuzzy-ish matching, keyboard first.
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// subsequence match; contiguous runs and word starts score higher
function score(q, text) {
  if (!q) return 1
  const t = text.toLowerCase()
  const i = t.indexOf(q)
  if (i >= 0) return 100 - i + (i === 0 || /[\s/._-]/.test(t[i - 1]) ? 50 : 0)
  let p = 0, s = 0, run = 0
  for (const c of q) {
    const j = t.indexOf(c, p)
    if (j < 0) return 0
    run = j === p ? run + 1 : 0
    s += 1 + run
    p = j + 1
  }
  return s
}

function highlight(text, q) {
  if (!q) return esc(text)
  const i = text.toLowerCase().indexOf(q)
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length))
}

export class Palette {
  // sources: () => [{ group, icon, label, sub, kbd?, run }]
  constructor(sources) {
    this.sources = sources
    this.items = []
    this.sel = 0
    this.el = $('palette')
    this.el.innerHTML = `<div class="pal"><input id="palIn" placeholder="Jump to a district, building, quest, flow… or type a command" autocomplete="off" spellcheck="false"><div class="pl" id="palList"></div>
      <div class="pf"><span>↑↓ move</span><span>↵ open</span><span>esc close</span><span style="margin-left:auto">try “worst”, “night”, “export”</span></div></div>`
    this.input = $('palIn')
    this.input.addEventListener('input', () => { this.sel = 0; this.render() })
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'ArrowDown') { this.sel = Math.min(this.items.length - 1, this.sel + 1); this.render(); e.preventDefault() }
      else if (e.key === 'ArrowUp') { this.sel = Math.max(0, this.sel - 1); this.render(); e.preventDefault() }
      else if (e.key === 'Enter') this.pick(this.sel)
      else if (e.key === 'Escape') this.close()
    })
    this.el.addEventListener('mousedown', (e) => {
      const r = e.target.closest('[data-pi]')
      if (r) { e.preventDefault(); return this.pick(+r.dataset.pi) }
      if (e.target === this.el) this.close()
    })
    this.el.addEventListener('mousemove', (e) => {
      const r = e.target.closest('[data-pi]')
      if (r && +r.dataset.pi !== this.sel) { this.sel = +r.dataset.pi; this.render(true) }
    })
  }

  get isOpen() { return this.el.classList.contains('open') }

  open(q = '') {
    this.el.classList.add('open')
    this.input.value = q
    this.sel = 0
    this.render()
    setTimeout(() => this.input.focus(), 0)
  }

  close() { this.el.classList.remove('open'); this.input.blur() }

  render(keepScroll) {
    const q = this.input.value.trim().toLowerCase()
    const all = this.sources()
    let list
    if (!q) list = all.filter((x) => x.pin)
    else {
      list = all.map((x) => ({ x, s: Math.max(score(q, x.label), score(q, (x.keys || '')) * 0.9, score(q, x.sub || '') * 0.5) }))
        .filter((r) => r.s > 0).sort((a, b) => b.s - a.s || (a.x.rank || 0) - (b.x.rank || 0)).slice(0, 40).map((r) => r.x)
    }
    this.items = list
    let html = '', g = null
    list.forEach((x, i) => {
      if (x.group !== g) { g = x.group; html += `<div class="pg">${esc(g)}</div>` }
      html += `<div class="pi ${i === this.sel ? 'on' : ''}" data-pi="${i}"><i>${x.icon || '•'}</i><b>${highlight(x.label, q)}</b><small>${esc(x.sub || '')}</small>${x.kbd ? `<kbd>${esc(x.kbd)}</kbd>` : ''}</div>`
    })
    $('palList').innerHTML = html || '<div class="pg">nothing matches</div>'
    if (!keepScroll) $('palList').querySelector('.pi.on')?.scrollIntoView({ block: 'nearest' })
  }

  pick(i) {
    const x = this.items[i]
    if (!x) return
    this.close()
    setTimeout(() => x.run(), 0)
  }
}

// three-step tour on the first visit, pointing at the real interface
export function runTour(steps, done) {
  const el = $('coach')
  let k = 0
  const show = () => {
    const s = steps[k]
    const t = typeof s.target === 'function' ? s.target() : document.querySelector(s.target)
    const r = t ? t.getBoundingClientRect() : { left: innerWidth / 2 - 160, top: innerHeight / 2 - 120, width: 320, height: 240 }
    const pad = 8
    const hole = { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
    let tx = hole.left + hole.width + 16, ty = hole.top
    if (tx + 330 > innerWidth) tx = hole.left - 336
    if (tx < 10) { tx = Math.min(innerWidth - 340, hole.left); ty = hole.top + hole.height + 14 }
    ty = Math.max(12, Math.min(innerHeight - 190, ty))
    el.innerHTML = `<div class="hole" style="left:${hole.left}px;top:${hole.top}px;width:${hole.width}px;height:${hole.height}px"></div>
      <div class="tipc" style="left:${tx}px;top:${ty}px"><h4>${s.title}</h4><p>${s.body}</p><div class="row2"><span class="dots">${k + 1} of ${steps.length}</span><button data-c="skip">Skip</button><button class="go" data-c="next">${k === steps.length - 1 ? "Let's go" : 'Next'}</button></div></div>`
  }
  el.classList.add('open')
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish() } }
  const finish = () => { el.classList.remove('open'); el.innerHTML = ''; removeEventListener('keydown', onKey, true); done?.() }
  addEventListener('keydown', onKey, true)
  el.onclick = (e) => {
    const b = e.target.closest('[data-c]')
    if (!b) return
    if (b.dataset.c === 'next' && k < steps.length - 1) { k++; show() }
    else finish()
  }
  show()
}
