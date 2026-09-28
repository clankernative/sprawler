// Workspace setup: pick the platform, apps, instances and acceptance tests (auto-detected), then save + scan.
import { esc } from './hud.js'

const $ = (id) => document.getElementById(id)
let done = null, data = null, first = false, extra = []

export const setupOpen = () => document.body.classList.contains('setup')

export async function openSetup({ firstRun = false } = {}) {
  first = firstRun
  data = await (await fetch('/api/setup', { cache: 'no-store' })).json()
  extra = []
  render(data.config ? { ...data.config, where: data.where } : defaults(data))
  document.body.classList.add('setup')
  return new Promise((r) => { done = r })
}

function defaults(d) {
  const D = d.discovered
  return {
    name: d.root.split('/').pop(), title: '', platform: D.platform ?? '', where: 'user',
    apps: D.apps.map((a) => a.path), instances: D.instances.map((i) => i.path), tests: D.tests,
  }
}

function close(result) {
  document.body.classList.remove('setup')
  const r = done
  done = null
  r?.(result)
}

const box = (group, value, checked, label, sub = '') =>
  `<label class="srow"><input type="checkbox" data-g="${group}" value="${esc(value)}" ${checked ? 'checked' : ''}><span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`

function render(cfg) {
  const D = data.discovered
  const apps = [...new Set([...D.apps.map((a) => a.path), ...(cfg.apps || []), ...extra])]
  const ns = new Map(D.apps.map((a) => [a.path, a.namespace]))
  const insts = [...new Set([...D.instances.map((i) => i.path), ...(cfg.instances || [])])]
  const tests = [...new Set([...D.tests, ...(cfg.tests || [])])]
  const plats = [...new Set([...D.platforms, cfg.platform ?? ''].filter((p) => p !== undefined))]
  $('setup').innerHTML = `<div class="sbox">
    <h2>${first ? 'Set up this workspace' : 'Workspace settings'}</h2>
    <p class="sroot">${esc(data.root)}</p>
    <p class="snote">Everything below was detected automatically. Check it, fix anything that's wrong, then save. Nothing is written into your repos unless you choose the shared option.</p>
    ${data.legacy ? '<p class="swarn">This server was started with a legacy <code>--profile</code>. Saving here creates a workspace config and switches to it.</p>' : ''}
    <div class="ssec">Platform <small>the folder with <code>sdk/main.roc</code></small></div>
    ${plats.filter((p) => D.platforms.includes(p)).map((p) => `<label class="srow"><input type="radio" name="plat" value="${esc(p)}" ${p === cfg.platform ? 'checked' : ''}><span><b>${esc(p || '(workspace root)')}</b></span></label>`).join('') || '<p class="swarn">No platform found. Enter its folder below (relative to the workspace).</p>'}
    <input class="sin" id="sPlat" value="${esc(cfg.platform ?? '')}" placeholder="path to the platform folder, e.g. platform">
    <div class="ssec">Apps <small>folders with an <code>App.roc</code></small></div>
    ${apps.map((a) => box('apps', a, (cfg.apps || []).includes(a) || extra.includes(a), a, ns.get(a) ? `namespace ${ns.get(a)}` : 'added by hand')).join('') || '<p class="snote">No apps found.</p>'}
    <div class="sadd"><input class="sin" id="sAddApp" placeholder="add an app folder, e.g. apps/billing"><button data-act="addapp">Add</button></div>
    <div class="ssec">Instances <small>company bindings (<code>instance.json</code>)</small></div>
    ${insts.map((p) => { const i = D.instances.find((x) => x.path === p); return box('instances', p, (cfg.instances || []).includes(p), p, i ? `binds ${i.apps.join(', ') || 'nothing'}` : '') }).join('') || '<p class="snote">None found — that’s fine.</p>'}
    <div class="ssec">Acceptance tests <small>crates that test against the platform</small></div>
    ${tests.map((t) => box('tests', t, (cfg.tests || []).includes(t), t)).join('') || '<p class="snote">None found — that’s fine.</p>'}
    <div class="ssec">Name</div>
    <div class="sgrid"><input class="sin" id="sName" value="${esc(cfg.name || '')}" placeholder="short name"><input class="sin" id="sTitle" value="${esc(cfg.title || '')}" placeholder="title shown on the map (optional)"></div>
    <div class="ssec">Save settings</div>
    <label class="srow"><input type="radio" name="where" value="user" ${cfg.where !== 'workspace' ? 'checked' : ''}><span><b>Just for me</b><small>${esc(data.paths.user)}</small></span></label>
    <label class="srow"><input type="radio" name="where" value="workspace" ${cfg.where === 'workspace' ? 'checked' : ''}><span><b>Shared with the team</b><small>${esc(data.paths.workspace)} — commit it so everyone gets the same map</small></span></label>
    <div id="sWarn"></div><div id="sErr" class="serr"></div>
    <div class="sact"><button data-act="rescan">↻ Detect again</button><span class="ssp"></span>${first ? '' : '<button data-act="cancel">Cancel</button>'}<button data-act="save" class="primary">Save &amp; scan</button></div>
  </div>`
  warn()
}

function collect() {
  const checked = (g) => [...document.querySelectorAll(`#setup [data-g="${g}"]:checked`)].map((x) => x.value)
  return {
    platform: $('sPlat').value.trim(), apps: checked('apps'), instances: checked('instances'), tests: checked('tests'),
    name: $('sName').value.trim(), title: $('sTitle').value.trim(),
    where: document.querySelector('#setup [name="where"]:checked')?.value || 'user',
  }
}

// an instance binding an app you didn't select shows up as a phantom binding
function warn() {
  const c = collect(), D = data.discovered
  const ns = new Set(c.apps.map((a) => D.apps.find((x) => x.path === a)?.namespace || a.split('/').pop()))
  const w = []
  for (const p of c.instances) {
    const miss = (D.instances.find((i) => i.path === p)?.apps || []).filter((a) => !ns.has(a))
    if (miss.length) w.push(`${p} binds ${miss.map((m) => `'${m}'`).join(', ')}, which isn't among the selected apps — it will show as a phantom binding.`)
  }
  if (!c.apps.length) w.push('No apps selected: the map will show only the platform.')
  $('sWarn').innerHTML = w.map((x) => `<p class="swarn">${esc(x)}</p>`).join('')
}

async function save() {
  const btn = document.querySelector('#setup [data-act="save"]')
  btn.disabled = true
  $('sErr').textContent = ''
  try {
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) })
    const j = await r.json()
    if (!j.ok) throw new Error(j.error || 'could not save')
    close(j)
  } catch (e) {
    $('sErr').textContent = e.message
    btn.disabled = false
  }
}

document.addEventListener('click', async (e) => {
  if (!setupOpen()) return
  const b = e.target.closest('#setup [data-act]')
  if (!b) return
  const act = b.dataset.act
  if (act === 'save') return save()
  if (act === 'cancel') return close(null)
  if (act === 'addapp') {
    const v = $('sAddApp').value.trim().replace(/\/+$/, '')
    if (v) { const c = collect(); extra.push(v); render({ ...c, apps: [...c.apps, v] }) }
  }
  if (act === 'rescan') {
    const c = collect()
    data = await (await fetch('/api/setup', { cache: 'no-store' })).json()
    render(c)
  }
})
document.addEventListener('change', (e) => {
  if (!setupOpen() || !e.target.closest('#setup')) return
  if (e.target.name === 'plat') $('sPlat').value = e.target.value
  warn()
})
addEventListener('keydown', (e) => {
  if (setupOpen() && e.key === 'Escape' && !first) close(null)
})
