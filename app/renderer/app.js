// renderer. chassis -> section -> ECU -> fault flow against the local .NET
// sidecar (EDIABAS engine).

const API = new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:8777';

// persisted settings
const Settings = {
  data: JSON.parse(localStorage.getItem('bmacw.settings') || '{}'),
  get(key, def) { return key in this.data ? this.data[key] : def; },
  set(key, val) { this.data[key] = val; localStorage.setItem('bmacw.settings', JSON.stringify(this.data)); },
};
// skins / themes
const THEMES = [
  { id: 'instrument', name: 'Instrument' },
  { id: 'inpa',       name: 'INPA' },
  { id: 'aero',       name: 'Frutiger Aero' },
  { id: 'metal',      name: 'Brushed Metal' },
];
function applyTheme(id) {
  if (!id || id === 'instrument') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  // aero only: frameless + transparent window
  if (window.bmacw && window.bmacw.setTranslucent) {
    window.bmacw.setTranslucent(id === 'aero');
  }
  applyAeroOpacity();
  setTimeout(updateDockIcon, 100);
}
function applyAeroOpacity() {
  document.documentElement.style.setProperty('--aero-opacity', '0.82');
}
// render logo SVG to a 256x256 canvas with theme colors, send PNG to the dock
function updateDockIcon() {
  if (!window.bmacw || !window.bmacw.setDockIcon) return;
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--logo-bg').trim() || '#11161c';
  const border = styles.getPropertyValue('--logo-border').trim() || '#9aa6b2';
  const q1 = styles.getPropertyValue('--logo-quad-1').trim() || '#eef2f5';
  const q2 = styles.getPropertyValue('--logo-quad-2').trim() || '#ff9e2c';
  const ib = styles.getPropertyValue('--logo-inner-border').trim() || '#0a0d11';
  
  const resolvedSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="48" fill="${bg}" stroke="${border}" stroke-width="3"/>
      <clipPath id="disc"><circle cx="50" cy="50" r="31"/></clipPath>
      <g clip-path="url(#disc)">
        <rect x="19" y="19" width="31" height="31" fill="${q1}"/>
        <rect x="50" y="50" width="31" height="31" fill="${q1}"/>
        <rect x="50" y="19" width="31" height="31" fill="${q2}"/>
        <rect x="19" y="50" width="31" height="31" fill="${q2}"/>
      </g>
      <circle cx="50" cy="50" r="31" fill="none" stroke="${ib}" stroke-width="2"/>
    </svg>
  `;
  
  const img = new Image();
  const svgBlob = new Blob([resolvedSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    window.bmacw.setDockIcon(dataUrl).catch(console.error);
    URL.revokeObjectURL(url);
  };
  img.onerror = (e) => {
    console.error('Failed to load dynamic logo SVG to image:', e);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
applyTheme(Settings.get('theme', 'instrument'));

// 'en' = translated English, 'orig' = raw EDIABAS job names
const lang = () => Settings.get('lang', 'en');
const itemLabel = (it) => lang() === 'orig' ? it.job : it.label;

const view = document.getElementById('view');
const crumbsEl = document.getElementById('crumbs');
const led = document.getElementById('led');
const linkText = document.getElementById('link-text');
const sbLeft = document.getElementById('sb-left');
const sbRight = document.getElementById('sb-right');
const fkeysEl = document.getElementById('fkeys');

// display-name overrides; raw id stays for API/file lookup
const CHASSIS_DISPLAY = { F010: 'F10', F025: 'F25' };
const dispChassis = (id) => CHASSIS_DISPLAY[id] || id;

// short tags for chassis cards
const CHASSIS_TAG = {
  E36:'3-series 90s', E46:'3-series 98-06', E60:'5-series', E65:'7-series',
  E70:'X5', E83:'X3', E85:'Z4', E87:'1-series', E89:'Z4', E90:'3-series 05-12',
  E39:'5-series 95-03', E52:'Z8', E53:'X5 99-06',
  F01:'7-series', F07:'5 GT', F30:'3-series 12+', R50:'Mini', R56:'Mini',
  RR1:'Rolls-Royce', F010:'5-series', F025:'X3',
};

let crumbs = []; // [{label, fn}]

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// map terse engine/flash errors to { title, detail, fix }
function explainError(raw) {
  const m = (raw || '').toString();
  const lower = m.toLowerCase();

  if (lower.includes('no interface') || lower.includes('no serial') || lower.includes('no cable'))
    return { title: 'No adapter connected', detail: 'BMacW could not find the K+DCAN cable.',
      fix: 'Plug the cable into the Mac (directly, not through a flaky USB hub) and into the car OBD-II port. The status light turns green when detected.' };

  if (lower.includes('security access') || lower.includes('denied'))
    return { title: 'Security access denied', detail: 'The DME rejected the seed/key authentication needed to read protected memory.',
      fix: 'Make sure the engine is OFF with ignition in position 2, the battery is healthy (or a charger is connected), and the cable is solid. Retry, the seed is random each attempt.' };

  if (lower.includes('read failed') || lower.includes('no data at'))
    return { title: 'Memory read failed', detail: `The DME stopped responding partway through the read (${m}).`,
      fix: 'Usually a connection drop or low battery. Check the cable seating, keep ignition on / engine off, and ensure steady power, then read again.' };

  if (lower.includes('conditions_not_correct') || lower.includes('sequence'))
    return { title: 'ECU rejected the request', detail: 'The DME is not in a state that allows this, often the engine is running or ignition is not fully on.',
      fix: 'Set ignition to position 2 with the engine OFF and try again.' };

  if (lower.includes('ifh_0018') || lower.includes('interfaceconnect') || lower.includes('connect'))
    return { title: 'Could not reach the ECU', detail: 'The cable is present but the DME did not answer.',
      fix: 'Turn the ignition on, confirm the cable is fully seated at both ends, and check the FTDI latency is set to 1 ms.' };

  if (lower.includes('error_f_code'))
    return { title: 'This function needs a fault code', detail: 'The detailed fault job requires a specific DTC as input.',
      fix: 'Read the fault codes first, then open the detail for a specific one.' };

  if (lower.includes('timeout'))
    return { title: 'The ECU timed out', detail: 'No response within the expected time.',
      fix: 'Check the cable and ignition, then retry. A weak battery or loose connector is the usual cause.' };

  // fallback: raw message
  return { title: 'Something went wrong', detail: m || 'Unknown error.',
    fix: 'Check the cable and ignition (engine off, key on), then try again.' };
}

function errorBlock(raw, accent = 'amber') {
  const e = explainError(raw);
  return `<div class="empty">
    <div class="empty-big" style="color:var(--${accent})">${e.title}</div>
    <div>${e.detail}</div>
    <div style="font-size:12px;color:var(--ink-faint);max-width:48ch">${e.fix}</div>
  </div>`;
}

function setCrumbs(items) {
  crumbs = items;
  crumbsEl.innerHTML = '';
  items.forEach((c, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep'; sep.textContent = '/';
      crumbsEl.appendChild(sep);
    }
    const el = document.createElement('span');
    el.className = 'crumb' + (i === items.length - 1 ? ' active' : '');
    el.textContent = c.label;
    if (c.fn) el.onclick = c.fn;
    crumbsEl.appendChild(el);
  });
}

// INPA function-key bar. screens declare actions; bind number keys 1..9,0.
// Esc fires the `back` action.
let currentActions = []; // [{ key:'1', label, fn, kind }]

function setActions(actions) {
  stopLive(); stopLogging(); // leaving a screen halts polling + logging
  if (activationEcu && activeTests.size) { stopAllActivations(activationEcu); } // kill active actuator tests
  currentActions = actions;
  fkeysEl.innerHTML = '';
  actions.forEach(a => {
    const el = document.createElement('div');
    el.className = 'fkey' + (a.kind ? ' ' + a.kind : '');
    el.innerHTML = `<span class="fkey-num">${a.keyLabel || a.key}</span>
                    <span class="fkey-label">${a.label}</span>`;
    el.onclick = () => fireAction(a);
    a._el = el;
    fkeysEl.appendChild(el);
  });
}

function fireAction(a) {
  if (!a || !a.fn) return;
  if (a._el) { a._el.classList.remove('flash'); void a._el.offsetWidth; a._el.classList.add('flash'); }
  a.fn();
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  let key = e.key;
  // Esc and Backspace both act as back (F10)
  if (key === 'Escape' || key === 'Backspace') {
    const back = currentActions.find(a => a.kind === 'back');
    if (back) { e.preventDefault(); fireAction(back); }
    return;
  }
  const match = currentActions.find(a => a.key === key);
  if (match) { e.preventDefault(); fireAction(match); }
});

function head(eyebrow, title, subtitle) {
  return `<div class="screen-head">
    <div class="eyebrow">${eyebrow}</div>
    <h1 class="title">${title}</h1>
    ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
  </div>`;
}

function stagger(container, step = 35) {
  [...container.children].forEach((c, i) => { c.style.animationDelay = `${i * step}ms`; });
}

// confirm modal -> Promise<boolean>. Enter confirms, Esc cancels.
function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">${cancelLabel}<span class="modal-key">Esc</span></button>
          <button class="btn ${danger ? 'danger' : 'primary'} modal-confirm">${confirmLabel}<span class="modal-key">⏎</span></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const close = (val) => {
      overlay.classList.remove('show');
      window.removeEventListener('keydown', onKey, true);
      setTimeout(() => overlay.remove(), 160);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-cancel').onclick = () => close(false);
    overlay.querySelector('.modal-confirm').onclick = () => close(true);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    overlay.querySelector('.modal-confirm').focus();
  });
}

// value-input modal for INPA functions (throttle command, measurement-block index,
// service comment, raw telegram). returns string or null. Enter submits, Esc cancels.
function inputDialog({ title, body, kind = 'text', example = '', confirmLabel = 'Run', danger = false }) {
  return new Promise((resolve) => {
    const htmlType = kind === 'number' ? 'number' : 'text';
    const ph = example ? `e.g. ${example}` : '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-input-wrap">
          <input class="modal-input" type="${htmlType}" placeholder="${ph}"
                 ${kind === 'hex' ? 'spellcheck="false" autocapitalize="off"' : ''} />
          ${kind === 'hex' ? '<span class="modal-input-hint">hex / KWP bytes, e.g. 22,40,0A</span>' : ''}
          ${kind === 'number' ? '<span class="modal-input-hint">numeric value</span>' : ''}
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn ${danger ? 'danger' : 'primary'} modal-confirm">${confirmLabel}<span class="modal-key">⏎</span></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const field = overlay.querySelector('.modal-input');

    const close = (val) => {
      overlay.classList.remove('show');
      window.removeEventListener('keydown', onKey, true);
      setTimeout(() => overlay.remove(), 160);
      resolve(val);
    };
    const submit = () => {
      const v = field.value.trim();
      if (v === '') { field.focus(); field.classList.add('shake'); setTimeout(() => field.classList.remove('shake'), 350); return; }
      close(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = submit;
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    field.focus();
  });
}

// prompt for a value, then call the job with it
async function runInputFunction(ecu, input, container) {
  const danger = /steuern|command|throttle|setpoint|write|store|reset/i.test(
    (input.field || '') + ' ' + (input.job || ''));
  const val = await inputDialog({
    title: input.field || input.job,
    body: input.args_template
      ? `<span class="muted">${input.args_template}</span><br><span class="mono" style="font-size:11px;color:var(--ink-faint)">job: ${input.job}</span>`
      : `<span class="mono" style="font-size:11px;color:var(--ink-faint)">job: ${input.job}</span>`,
    kind: input.kind || 'text',
    example: input.example || '',
    confirmLabel: danger ? 'Send' : 'Run',
    danger,
  });
  if (val == null) { sbLeft.textContent = 'cancelled'; return; }

  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${input.field || input.job}…</span></div>`;
  try {
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${input.job}?arg=${encodeURIComponent(val)}`, { method: 'POST' });
    renderResultSets(data.sets, container, input.job);
    sbLeft.textContent = `${input.job} ${val} · done`;
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

// screen 1: chassis
async function showChassis() {
  lastScreen = showChassis;
  setCrumbs([{ label: 'Vehicles' }]);
  sbLeft.textContent = 'select chassis';
  const ids = await api('/api/chassis');

  if (inpaMode()) {
    // INPA vehicle select: Battery/Ignition row + chassis F-key list. main list shows
    // common chassis; rest sit under "Old models" (Shift+F9), plus "Special tests".
    const COMMON = ['E46', 'E39', 'E60', 'E65', 'E83', 'E85', 'E90', 'E70', 'F30'];
    const main = COMMON.filter(id => ids.includes(id));
    const old = ids.filter(id => !main.includes(id)); // everything else

    view.innerHTML = head('Vehicles', 'INPA', 'Select your vehicle.');
    const panel = document.createElement('div');
    panel.className = 'inpa-vsel';
    const fnRow = (i, id, label) => `
      <button class="inpa-fn" data-id="${id}">
        <span class="inpa-fn-key">&lt; F${i} &gt;</span>
        <span class="inpa-fn-label">${label}</span>
      </button>`;
    panel.innerHTML = `
      <div class="inpa-klrow">
        <span class="inpa-kl"><span class="inpa-kl-name">Battery :</span><span class="inpa-kl-led" id="vsel-bat"></span><span class="inpa-kl-state" id="vsel-bat-s">off</span></span>
        <span class="inpa-kl"><span class="inpa-kl-name">Ignition :</span><span class="inpa-kl-led" id="vsel-ign"></span><span class="inpa-kl-state" id="vsel-ign-s">off</span></span>
      </div>
      <div class="inpa-vsplit">
        <div class="inpa-vlist">${main.map((id, i) => fnRow(i + 1, id, `${dispChassis(id)}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}`)).join('')}</div>
        <div class="inpa-vlist inpa-vlist-right">
          ${old.length ? `<button class="inpa-fn inpa-fn-more" id="vsel-old"><span class="inpa-fn-key">&lt;Shift+F9&gt;</span><span class="inpa-fn-label">Old models …</span></button>` : ''}
          <button class="inpa-fn inpa-fn-more" id="vsel-special"><span class="inpa-fn-key">&lt;Shift+F8&gt;</span><span class="inpa-fn-label">Special tests …</span></button>
        </div>
      </div>`;
    view.appendChild(panel);
    // Picking a chassis opens the Script-selection popup.
    panel.querySelectorAll('.inpa-fn[data-id]').forEach(b => b.onclick = () => showScriptSelection(b.dataset.id));
    const oldBtn = panel.querySelector('#vsel-old');
    if (oldBtn) oldBtn.onclick = () => showOtherModels(old);
    panel.querySelector('#vsel-special').onclick = () => showSpecialTests();
    sbRight.textContent = `${main.length} common · ${old.length} more`;
    syncVselState();
    const acts = main.slice(0, 8).map((id, i) => ({ key: String(i + 1), label: dispChassis(id), fn: () => showScriptSelection(id) }));
    if (old.length) acts.push({ key: '9', label: 'Old models', fn: () => showOtherModels(old) });
    setActions(acts);
    return;
  }

  view.innerHTML = head('Vehicles', 'Select your vehicle',
    'Choose a chassis to load its diagnostic modules.');
  const grid = document.createElement('div');
  grid.className = 'chassis-grid stagger';
  view.appendChild(grid);

  ids.forEach(id => {
    const card = document.createElement('div');
    card.className = 'chassis-card';
    card.innerHTML = `
      <div class="chassis-code">${dispChassis(id)}</div>
      <div class="chassis-tag">${CHASSIS_TAG[id] || 'BMW'}</div>
      <div class="chassis-arrow">→</div>`;
    card.onclick = () => showSections(id);
    grid.appendChild(card);
  });
  stagger(grid, 22);
  sbRight.textContent = `${ids.length} chassis`;

  // Root screen: quick-pick common chassis, no back.
  const quick = ['E46', 'E60', 'E90'].filter(id => ids.includes(id));
  setActions(quick.map((id, i) => ({
    key: String(i + 1), label: id, fn: () => showSections(id),
  })));
}

// background scan of E46 engine + transmission, once per session on first open.
// stored faults get a detail read and an attention popup.
let _autoScanRan = false;
async function autoScanE46(force) {
  if (_autoScanRan && !force) return;
  // engine = MS45; transmission = all E46 variants (only one is installed)
  const targets = [
    { sgbd: 'ms450ds0', label: 'MS45.1 DME (engine)' },
    { sgbd: 'gsds2',    label: 'GS20/GS8 auto trans' },
    { sgbd: 'gs30',     label: 'SSG sequential gearbox' },
    { sgbd: 'smg2',     label: 'SMG2 transmission' },
  ];
  const findings = [];     // { label, faults:[ detailed codes ] }
  let transFound = false, anyResponse = false;
  for (const t of targets) {
    // trans variants share an address: once one answers, skip the rest
    if (transFound && t.sgbd !== 'ms450ds0') continue;
    let data;
    try { data = await api(`/api/ecu/${t.sgbd}/read`, { method: 'POST' }); }
    catch { continue; } // no response = not installed
    anyResponse = true;
    if (t.sgbd !== 'ms450ds0') transFound = true; // this trans variant answered
    const faults = (data.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
    if (!faults.length) continue;
    // pull detail per fault (P-code, frequency, environment)
    for (const f of faults) {
      if (f.F_ORT_NR == null) continue;
      try {
        const det = await api(`/api/ecu/${t.sgbd}/run/FS_LESEN_DETAIL?arg=${encodeURIComponent(f.F_ORT_NR)}`, { method: 'POST' });
        const dset = matchDetail(det.sets, f.F_ORT_NR);
        if (dset) { const { F_HEX_CODE, F_ORT_TEXT, ...rich } = dset; Object.assign(f, rich); }
      } catch { /* keep base entry */ }
    }
    findings.push({ label: t.label, sgbd: t.sgbd, faults });
  }
  if (anyResponse) _autoScanRan = true; // mark done only after the bus answered, so a late connect rescans
  if (findings.length) showAttentionPopup(findings);
}

// pick the detail set for fault nr. match F_ORT_NR first; fall back to a p-code/hex
// set only when no set has an F_ORT_NR, so wrong-fault data isnt attached
function matchDetail(sets, nr) {
  const list = sets || [];
  return list.find(s => s.F_ORT_NR == nr)
      || (list.some(s => s.F_ORT_NR != null) ? null
          : list.find(s => s.F_PCODE_STRING || s.F_HEX_CODE));
}

// corner warning badge for stored faults. click expands the detail list; stays
// until dismissed.
function showAttentionPopup(findings) {
  document.getElementById('att-badge')?.remove();   // replace any existing
  document.getElementById('att-panel')?.remove();
  const total = findings.reduce((n, f) => n + f.faults.length, 0);

  const badge = document.createElement('button');
  badge.id = 'att-badge';
  badge.className = 'att-corner';
  badge.title = `${total} stored fault${total === 1 ? '' : 's'} - click for detail`;
  badge.innerHTML = `<span class="att-tri">▲</span><span class="att-count">${total}</span>`;
  document.body.appendChild(badge);
  requestAnimationFrame(() => badge.classList.add('show'));

  // expanded detail panel, built once and toggled
  const blocks = findings.map(g => `
    <div class="att-group">
      <div class="att-ecu">${g.label} · ${g.faults.length} fault${g.faults.length === 1 ? '' : 's'}</div>
      ${g.faults.map(c => {
        const hex = c.F_HEX_CODE || '';
        const pstr = c.F_PCODE_STRING || pCode(c.F_ORT_TEXT, hex) || '';
        const present = (c.F_VORHANDEN_TEXT || '').toLowerCase().includes('momentan vorhanden')
          && !(c.F_VORHANDEN_TEXT || '').toLowerCase().includes('nicht vorhanden');
        return `<div class="att-fault${present ? ' present' : ''}">
          <div class="att-name">${faultName(c.F_ORT_TEXT, hex)}${present ? '<span class="att-badge">PRESENT</span>' : ''}</div>
          <div class="att-meta">${deGerman(c.F_SYMPTOM_TEXT) || ''}${pstr ? ` · ${pstr}` : ''}${(c.F_HFK || c.F_LZ) ? ` · seen ${c.F_HFK || c.F_LZ}×` : ''}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
  const panel = document.createElement('div');
  panel.id = 'att-panel';
  panel.className = 'att-panel';
  panel.innerHTML = `
    <div class="att-panel-head">
      <span>⚠︎ ${total} stored fault${total === 1 ? '' : 's'}</span>
      <button class="att-x" title="Dismiss">✕</button>
    </div>
    <div class="att-body">${blocks}</div>
    <div class="att-panel-foot"><button class="btn primary att-open">Open faults</button></div>`;
  document.body.appendChild(panel);

  let open = false;
  const setOpen = (v) => { open = v; panel.classList.toggle('show', v); badge.classList.toggle('expanded', v); };
  const onDocClick = (e) => {
    if (open && !panel.contains(e.target) && e.target !== badge && !badge.contains(e.target)) setOpen(false);
  };
  const dismiss = () => { document.removeEventListener('click', onDocClick); badge.remove(); panel.remove(); };
  badge.onclick = () => setOpen(!open);
  panel.querySelector('.att-x').onclick = (e) => { e.stopPropagation(); dismiss(); };
  panel.querySelector('.att-open').onclick = () => {
    setOpen(false);
    const g = findings[0];
    showEcu('E46', 'Engine', { sgbd: g.sgbd, code: g.sgbd, label: g.label });
  };
  document.addEventListener('click', onDocClick); // removed in dismiss()
}

// INPA script-selection popup, opened on chassis pick. two panes: left lists
// section categories, right shows the section's ECUs. Esc aborts.
async function showScriptSelection(chassisId) {
  if (chassisId.toUpperCase() === 'E46') autoScanE46(); // background scan on E46 open
  let ch;
  try { ch = await api(`/api/chassis/${chassisId}`); }
  catch (e) { showSections(chassisId); return; } // fall back to the full screen

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="inpa-scriptsel" role="dialog" aria-modal="true">
      <div class="inpa-ss-bar">Script selection&nbsp;&nbsp;&nbsp;<span class="inpa-ss-hint">(&lt;TAB&gt; to change listbox, &lt;ESC&gt; to abort)</span></div>
      <div class="inpa-ss-panes">
        <div class="inpa-ss-left" id="ss-left">
          <div class="inpa-ss-head selected">${dispChassis(chassisId)}</div>
          ${ch.sections.map((s, i) => `<button class="inpa-ss-item" data-i="${i}">${s.name}</button>`).join('')}
        </div>
        <div class="inpa-ss-right" id="ss-right">
          <div class="inpa-ss-head">Functional jobs</div>
          <div class="inpa-ss-jobs" id="ss-jobs"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const jobsPane = overlay.querySelector('#ss-jobs');
  const items = overlay.querySelectorAll('.inpa-ss-item');
  // right pane leads with "Functional Jobs" (whole-vehicle Identify/Fault sweep),
  // then the section modules. sweep only validated for E46, so gate it.
  const allowFunc = chassisId.toUpperCase() === 'E46';
  const showSection = (i) => {
    items.forEach((it, j) => it.classList.toggle('active', j === i));
    const sec = ch.sections[i];
    const funcJob = allowFunc ? `<button class="inpa-ss-job func" data-func="1">Functional Jobs</button>` : '';
    const ecus = sec.ecus.length
      ? sec.ecus.map(e => `<button class="inpa-ss-job" data-sgbd="${e.sgbd}" data-code="${e.code}" data-label="${e.label.replace(/"/g, '&quot;')}">${e.label}</button>`).join('')
      : '';
    jobsPane.innerHTML = funcJob + (ecus || (allowFunc ? '' : '<div class="inpa-ss-empty">No modules</div>'));
    const fb = jobsPane.querySelector('.inpa-ss-job.func');
    if (fb) fb.onclick = () => { close(); showFunctionalJobs(chassisId); };
    jobsPane.querySelectorAll('.inpa-ss-job:not(.func)').forEach(b => {
      b.onclick = () => { close(); showEcu(chassisId, sec.name, { sgbd: b.dataset.sgbd, code: b.dataset.code, label: b.dataset.label }); };
    });
  };
  items.forEach((it, i) => it.onclick = () => showSection(i));
  if (ch.sections.length) showSection(0); // preselect first section
}

// INPA "Functional Jobs" menu: F2 Identification (quickIdentSweep), F4 Fault
// Memory (quickErrorSweep).
function showFunctionalJobs(chassisId) {
  const id = chassisId || 'E46';
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id) }, { label: 'Functional Jobs' }]);
  sbLeft.textContent = 'functional jobs';
  view.innerHTML = head('Functional Jobs', `${dispChassis(id)} · all modules`,
    'Whole-vehicle operations across every control unit.');
  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  view.appendChild(grid);

  const jobs = [
    { key: '2', name: 'Identification', desc: 'Identify every module on the car (SGBD, HW/SW)', fn: () => quickIdentSweep(id) },
    { key: '4', name: 'Fault Memory', desc: 'Read fault memory across all modules, which have stored faults', fn: () => quickErrorSweep(id) },
  ];
  jobs.forEach(j => {
    const tile = document.createElement('div');
    tile.className = 'group-tile';
    tile.innerHTML = `<div class="group-name">F${j.key} · ${j.name}</div>
      <div class="group-count">${j.desc}</div><div class="group-arrow">→</div>`;
    tile.onclick = j.fn;
    grid.appendChild(tile);
  });
  stagger(grid, 40);
  setActions([
    { key: '2', label: 'Identification', kind: 'primary', fn: () => quickIdentSweep(id) },
    { key: '4', label: 'Fault Memory', fn: () => quickErrorSweep(id) },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showChassis() },
  ]);
}

// "Old models" popup (INPA Shift+F9): chassis hidden from the main list
function showOtherModels(ids) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal inpa-pop" role="dialog" aria-modal="true">
      <div class="modal-title">Old models</div>
      <div class="inpa-pop-list">${ids.map((id, i) => `
        <button class="inpa-pop-row" data-id="${id}">
          <span class="inpa-pop-key">F${i + 1}</span>
          <span class="inpa-pop-label">${dispChassis(id)}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}</span>
        </button>`).join('')}</div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.querySelector('.modal-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelectorAll('.inpa-pop-row').forEach(b => b.onclick = () => { close(); showScriptSelection(b.dataset.id); });
}

// "Special tests" popup (INPA Shift+F8). quick sweeps scan every ECU on the
// chassis; chassis-specific routines not yet safe to run are disabled.
const SPECIAL_TESTS = [
  { id: 'quick-error',  label: 'Quick error memory test', run: (id) => quickErrorSweep(id) },
  { id: 'quick-ident',  label: 'Quick identification test', run: (id) => quickIdentSweep(id) },
  { id: 'quick-test',   label: 'Quick test', run: (id) => quickErrorSweep(id) },
  { id: 'quick-id',     label: 'Quick identification', run: (id) => quickIdentSweep(id) },
  { id: 'abs-bleed',    label: 'ABS/ASC bleeding', disabled: true },
  { id: 'lws-adjust',   label: 'Steering angle adjustment', disabled: true },
  { id: 'rdc-telegram', label: 'RDC telegram recording', disabled: true },
  { id: 'rdc-antenna',  label: 'RDC antenna check', disabled: true },
];

function showSpecialTests(chassisId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal inpa-script" role="dialog" aria-modal="true">
      <div class="inpa-script-bar">Script selection <span class="inpa-script-hint">(&lt;Esc&gt; to abort)</span></div>
      <div class="inpa-script-panes">
        <div class="inpa-script-cats"><div class="inpa-script-cat active">Special tests</div></div>
        <div class="inpa-script-list">${SPECIAL_TESTS.map((t, i) => `
          <button class="inpa-script-row${t.disabled ? ' disabled' : ''}" data-i="${i}"${t.disabled ? ' disabled' : ''}>${t.label}</button>`).join('')}</div>
      </div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.querySelector('.modal-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelectorAll('.inpa-script-row:not(.disabled)').forEach(b => {
    b.onclick = () => { const t = SPECIAL_TESTS[+b.dataset.i]; close(); if (t.run) t.run(chassisId); };
  });
}

// E46 variant groups: ECUs sharing one diagnostic address, only one installed.
// once a member responds the rest are absent (or echoes), so the sweep skips them.
// engine group alone has 12 mutually-exclusive DMEs at ~7s each.
const E46_VARIANT_GROUPS = {
  engine: ['DDE40', 'D50M47', 'D50M57', 'BMS46', 'ME9_4N', 'ME9NG4TU', 'MS420', 'MS430', 'MS450', 'MSS54M3', 'CARB'],
  trans:  ['gsds2', 'gs30', 'smg2'],
  dsc:    ['ascdsc46', 'absasc5', 'dscmk60'],
};
// sgbd -> group key (case-insensitive)
const _groupOf = (sgbd) => {
  const s = (sgbd || '').toLowerCase();
  for (const [k, list] of Object.entries(E46_VARIANT_GROUPS))
    if (list.some(x => x.toLowerCase() === s)) return k;
  return null;
};

// quick error memory test (INPA FSQUICK): read fault memory on every chassis ECU,
// combined report of which modules have stored faults.
async function quickErrorSweep(chassisId) {
  const id = chassisId || 'E46';
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => showSections(id) }, { label: 'Quick error sweep' }]);
  view.innerHTML = head('Special tests', 'Quick error memory test', `Scanning every module on the ${dispChassis(id)} for stored faults…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showSections(id) }]);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { out.innerHTML = errorBlock(e.message); return; }
  const ecus = [];
  ch.sections.forEach(s => s.ecus.forEach(e => { if (!ecus.find(x => x.sgbd === e.sgbd)) ecus.push(e); }));
  out.innerHTML = `<div class="quick-sweep"><div class="quick-head">${ecus.length} modules · scanning…</div><div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  let withFaults = 0, scanned = 0, dupes = 0, skipped = 0;
  // each read costs ~7s (K-line wake-up) whether the ECU answers or not. variant
  // groups share one address, only one installed, so once a group's ECU responds
  // skip the rest. dedup by fault signature catches echoes. cuts the 12 engine
  // variants to ~1-2 reads.
  const seen = new Map();          // fault-signature -> first ECU label
  const groupDone = new Set();     // variant-group key that already responded
  // try each group's most-likely member first to short-circuit dead variants.
  // E46 leads with the common petrol DMEs.
  const PRIORITY = ['MS450', 'MS430', 'MS420', 'ME9_4N', 'MSS54M3', 'BMS46', 'gsds2', 'smg2', 'ascdsc46', 'absasc5'];
  const prio = (e) => { const i = PRIORITY.findIndex(p => p.toLowerCase() === (e.sgbd || '').toLowerCase()); return i < 0 ? 99 : i; };
  ecus.sort((a, b) => prio(a) - prio(b));
  for (const ecu of ecus) {
    const grp = _groupOf(ecu.sgbd);
    const row = document.createElement('div'); row.className = 'quick-row';
    row.innerHTML = `<span class="quick-ecu">${ecu.label}</span><span class="quick-status">scanning…</span>`;
    rows.appendChild(row);

    if (grp && groupDone.has(grp)) {
      // another variant in this group answered, so this one not installed
      skipped++; row.classList.add('noresp');
      row.querySelector('.quick-status').textContent = 'skipped (variant)';
      continue;
    }
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/read`, { method: 'POST' });
      const n = data.count || 0;
      // any answer (even 0 faults) claims the variant group
      if (grp && (n > 0 || data.count === 0)) groupDone.add(grp);
      if (n > 0) {
        const sig = (data.codes || []).map(c => c.F_ORT_NR).join(',');
        if (seen.has(sig)) {
          dupes++; row.classList.add('noresp');
          row.querySelector('.quick-status').textContent = `echo of ${seen.get(sig)}`;
        } else {
          seen.set(sig, ecu.label);
          withFaults++; row.classList.add('has-faults');
          row.querySelector('.quick-status').innerHTML = `<b>${n} fault${n === 1 ? '' : 's'}</b>`;
        }
      } else { row.classList.add('clean'); row.querySelector('.quick-status').textContent = 'OK'; }
    } catch (e) {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    out.querySelector('.quick-head').textContent = `${scanned} read · ${skipped} skipped · ${withFaults} with faults`;
  }
  out.querySelector('.quick-head').textContent =
    `Done · ${scanned} read, ${skipped} skipped · ${withFaults} with stored faults${dupes ? ` · ${dupes} echoes hidden` : ''}`;
  sbLeft.textContent = `quick sweep · ${withFaults} faulty`;
}

// quick identification (INPA IDQUICK): read IDENT on every chassis ECU
async function quickIdentSweep(chassisId) {
  const id = chassisId || 'E46';
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => showSections(id) }, { label: 'Quick identification' }]);
  view.innerHTML = head('Special tests', 'Quick identification', `Identifying every module on the ${dispChassis(id)}…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showSections(id) }]);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { out.innerHTML = errorBlock(e.message); return; }
  const ecus = [];
  ch.sections.forEach(s => s.ecus.forEach(e => { if (!ecus.find(x => x.sgbd === e.sgbd)) ecus.push(e); }));
  out.innerHTML = `<div class="quick-sweep"><div class="quick-head">${ecus.length} modules · identifying…</div><div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  let present = 0, scanned = 0;
  for (const ecu of ecus) {
    const row = document.createElement('div'); row.className = 'quick-row';
    row.innerHTML = `<span class="quick-ecu">${ecu.label}</span><span class="quick-status">…</span>`;
    rows.appendChild(row);
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/run/IDENT`, { method: 'POST' });
      const set = (data.sets || []).slice(1).find(s => Object.keys(s).some(k => !k.startsWith('_')));
      const idtxt = set ? (set.SG_VARIANTE || set.VARIANTE || set.AIF_TYP || set.HARDWARE_NUMMER || 'present') : 'present';
      present++; row.classList.add('clean'); row.querySelector('.quick-status').textContent = String(idtxt).slice(0, 28);
    } catch {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    out.querySelector('.quick-head').textContent = `${scanned}/${ecus.length} identified · ${present} present`;
  }
  out.querySelector('.quick-head').textContent = `Done · ${present}/${ecus.length} modules present`;
  sbLeft.textContent = `quick ident · ${present} present`;
}

// mirror topbar Battery/Ignition state into the INPA vehicle-select indicators
function syncVselState() {
  const bs = document.getElementById('vsel-bat'), bv = document.getElementById('vsel-bat-s');
  const is = document.getElementById('vsel-ign'), iv = document.getElementById('vsel-ign-s');
  if (!bs) return;
  const batOn = batLed && batLed.classList.contains('on');
  const ignOn = ignLed && ignLed.classList.contains('on');
  bs.className = 'inpa-kl-led' + (batOn ? ' on' : ''); bv.textContent = batOn ? (batVal.textContent) : 'off';
  is.className = 'inpa-kl-led' + (ignOn ? ' on' : ''); iv.textContent = ignOn ? 'on' : 'off';
}

// screen 2: sections sidebar + ECU list
async function showSections(id, selectIndex = 0) {
  lastScreen = () => showSections(id, selectIndex);
  if (id.toUpperCase() === 'E46') autoScanE46(); // background scan on E46 open
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id) }]);
  sbLeft.textContent = `loading ${dispChassis(id)}…`;
  view.innerHTML = head('Control modules', dispChassis(id), 'Pick a system on the left, then a module.');

  const split = document.createElement('div');
  split.className = 'split';
  split.innerHTML = `<nav class="split-nav" id="split-nav"></nav>
                     <div class="split-content" id="split-content"></div>`;
  view.appendChild(split);

  const ch = await api(`/api/chassis/${id}`);
  const nav = split.querySelector('#split-nav');
  const content = split.querySelector('#split-content');

  function selectSection(idx) {
    selectIndex = idx;
    const sec = ch.sections[idx];
    [...nav.children].forEach((n, i) => n.classList.toggle('active', i === idx));
    content.innerHTML = '';
    const listWrap = document.createElement('div');
    listWrap.className = 'ecu-list stagger';
    sec.ecus.forEach(ecu => {
      const row = document.createElement('div');
      row.className = 'ecu-row';
      row.innerHTML = `
        <span class="ecu-bullet"></span>
        <span class="ecu-label">${ecu.label}</span>
        <span class="ecu-sgbd">${ecu.sgbd}</span>`;
      row.onclick = () => showEcu(id, sec.name, ecu);
      listWrap.appendChild(row);
    });
    content.appendChild(listWrap);
    stagger(listWrap, 14);
    sbRight.textContent = `${sec.ecus.length} module${sec.ecus.length === 1 ? '' : 's'}`;
  }

  ch.sections.forEach((sec, idx) => {
    const item = document.createElement('button');
    item.className = 'split-nav-item';
    // badge = shortcut key (1..N), matching the footer F-key bar
    item.innerHTML = `<span class="nav-key">${idx + 1}</span>
                      <span class="nav-name">${sec.name}</span>`;
    item.onclick = () => selectSection(idx);
    nav.appendChild(item);
  });

  sbLeft.textContent = ch.description;
  selectSection(Math.min(selectIndex, ch.sections.length - 1));

  // number keys select a system, Esc goes back
  const actions = ch.sections.slice(0, 8).map((s, i) => ({
    key: String(i + 1), label: s.name, fn: () => selectSection(i),
  }));
  actions.push({ key: 'Escape', keyLabel: 'Esc', label: 'Vehicles', kind: 'back', fn: showChassis });
  setActions(actions);
}

// screen 3: ECU fault dashboard.
// English labels for common EDIABAS jobs.
const JOB_LABELS = {
  FS_LESEN: 'Read fault codes',
  FS_LESEN_DETAIL: 'Read fault codes (detail)',
  FS_LOESCHEN: 'Clear fault codes',
  IDENT: 'Identify ECU',
  INFO: 'ECU info',
  STATUS_LESEN: 'Read status',
  SERIENNUMMER_LESEN: 'Read serial number',
  CBS_DATEN_LESEN: 'Read CBS service data',
};
// EDIABAS internal jobs, hidden from the function list
const HIDDEN_JOBS = new Set([
  '_JOBS', '_JOBCOMMENTS', '_ARGUMENTS', '_RESULTS', '_VERSIONINFO', '_TABLES', '_TABLE',
  'INITIALISIERUNG', 'ENDE',
]);
// destructive/flash/security jobs: shown but flagged, never auto-run
const DANGEROUS_JOBS = /FLASH|LOESCHEN|SCHREIBEN|RESET|AUTHENTISIERUNG|PROGRAMMIER|BAUDRATE|PARAMETER_SETZEN/;

const jobLabel = (j) => JOB_LABELS[j] || j.replace(/_/g, ' ').toLowerCase()
  .replace(/\b\w/g, c => c.toUpperCase());

// fold the mined .IPO screen layout into the menu. each layout screen becomes a
// function item (definition under `_screen`), bucketed into INPA sections by
// group-title keyword.
function mergeLayoutIntoMenu(menu, layout) {
  const buckets = new Map(); // sectionName -> items[]
  const put = (section, item) => {
    if (!buckets.has(section)) buckets.set(section, []);
    buckets.get(section).push(item);
  };
  const sectionFor = (group) => {
    const g = (group || '').toLowerCase();
    if (/adapt/.test(g)) return 'Adaptations';
    if (/lambda|o2 sensor|mixture|fuel|injection|misfire/.test(g)) return 'Fuel & lambda';
    if (/temp|coolant|intake|boost|pressure|air|throttle|load|rpm|idle/.test(g)) return 'Engine values';
    if (/vanos|valvetronic|timing|ignition/.test(g)) return 'Timing & VANOS';
    if (/config|coding|variant|identif|version/.test(g)) return 'Configuration';
    return 'Status';
  };
  layout.screens.forEach((scr, i) => {
    const label = scr.group || (scr.job ? jobLabel(scr.job) : `Screen ${i + 1}`);
    put(sectionFor(scr.group), { job: scr.job || `__screen_${i}`, label, danger: false, _screen: scr });
  });

  // keep the real job sections (Fault memory, Info, Service, Activations). drop the
  // auto-generated Status, the layout replaces it.
  const kept = (menu.sections || []).filter(s => !/^status$/i.test(s.section));
  const layoutSections = [...buckets.entries()].map(([section, items]) => ({ section, items }));

  // input-requiring functions become an "Inputs" section, spec under `_input`.
  // clicking opens a value dialog.
  const inputs = Array.isArray(layout.inputs) ? layout.inputs : [];
  if (inputs.length) {
    // de-dupe by (job + field), stable pseudo-job id for keys
    const seen = new Set();
    const items = [];
    inputs.forEach((inp, i) => {
      const sig = (inp.job || '') + '|' + (inp.field || '');
      if (seen.has(sig)) return;
      seen.add(sig);
      items.push({
        job: `__input_${i}`,
        label: inp.field || inp.job,
        danger: /steuern|command|throttle|write|store|reset/i.test((inp.field || '') + ' ' + (inp.job || '')),
        _input: inp,
      });
    });
    if (items.length) layoutSections.push({ section: 'Inputs', items });
  }

  // Status first, then layout buckets, then kept job sections
  const order = ['Status', 'Engine values', 'Fuel & lambda', 'Adaptations', 'Timing & VANOS', 'Configuration', 'Inputs'];
  layoutSections.sort((a, b) => {
    const ia = order.indexOf(a.section), ib = order.indexOf(b.section);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return { sgbd: menu.sgbd, sections: [...layoutSections, ...kept], _hasLayout: true };
}

// INPA ECU main menu ("Hauptmenue"): SGBD sub-line + function list with F-key bar.
// each entry opens its section.
function renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar) {
  if (bar) bar.remove(); // INPA shows SGBD/addr inline, not as pills
  grid.className = 'inpa-haupt';
  const secs = menu.sections;
  const row = (i, sec) => `
    <button class="inpa-fn" data-i="${i}">
      <span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>
      <span class="inpa-fn-label">${sec.section}</span>
      <span class="inpa-fn-count">${sec.items.length}</span>
    </button>`;
  grid.innerHTML = `
    <div class="inpa-haupt-sub">SGBD = ${ecu.sgbd.toUpperCase()}</div>
    <div class="inpa-haupt-list">${secs.map((s, i) => row(i, s)).join('')}</div>`;
  grid.querySelectorAll('.inpa-fn').forEach(btn => {
    const i = +btn.dataset.i;
    btn.onclick = () => showEcuSection(chassisId, sectionName, ecu, menu, secs[i].section);
  });
}

// ECU main menu: section categories on the F-key bar, each opens a sub-screen
async function showEcu(chassisId, sectionName, ecu) {
  lastScreen = () => showEcu(chassisId, sectionName, ecu);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => showSections(chassisId) },
    { label: ecu.label },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  view.innerHTML = head(`${sectionName} · ${ecu.code}`, ecu.label,
    `SGBD ${ecu.sgbd}.prg · choose a function group below`);

  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.innerHTML = `<span class="pill" id="port-pill">cable: …</span>
                   <span class="pill" id="job-count">loading…</span>`;
  view.appendChild(bar);

  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  view.appendChild(grid);

  api('/api/port').then(p => {
    document.getElementById('port-pill').textContent =
      p.port ? `cable: ${p.port.replace('/dev/', '')}` : 'no cable';
  }).catch(() => {});

  // mined .IPO layout when this ECU is mapped, else the job-name menu
  let menu, layout = null;
  try {
    layout = await api(`/api/ecu/${ecu.sgbd}/layout`);
  } catch { /* no layout, fall back below */ }
  try {
    menu = await api(`/api/ecu/${ecu.sgbd}/menu`);
  } catch (e) {
    if (!layout) { grid.innerHTML = `<div class="empty"><div>${e.message}</div></div>`; return; }
    menu = { sgbd: ecu.sgbd, sections: [] };
  }
  if (layout && Array.isArray(layout.screens) && layout.screens.length) {
    menu = mergeLayoutIntoMenu(menu, layout);
    ecu._layout = layout; // stash for the section/screen renderers
  }
  const total = menu.sections.reduce((n, s) => n + s.items.length, 0);
  document.getElementById('job-count').textContent = `${total} functions`;

  if (inpaMode()) {
    renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar);
    // F-keys mirror the section list
    const acts = menu.sections.slice(0, 9).map((sec, i) => ({
      key: String(i + 1), label: sec.section,
      fn: () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section),
    }));
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showSections(chassisId) });
    setActions(acts);
    return;
  }

  // category tiles, also reachable via the F-key bar
  menu.sections.forEach(sec => {
    const tile = document.createElement('div');
    tile.className = 'group-tile';
    tile.innerHTML = `
      <div class="group-name">${sec.section}</div>
      <div class="group-count">${sec.items.length} function${sec.items.length === 1 ? '' : 's'}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section);
    grid.appendChild(tile);
  });

  stagger(grid, 40);

  // F-keys = section categories, + back
  const acts = menu.sections.slice(0, 8).map((sec, i) => ({
    key: String(i + 1), label: sec.section,
    fn: () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section),
  }));
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showSections(chassisId) });
  setActions(acts);
}

// flashing. stage 1: identify + read/backup the DME, no writing yet.
const FLASH_SGBD = 'ms450ds0';            // MS45 only
const flashEcu = { sgbd: FLASH_SGBD, label: 'MS45.1 DME', code: 'MS450' };

function showFlashing() {
  lastScreen = showFlashing;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Flashing' }]);
  sbLeft.textContent = 'flashing';
  view.innerHTML = head('DME flashing', 'Flashing',
    'Identify and back up the engine ECU. Writing/flashing is not enabled yet; back up first.');

  const warn = document.createElement('div');
  warn.className = 'act-warning';
  warn.innerHTML = `⚠ DME flashing is high-risk and can render the engine unbootable. This screen currently only <b>reads</b> (safe). Use a fully-charged battery and the wired K+DCAN cable, ignition on. Always keep a full backup.`;
  view.appendChild(warn);

  // identify button + result panel
  const idBar = document.createElement('div');
  idBar.className = 'flash-tools';
  idBar.innerHTML = `<button class="btn primary" id="identify-dme">Identify DME</button>
                     <span class="pill" id="flash-port">cable: …</span>`;
  view.appendChild(idBar);

  const ident = document.createElement('div');
  ident.className = 'results-panel';
  view.appendChild(ident);

  // two backup modes (matching MS45-Flasher): Tune (calibration only) and Full Bin
  // (external flash + MPC internal). disabled until the DME is identified.
  const tools = document.createElement('div');
  tools.className = 'flash-tools';
  tools.innerHTML = `
    <button class="btn primary" data-mode="tune" disabled>Backup Tune <span class="flash-sub">~118 KB · ~1-2 min</span></button>
    <button class="btn" data-mode="full" disabled>Backup Full Bin <span class="flash-sub">flash + MPC · ~15-20 min</span></button>
    <span class="flash-hint" id="backup-hint">Identify the DME first</span>`;
  view.appendChild(tools);

  const out = document.createElement('div');
  out.className = 'results-panel';
  view.appendChild(out);

  api('/api/port').then(p => {
    document.getElementById('flash-port').textContent =
      p.port ? `cable: ${p.port.replace('/dev/', '')}` : 'no cable';
  }).catch(() => {});

  // gate: identify enables the backup buttons + their f-keys
  let identified = false;
  const enableBackups = () => {
    identified = true;
    tools.querySelectorAll('button').forEach(b => b.disabled = false);
    const hint = document.getElementById('backup-hint'); if (hint) hint.remove();
  };
  const doIdentify = async () => { const ok = await identifyDme(ident); if (ok) enableBackups(); };

  document.getElementById('identify-dme').onclick = doIdentify;
  tools.querySelectorAll('button').forEach(b => {
    b.onclick = () => { if (identified) backupMode(flashEcu, b.dataset.mode, out); };
  });

  setActions([
    { key: '1', label: 'Identify DME', kind: 'primary', fn: doIdentify },
    { key: '2', label: 'Backup Tune', fn: () => { if (identified) backupMode(flashEcu, 'tune', out); } },
    { key: '3', label: 'Backup Full Bin', fn: () => { if (identified) backupMode(flashEcu, 'full', out); } },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showChassis },
  ]);
}

// Tune = calibration region (one file). Full Bin = external flash + MPC internal,
// read in one session so the second read doesn't collide. one .bin per region.
async function backupMode(ecu, mode, out) {
  await backupRegion(ecu, mode === 'tune' ? 'data' : 'fullbin', out);
}

async function identifyDme(ident) {
  ident.className = 'results-panel';
  ident.innerHTML = `<div class="empty"><span class="loader"></span><span>Identifying DME…</span></div>`;
  ident.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  sbLeft.textContent = 'IDENT…';
  try {
    const info = await api(`/api/flash/${FLASH_SGBD}/identify`, { method: 'POST' });
    ident.className = 'live-panel';
    const typeColor = info.supported ? 'var(--green)' : 'var(--red)';
    ident.innerHTML = `
      <div class="live-head">
        <span class="live-dot"></span>
        <span class="live-title">DME identity</span>
        <span class="dme-type" style="border-color:${typeColor};color:${typeColor}">${info.dmeType || 'Unknown'}</span>
      </div>
      <div class="dme-grid">
        <div class="live-cell"><div class="live-k">VIN</div><div class="live-v">${info.vin || '-'}</div></div>
        <div class="live-cell"><div class="live-k">HW ref</div><div class="live-v">${info.hwRef || '-'}</div></div>
        <div class="live-cell"><div class="live-k">SW ref</div><div class="live-v" style="font-size:14px">${info.swRef || '-'}</div></div>
        <div class="live-cell"><div class="live-k">Prog status</div><div class="live-v" style="font-size:13px">${info.programmingStatus || '-'}</div></div>
        <div class="live-cell"><div class="live-k">Protocol</div><div class="live-v" style="font-size:13px">${info.diagProtocol || '-'}</div></div>
      </div>`;
    sbLeft.textContent = `identified: ${info.dmeType}`;
    // only back up a recognized, supported DME
    if (!info.supported) {
      ident.insertAdjacentHTML('beforeend',
        `<div style="padding:10px 16px;color:var(--red);font-size:12px">⚠ Unsupported/unrecognized DME, backups disabled.</div>`);
      return false;
    }
    return true;
  } catch (e) {
    ident.className = 'results-panel';
    ident.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'identify failed';
    return false;
  }
}

// stream a backup (one or two regions, single session). server emits
// region/progress/done SSE events; panel per region, save each file.
async function backupRegion(ecu, region, out) {
  const REGION_TITLE = { data: 'Tune (calibration)', full: 'External flash (1 MB)', mpc: 'MPC internal (448 KB)' };
  out.className = 'live-panel';
  out.innerHTML = '';
  out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const stamp = (kind) => `MS45_${kind}_${ts}.bin`;

  let curName = null, fill = null, pctEl = null;
  let saved = 0;
  function newPanel(name) {
    curName = name;
    const block = document.createElement('div');
    block.className = 'flash-job';
    block.innerHTML = `
      <div class="live-head"><span class="live-dot"></span>
        <span class="live-title">Reading ${REGION_TITLE[name] || name}</span>
        <span class="live-meta job-pct">0%</span></div>
      <div style="padding:14px 16px"><div class="flash-bar"><div class="flash-bar-fill job-fill"></div></div></div>`;
    out.appendChild(block);
    fill = block.querySelector('.job-fill');
    pctEl = block.querySelector('.job-pct');
  }

  try {
    const res = await fetch(`${API}/api/flash/${ecu.sgbd}/read/${region}`, { method: 'POST' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', err = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = (blk.match(/event: (.*)/) || [])[1];
        const data = (blk.match(/data: ([\s\S]*)/) || [])[1];
        if (ev === 'region') { newPanel(data); sbLeft.textContent = `reading ${data}…`; }
        else if (ev === 'progress' && fill) { fill.style.width = data + '%'; pctEl.textContent = data + '%'; }
        else if (ev === 'error') err = data;
        else if (ev === 'done') {
          // data = "<region>|<base64>"
          const sep = data.indexOf('|');
          const name = data.slice(0, sep), b64 = data.slice(sep + 1);
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: 'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = stamp(name); a.click();
          if (fill) { fill.style.width = '100%'; pctEl.textContent = `100% · saved (${(bytes.length/1024).toFixed(0)} KB)`; }
          saved++;
        }
      }
    }
    if (err) throw new Error(err);
    if (saved === 0) throw new Error('no data received');
    sbLeft.textContent = `backup complete (${saved} file${saved === 1 ? '' : 's'})`;
  } catch (e) {
    out.insertAdjacentHTML('beforeend', errorBlock(e.message));
    sbLeft.textContent = 'backup failed';
  }
}

// sub-screen: one section's functions for an ECU
function showEcuSection(chassisId, sectionName, ecu, menu, sectionKey) {
  const sec = menu.sections.find(s => s.section === sectionKey);
  lastScreen = () => showEcuSection(chassisId, sectionName, ecu, menu, sectionKey);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => showSections(chassisId) },
    { label: ecu.label, fn: () => showEcu(chassisId, sectionName, ecu) },
    { label: sec.section },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  view.innerHTML = head(`${ecu.label} · ${ecu.code}`, sec.section,
    `${sec.items.length} function${sec.items.length === 1 ? '' : 's'}`);

  const results = document.createElement('div');
  results.className = 'results-panel';
  view.appendChild(results);

  // layout-mined sections (have _screen) render as gauge panels, not the
  // checkbox multi-watch list
  const isLayoutScreens = sec.items.some(i => i._screen);
  const isStatus = sec.section === 'Status' && !isLayoutScreens;
  const isActivations = sec.section === 'Activations';
  const selected = new Set();

  // activations get a dedicated actuator-test panel
  if (isActivations) {
    showActivations(ecu, sec, results);
    setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showEcu(chassisId, sectionName, ecu) }]);
    return;
  }

  // fault memory, INPA-style: actions only in the footer F-key bar (Read, Detail,
  // Clear, etc.), no in-body job rows
  const jobs0 = sec.items.map(i => i.job);
  const isFaults = jobs0.includes('FS_LESEN') && !isStatus;
  if (isFaults) {
    const backToEcu = () => showEcu(chassisId, sectionName, ecu);
    const hasJob = (j) => jobs0.includes(j);
    // only the jobs MS45 has
    const acts = [
      { key: '1', label: 'Read codes', kind: 'primary', fn: () => runJob(ecu, 'FS_LESEN', results, false) },
    ];
    if (hasJob('FS_LESEN_DETAIL'))        acts.push({ key: '2', label: 'Detail', fn: () => readFaultsDetailed(ecu, results) });
    if (hasJob('FS_LESEN_FREEZE_FRAME'))  acts.push({ key: '3', label: 'Freeze', fn: () => runJob(ecu, 'FS_LESEN_FREEZE_FRAME', results, false) });
    if (hasJob('FS_LESEN_HEX'))           acts.push({ key: '4', label: 'Hex', fn: () => runJob(ecu, 'FS_LESEN_HEX', results, false) });
    if (hasJob('FS_LOESCHEN'))            acts.push({ key: '5', label: 'Clear', kind: 'danger', fn: () => runJob(ecu, 'FS_LOESCHEN', results, true) });
    acts.push({ key: '7', label: 'Comment', fn: () => addFaultComment(ecu, results) });
    acts.push({ key: '9', label: 'Export', fn: () => exportFaults(ecu, view) });
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: backToEcu });
    setActions(acts);
    // prompt only, actions live in the footer F-key bar
    results.className = 'results-panel';
    results.innerHTML = `<div class="empty"><div>Press a function key below to read the fault memory: <b>1 Read</b>, <b>2 Detail</b>, <b>3 Freeze frame</b>, <b>4 Hex</b>.</div></div>`;
    return;
  }

  // status sections get a multi-watch toolbar
  let watchBtn, watchAllBtn;
  if (isStatus) {
    const bar = document.createElement('div');
    bar.className = 'watch-toolbar';
    bar.innerHTML = `
      <span class="watch-hint">Select values, then watch them together · stream to CSV with timestamps</span>
      <button class="btn watch-selected" disabled>Watch selected</button>
      <button class="btn primary watch-all">Watch all</button>`;
    view.appendChild(bar);
    watchBtn = bar.querySelector('.watch-selected');
    watchAllBtn = bar.querySelector('.watch-all');
    watchBtn.onclick = () => { if (selected.size) watchMulti(ecu, [...selected], results, view); };
    watchAllBtn.onclick = () => watchMulti(ecu, sec.items.map(i => i.job), results, view);
  }

  const list = document.createElement('div');
  list.className = 'job-list stagger';
  view.appendChild(list);

  const rowByJob = new Map(); // job -> row element, for watched highlighting
  sec.items.forEach(it => {
    const isLive = isStatus || /^STATUS|^MW_|MESSWERT/.test(it.job);
    const row = document.createElement('div');
    row.className = 'job-row' + (it.danger ? ' danger' : '') + (isStatus ? ' selectable' : '');
    row.innerHTML = `
      ${isStatus ? '<span class="job-check" role="checkbox" aria-checked="false"></span>' : '<span class="job-bullet"></span>'}
      <span class="job-label">${itemLabel(it)}</span>
      ${it.danger ? '<span class="job-warn">write</span>' : ''}`;
    if (isStatus) {
      rowByJob.set(it.job, row);
      // row click toggles selection
      row.onclick = () => {
        const check = row.querySelector('.job-check');
        if (selected.has(it.job)) { selected.delete(it.job); row.classList.remove('checked'); check.setAttribute('aria-checked', 'false'); }
        else { selected.add(it.job); row.classList.add('checked'); check.setAttribute('aria-checked', 'true'); }
        watchBtn.disabled = selected.size === 0;
        watchBtn.textContent = selected.size ? `Watch ${selected.size} selected` : 'Watch selected';
      };
    } else if (it._screen) {
      // mined gauge screen
      row.onclick = () => showInpaScreen(ecu, it._screen, results);
    } else if (it._input) {
      // mined input function
      row.onclick = () => runInputFunction(ecu, it._input, results);
    } else {
      row.onclick = () => isLive ? runJobLive(ecu, it.job, results) : runJob(ecu, it.job, results, it.danger);
    }
    list.appendChild(row);
  });
  // exposed so watchMulti can highlight watched rows
  view._rowByJob = rowByJob;
  stagger(list, 14);

  // quick keys for common jobs + back to ECU menu
  const jobsHere = sec.items.map(i => i.job);
  const has = (j) => jobsHere.includes(j);
  const acts = [];
  if (has('FS_LESEN')) acts.push({ key: '1', label: 'Read codes', kind: 'primary', fn: () => runJob(ecu, 'FS_LESEN', results, false) });
  if (has('FS_LOESCHEN')) acts.push({ key: '2', label: 'Clear codes', kind: 'danger', fn: () => runJob(ecu, 'FS_LOESCHEN', results, true) });
  if (isStatus) acts.push({ key: '1', label: 'Watch all', kind: 'primary', fn: () => watchMulti(ecu, sec.items.map(i => i.job), results, view) });
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showEcu(chassisId, sectionName, ecu) });
  setActions(acts);
}

// activations (INPA F6): actuator tests, paired start/stop (toggle) or one-shot
// (momentary). writes to the ECU, so every run is confirmed.
const activeTests = new Set(); // jobs currently on
let activationEcu = null;       // ecu whose tests are active, for cleanup
async function showActivations(ecu, sec, container) {
  activationEcu = ecu;
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Loading actuator tests…</span></div>`;
  let acts;
  try { acts = await api(`/api/ecu/${ecu.sgbd}/activations`); }
  catch (e) { container.innerHTML = `<div class="empty"><div>${e.message}</div></div>`; return; }

  if (!acts.length) {
    container.innerHTML = `<div class="empty"><div>No actuator tests for this module.</div></div>`;
    return;
  }

  container.className = 'act-panel';
  const warn = document.createElement('div');
  warn.className = 'act-warning';
  warn.innerHTML = `⚠ Actuator tests drive real components (fans, pumps, injectors, valves). Run only with the engine off / ignition on unless you know the test. Active tests stop when you leave.`;
  const grid = document.createElement('div');
  grid.className = 'act-grid stagger';
  container.innerHTML = '';
  container.appendChild(warn);
  container.appendChild(grid);

  acts.forEach(a => {
    const card = document.createElement('div');
    card.className = 'act-card';
    const running = activeTests.has(a.start);
    card.innerHTML = `
      <div class="act-info">
        <div class="act-label">${a.label.replace(/^Activate /, '')}</div>
        <div class="act-jobs">${a.start}${a.stop ? ` · ${a.stop}` : ''}</div>
      </div>
      <button class="btn act-btn ${a.momentary ? '' : (running ? 'danger on' : 'primary')}">${
        a.momentary ? 'Run' : (running ? 'Stop' : 'Activate')
      }</button>`;
    const btn = card.querySelector('.act-btn');
    btn.onclick = () => toggleActivation(ecu, a, card, btn);
    grid.appendChild(card);
  });
  stagger(grid, 20);
}

// per-job activation argument from INPA .ips cross-referenced to MS45's job list.
// kinds: percent = drive 0-99 (PWM), binary = 1 on / 0 off, none = momentary.
// verified on the car for E_LUEFTER (99 -> 98% readback) and EKP.
const ACTIVATION_SPEC = {
  STEUERN_E_LUEFTER: { kind: 'percent', on: 99 },   // electric fan
  STEUERN_TEV:       { kind: 'percent', on: 90 },   // purge valve (INPA ;90;)
  STEUERN_SLP:       { kind: 'percent', on: 99 },   // secondary air pump
  STEUERN_EKP:       { kind: 'binary',  on: 1 },    // fuel pump, MS45 only takes 0/1
                                                     // (arg=3 -> CONDITIONS_NOT_CORRECT, verified)
  STEUERN_KOREL:     { kind: 'binary',  on: 1 },
  STEUERN_EBL:       { kind: 'binary',  on: 1 },
  STEUERN_AGK:       { kind: 'binary',  on: 1 },
  STEUERN_DMTL_P:    { kind: 'binary',  on: 1 },
  STEUERN_DMTL_V:    { kind: 'binary',  on: 1 },
  STEUERN_DMTL_H:    { kind: 'binary',  on: 1 },
  STEUERN_GLF:       { kind: 'binary',  on: 1 },
  STEUERN_MIL:       { kind: 'binary',  on: 1 },    // check-engine lamp on
  STEUERN_EV_1:      { kind: 'binary',  on: 1 },    // injectors (pulse)
  STEUERN_EV_2:      { kind: 'binary',  on: 1 },
  STEUERN_EV_3:      { kind: 'binary',  on: 1 },
  STEUERN_EV_4:      { kind: 'binary',  on: 1 },
  STEUERN_EV_5:      { kind: 'binary',  on: 1 },
  STEUERN_EV_6:      { kind: 'binary',  on: 1 },
  STEUERN_LSVK1H:    { kind: 'binary',  on: 1 },    // O2 heaters
  STEUERN_LSVK2H:    { kind: 'binary',  on: 1 },
  STEUERN_LSHK1H:    { kind: 'binary',  on: 1 },
  STEUERN_LSHK2H:    { kind: 'binary',  on: 1 },
  STEUERN_STA:       { kind: 'binary',  on: 1 },    // starter relay
};
// default binary on=1 (safer than blasting 99 to a relay)
const actSpec = (job) => ACTIVATION_SPEC[job] || { kind: 'binary', on: 1 };
const actValue = (job) => actSpec(job).on;

// actuator tests have a short ECU watchdog: re-send the start command on a timer
// or the output stops
const keepAliveTimers = new Map(); // start job -> interval id

async function sendActivation(ecu, job, value) {
  const q = value == null ? '' : `?arg=${value}`;
  const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' });
  // ECU verdict: OKAY vs condition/sequence error
  const last = (data.sets || []).slice(-1)[0] || {};
  return last.JOB_STATUS || '';
}

async function toggleActivation(ecu, a, card, btn) {
  const running = activeTests.has(a.start);
  if (!running || a.momentary) {
    const ok = await confirmDialog({
      title: `Run actuator test?`,
      body: `<b>${a.label.replace(/^Activate /, '')}</b> will drive a component on <b>${ecu.label}</b> (<span class="mono">${a.start}</span>).${a.momentary ? '' : ' It stays active (re-sent continuously) until you press Stop or leave this screen.'} Continue?`,
      confirmLabel: a.momentary ? 'Run' : 'Activate',
      danger: true,
    });
    if (!ok) return;
  }
  const value = actValue(a.start);
  try {
    if (a.momentary) {
      const st = await sendActivation(ecu, a.start, value);
      btn.classList.add('flash');
      sbLeft.textContent = st === 'OKAY' ? `${a.start} ran` : st;
      if (st && st !== 'OKAY') showActivationError(a, st);
      return;
    }
    if (running) {
      stopKeepAlive(a.start);
      // Stop = drive the output to 0. The ECU rejects _ENDE in an active session,
      // but arg=0 de-energizes (verified: fuel pump, e-fan). _ENDE only as fallback.
      const off = await sendActivation(ecu, a.start, 0).catch(() => 'ERR');
      if (off !== 'OKAY' && a.stop) {
        await api(`/api/ecu/${ecu.sgbd}/run/${a.stop}`, { method: 'POST' }).catch(() => {});
      }
      activeTests.delete(a.start);
      btn.textContent = 'Activate'; btn.className = 'btn act-btn primary'; card.classList.remove('running');
      sbLeft.textContent = `${a.start} stopped`;
    } else {
      const st = await sendActivation(ecu, a.start, value);
      if (st && st !== 'OKAY') { showActivationError(a, st); sbLeft.textContent = st; return; }
      activeTests.add(a.start);
      btn.textContent = 'Stop'; btn.className = 'btn act-btn danger on'; card.classList.add('running');
      sbLeft.textContent = `${a.start} active`;
      // keep-alive: re-send before the ECU watchdog times out
      const t = setInterval(() => sendActivation(ecu, a.start, value).catch(() => {}), 500);
      keepAliveTimers.set(a.start, t);
    }
  } catch (e) {
    sbLeft.textContent = 'test failed';
    confirmDialog({ title: 'Test failed', body: e.message, confirmLabel: 'OK', cancelLabel: 'Close' });
  }
}

function showActivationError(a, status) {
  const e = explainError(status);
  confirmDialog({
    title: `${a.label.replace(/^Activate /, '')}: ${e.title}`,
    body: `${e.detail}<br><br>${e.fix}<br><br><span class="mono" style="font-size:11px;color:var(--ink-faint)">${status}</span>`,
    confirmLabel: 'OK', cancelLabel: 'Close',
  });
}

function stopKeepAlive(job) {
  const t = keepAliveTimers.get(job);
  if (t) { clearInterval(t); keepAliveTimers.delete(job); }
}

// stop all running actuator tests, on leaving the screen
function stopAllActivations(ecu) {
  if (!activeTests.size) return;
  const ecuSgbd = ecu?.sgbd;
  for (const start of [...activeTests]) {
    stopKeepAlive(start);
    if (ecuSgbd) {
      // arg=0 de-energizes, _ENDE only as fallback
      api(`/api/ecu/${ecuSgbd}/run/${start}?arg=0`, { method: 'POST' })
        .catch(() => api(`/api/ecu/${ecuSgbd}/run/${start}_ENDE`, { method: 'POST' }).catch(() => {}));
    }
    activeTests.delete(start);
  }
}

// jobs that require an argument (from INPA .ips), else they no-op or error.
// 'prompt' asks the user, 'fixed' sends a default.
const JOB_ARGS = {
  MESSWERTBLOCK_LESEN:   { prompt: 'Measurement IDs, comma-separated (e.g. 0x4300,0x4301)', placeholder: '0x4300,0x4301' },
  SPEICHER_LESEN_ASCII:  { prompt: 'Memory area (e.g. LAR;0x...)', placeholder: 'LAR;0x0000' },
  C_FG_LESEN:            { fixed: ';0' },
  AIF_LESEN:             { fixed: '0' },
  IDENT_AIF:             { fixed: '0' },
  DIAGNOSE_MODE:         { fixed: 'DEFAULT' },
  FS_SPERREN:            { prompt: 'Lock fault memory? JA (yes) / NEIN (no)', placeholder: 'NEIN' },
  DIAGNOSEPROTOKOLL_SETZEN: { fixed: 'BMW-FAST' },
  // CBS reset service codes: br_h=brake fluid, oel=oil, mik=microfilter, zb=plugs
  CBS_RESET:             { prompt: 'CBS service to reset (br_h=brake fluid, oel=oil, mik=microfilter)', placeholder: 'oel', suffix: ';100;1;0;0;0x8000;1;0;0' },
};

// text-input modal -> Promise<string|null>
function promptDialog({ title, body, placeholder = '', value = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <input class="modal-input" type="text" placeholder="${placeholder}" value="${value}" />
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const input = overlay.querySelector('.modal-input');
    const close = (val) => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(input.value.trim() || null); }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(input.value.trim() || null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    setTimeout(() => input.focus(), 50);
  });
}

// run a job and render its result sets. FS_LESEN gets the fault-card view, others
// a generic key/value table.
async function runJob(ecu, job, container, danger, presetArg) {
  // resolve a required argument first
  let arg = presetArg;
  const spec = JOB_ARGS[job];
  if (arg == null && spec) {
    if (spec.fixed != null) arg = spec.fixed;
    else if (spec.prompt) {
      arg = await promptDialog({ title: jobLabel(job), body: spec.prompt, placeholder: spec.placeholder || '' });
      if (arg == null) return; // cancelled
      if (spec.suffix) arg += spec.suffix; // e.g. CBS_RESET service code + tail
    }
  }
  if (danger) {
    const isClear = job === 'FS_LOESCHEN';
    const ok = await confirmDialog({
      title: isClear ? 'Clear fault codes?' : `Run ${jobLabel(job)}?`,
      body: isClear
        ? `This permanently erases the fault memory on <b>${ecu.label}</b>. Stored and pending faults will be deleted. This cannot be undone.`
        : `<b>${jobLabel(job)}</b> (<span class="mono">${job}</span>) writes to the ECU on <b>${ecu.label}</b>. Continue?`,
      confirmLabel: isClear ? 'Clear codes' : 'Run',
      danger: true,
    });
    if (!ok) return;
  }
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${jobLabel(job)}…</span></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  sbLeft.textContent = `${job}…`;
  try {
    const q = arg != null && arg !== '' ? `?arg=${encodeURIComponent(arg)}` : '';
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' });
    if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL') {
      const codes = data.sets.slice(1); // set 0 = system summary
      renderFaults(codes, container, ecu);
      sbLeft.textContent = `${codes.length} fault(s)`;
    } else if (job === 'FS_LOESCHEN') {
      container.innerHTML = `<div class="empty"><div class="empty-big">Fault memory cleared</div><div>Re-read to confirm.</div></div>`;
      sbLeft.textContent = 'cleared';
    } else {
      renderResultSets(data.sets, container, job);
      sbLeft.textContent = 'done';
    }
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

// render one mined layout screen as a refreshing gauge-bar panel using the screen's
// own labels/units/ranges, polling its job/args. two-column when the layout marks
// columns:2 (Bank 1 / Bank 2).
async function showInpaScreen(ecu, screen, container) {
  stopLive();
  const job = screen.job;
  const arg = screen.args || '';
  const rows = screen.rows || [];
  // result-key -> layout row spec, for labels/scaling
  const spec = new Map(rows.map(r => [r.key, r]));

  container.className = 'live-panel';
  container.innerHTML = `
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-title">${screen.group || jobLabel(job)}</span>
      <span class="live-meta" id="live-meta">connecting…</span>
      <button class="btn danger live-stop">Stop</button>
    </div>
    <div class="live-grid inpa-grid${screen.columns === 2 ? ' two-col' : ''}" id="live-grid"></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const grid = container.querySelector('#live-grid');
  const meta = container.querySelector('#live-meta');
  const dot = container.querySelector('.live-dot');
  container.querySelector('.live-stop').onclick = () => {
    stopLive(); dot.classList.add('stopped'); meta.textContent = 'stopped'; sbLeft.textContent = 'stopped';
  };

  const cellEls = new Map(); // key -> gauge cell

  async function tick() {
    let data;
    try {
      const url = `/api/ecu/${ecu.sgbd}/run/${job}` + (arg ? `?arg=${encodeURIComponent(arg)}` : '');
      data = await api(url, { method: 'POST' });
    } catch (e) {
      stopLive(); container.className = 'results-panel';
      container.innerHTML = errorBlock(e.message); sbLeft.textContent = 'failed'; return;
    }
    // flatten sets into key->value
    const sets = data.sets || [];
    const real = sets.length > 1 ? sets.slice(1) : sets;
    const vals = new Map();
    real.forEach(s => Object.entries(s).forEach(([k, v]) => { if (!k.startsWith('_') && k !== 'JOB_STATUS') vals.set(k, v); }));

    // render in layout row order so Bank 1 / Bank 2 pair up in two columns
    for (const r of rows) {
      if (!vals.has(r.key)) continue;
      let cell = cellEls.get(r.key);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'live-cell gauge-cell';
        cell.innerHTML = gaugeCellHTML(r.label || r.key);
        grid.appendChild(cell);
        cellEls.set(r.key, cell);
      }
      updateGaugeSpec(cell, r, vals.get(r.key));
    }
    meta.textContent = `live · ${cellEls.size} values`;
    sbLeft.textContent = `${job}${arg ? ' ' + arg : ''} · live`;
  }
  await tick();
  if (liveTimer === null && container.querySelector('.inpa-grid')) liveTimer = setInterval(tick, 1000);
}

// update a gauge cell from the layout row's unit/min/max, falling back to the
// heuristic range only where the layout left them null
function updateGaugeSpec(cellEl, rowSpec, raw) {
  const p = parseMeasurement(raw);
  const valEl = cellEl.querySelector('.gauge-val');
  if (p.num === null) {
    cellEl.classList.add('text-only');
    if (valEl.textContent !== p.raw) { valEl.textContent = p.raw; flash(valEl); }
    return;
  }
  cellEl.classList.remove('text-only');
  let min = rowSpec.min, max = rowSpec.max;
  if (min == null || max == null) {
    const r = rangeFor(rowSpec.unit || p.unit, p.num, rowSpec.label);
    if (min == null) min = r[0];
    if (max == null) max = r[1];
  }
  if (p.num < min) min = p.num;
  if (p.num > max) max = p.num;
  const span = (max - min) || 1;
  const pct = Math.max(0, Math.min(100, ((p.num - min) / span) * 100));
  cellEl.querySelector('.gauge-fill').style.width = pct.toFixed(1) + '%';
  cellEl.querySelector('.gauge-min').textContent = fmtRange(min);
  cellEl.querySelector('.gauge-max').textContent = fmtRange(max);
  const unit = rowSpec.unit ? ` ${rowSpec.unit}` : (p.unit ? ` ${p.unit}` : '');
  const shown = `${p.num}${unit}`;
  if (valEl.textContent !== shown) { valEl.textContent = shown; flash(valEl); }
}

// live Status view: poll a measurement job into a refreshing value table. stops
// on leave or Stop.
let liveTimer = null;
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

async function runJobLive(ecu, job, container) {
  stopLive();
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading ${jobLabel(job)}…</span></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // build the panel once; ticks update gauge cells in place (no flicker)
  let built = false;
  let grid = null, metaEl = null, dotEl = null, titleEl = null;
  const cellEls = new Map(); // key -> gauge cell element

  function build() {
    container.className = 'live-panel';
    container.innerHTML = `
      <div class="live-head">
        <span class="live-dot"></span>
        <span class="live-title">${jobLabel(job)}</span>
        <span class="live-meta" id="live-meta">connecting…</span>
        <button class="btn danger live-stop">Stop</button>
      </div>
      <div class="live-grid" id="live-grid"></div>`;
    grid = container.querySelector('#live-grid');
    metaEl = container.querySelector('#live-meta');
    dotEl = container.querySelector('.live-dot');
    titleEl = container.querySelector('.live-title');
    container.querySelector('.live-stop').onclick = () => {
      stopLive(); dotEl.classList.add('stopped'); metaEl.textContent = 'stopped';
      sbLeft.textContent = 'stopped';
    };
    built = true;
  }

  async function tick() {
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
      const sets = data.sets || [];
      const real = sets.length > 1 ? sets.slice(1) : sets;
      // flatten named, non-internal results into ordered key/value pairs
      const rows = [];
      real.forEach(set => Object.entries(set).forEach(([k, v]) => {
        if (!k.startsWith('_') && k !== 'JOB_STATUS') rows.push([k, v]);
      }));
      if (!built) build();
      if (rows.length === 0 && cellEls.size === 0) {
        grid.innerHTML = '<div class="empty"><div>No live values returned.</div></div>';
      }
      for (const [k, v] of rows) {
        let cell = cellEls.get(k);
        if (!cell) {
          cell = document.createElement('div');
          cell.className = 'live-cell gauge-cell';
          cell.innerHTML = gaugeCellHTML(k);
          grid.appendChild(cell);
          cellEls.set(k, cell);
        }
        updateGauge(cell, k, v);
      }
      metaEl.textContent = `live · ${cellEls.size} values`;
      sbLeft.textContent = `${job} · live`;
    } catch (e) {
      stopLive();
      container.className = 'results-panel';
      container.innerHTML = errorBlock(e.message);
      sbLeft.textContent = 'failed';
    }
  }
  await tick();
  if (liveTimer === null && container.querySelector('.live-grid')) liveTimer = setInterval(tick, 1000);
}

// multi-watch: poll several Status jobs together into one live grid, optionally
// streaming timestamped rows to CSV
let logId = null;          // active CSV log id from the main process
let logColumns = null;     // fixed column order while logging
function stopLogging() {
  if (logId && window.bmacw) window.bmacw.stopLog(logId);
  logId = null; logColumns = null;
}

let logStart = 0;
function highlightWatched(view, jobs) {
  const map = view && view._rowByJob;
  if (!map) return;
  map.forEach((row) => row.classList.remove('watching'));
  if (jobs) jobs.forEach((j) => map.get(j)?.classList.add('watching'));
}

// INPA-style gauge bars. EDIABAS gives a value (sometimes a unit). the min/max
// range is INPA's own presentation choice from its .ips scripts, not in the
// protocol, so reproduce common ranges by unit and auto-scale the rest. non-numeric
// values render as plain text.

// split "38.67", "-5.7", "1.02 V", "98 %" into { num, unit, raw }
function parseMeasurement(raw) {
  const s = String(raw).trim();
  // number (optional sign/decimal/exponent) then optional unit token
  const m = s.match(/^(-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?)\s*(.*)$/);
  if (!m) return { num: null, unit: '', raw: s };
  const num = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(num)) return { num: null, unit: '', raw: s };
  let unit = (m[2] || '').trim();
  if (/^grad/i.test(unit)) unit = '°';
  return { num, unit, raw: s };
}

// pick [min,max] for a measurement, by unit first (INPA's ranges), then by the
// value's magnitude as a fallback for uncatalogued units
function rangeFor(unit, num, key) {
  const u = (unit || '').toLowerCase();
  const k = (key || '').toLowerCase();
  // unit-based ranges cover most MSD/MSV/MEVD status screens
  if (u === '%') {
    // correction factors (adaption/trim) are symmetric about 0
    if (/(adaption|adaptionsfaktor|korrektur|integrator|trim|gemischadaption|einspritzzeit)/.test(k))
      return [-50, 50];
    return [0, 100];
  }
  if (u === 'mg/stk' || u === 'mg/hub') return [-700, 700];
  if (u === 'v') return [0, 16];
  if (u === '°' || u === '°c' || u === 'c') return [-40, 140];
  if (u === '°kw' || u === 'kw') return [-30, 60];   // crank-angle (timing/VANOS)
  if (u === '1/min' || u === 'rpm' || u === 'u/min') return [0, 8000];
  if (u === 'km/h') return [0, 260];
  if (u === 'mbar' || u === 'hpa') return [0, 2500];
  if (u === 'bar') return [0, 5];
  if (u === 'nm') return [0, 600];
  if (u === 'ms') return [0, 25];
  if (u === 'l/h') return [0, 60];
  if (u === 'a') return [-30, 30];
  if (u === 'ohm') return [0, 100];
  if (u === '' ) {
    // unitless: lambda sits near 1.0, flags are 0/1
    if (/lambda|lambdawert/.test(k)) return [0, 2];
    if (num === 0 || num === 1) return [0, 1];
  }
  // auto-scale around the observed value
  if (num === 0) return [0, 1];
  const mag = Math.abs(num);
  if (num < 0) return [-roundNice(mag * 2), roundNice(mag * 2)];
  return [0, roundNice(mag * 1.5)];
}

function roundNice(x) {
  if (x <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function fmtRange(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 10 ? 1 : 0);
}

// German measurement-key tokens -> English, for humanizing raw STAT_*_WERT keys
// on ECUs with no mined layout (e.g. GSDS2 transmission)
const KEY_TOKENS = {
  MOTOR: 'engine', MOTORDREHZAHL: 'engine RPM', DREHZAHL: 'RPM', ABTRIEBSDREHZAHL: 'output speed',
  STEGDREHZAHL: 'planetary speed', RADDREHZAHL: 'wheel speed', GETRIEBE: 'gearbox',
  GETRIEBETEMPERATUR: 'gearbox temp', MOTORTEMPERATUR: 'engine temp', TEMPERATUR: 'temperature',
  TEMP: 'temp', LAST: 'load', DKG: 'clutch', UBAT: 'battery voltage', SPANNUNG: 'voltage',
  DRUCK: 'pressure', LADEDRUCK: 'boost', GANG: 'gear', FAHRSTUFE: 'gear position',
  KUPPLUNG: 'clutch', BREMSE: 'brake', LAMBDA: 'lambda', GEMISCH: 'mixture',
  ZUENDUNG: 'ignition', EINSPRITZ: 'injection', OEL: 'oil', KUEHL: 'coolant',
  GESCHWINDIGKEIT: 'speed', POSITION: 'position', SOLL: 'target', IST: 'actual',
  VL: 'front-left', VR: 'front-right', HL: 'rear-left', HR: 'rear-right',
  EIN: '', AUS: '', STATUS: 'status', WERT: '',
};
// normalize an EDIABAS unit string to a compact symbol
function normUnit(u) {
  const s = String(u || '').trim();
  if (/^grad\s*c$/i.test(s) || /^°?\s*c$/i.test(s)) return '°C';
  if (/^grad$/i.test(s)) return '°';
  if (/^1\/min$/i.test(s) || /^u\/min$/i.test(s)) return '1/min';
  if (/^volt$/i.test(s)) return 'V';
  return s;
}
// STAT_MOTORTEMPERATUR_WERT -> "Engine temp"
function humanizeKey(key) {
  let k = String(key).replace(/^STAT_/, '').replace(/_WERT$|_EINH$/i, '');
  const words = k.split('_').map(tok => {
    const up = tok.toUpperCase();
    if (up in KEY_TOKENS) return KEY_TOKENS[up];
    return tok.charAt(0) + tok.slice(1).toLowerCase();
  }).filter(Boolean);
  const label = words.join(' ').replace(/\s+/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : key;
}

// pair STAT_X_WERT with STAT_X_EINH and humanize the key. one entry per
// measurement, unit merged in ("13" + "Grad C" -> "13 °C"). keys without
// _WERT/_EINH structure pass through unchanged.
function pairWertEinh(merged) {
  const out = [];
  const seen = new Set();
  const has = (k) => merged.has(k);
  for (const [k, v] of merged) {
    if (seen.has(k)) continue;
    const m = k.match(/^(.*)_WERT$/);
    if (m) {
      const base = m[1];
      const unitKey = base + '_EINH';
      const unit = has(unitKey) ? normUnit(merged.get(unitKey)) : '';
      if (has(unitKey)) seen.add(unitKey);
      seen.add(k);
      out.push({ key: k, label: humanizeKey(k), value: v, unit });
      continue;
    }
    // stray _EINH with no matching _WERT: show as text
    if (/_EINH$/.test(k)) { seen.add(k); out.push({ key: k, label: humanizeKey(k), value: merged.get(k), unit: '' }); continue; }
    seen.add(k);
    out.push({ key: k, label: humanizeKey(k), value: v, unit: '' });
  }
  return out;
}

function gaugeCellHTML(key) {
  return `
    <div class="live-k">${key}</div>
    <div class="gauge">
      <div class="gauge-track"><div class="gauge-fill"></div></div>
      <div class="gauge-foot">
        <span class="gauge-min"></span>
        <span class="gauge-val live-v"></span>
        <span class="gauge-max"></span>
      </div>
    </div>`;
}

// update a gauge cell in place from a parsed measurement
function updateGauge(cellEl, key, raw) {
  const p = parseMeasurement(raw);
  const valEl = cellEl.querySelector('.gauge-val');
  // non-numeric: plain text, hide the bar
  if (p.num === null) {
    cellEl.classList.add('text-only');
    if (valEl.textContent !== p.raw) {
      valEl.textContent = p.raw;
      flash(valEl);
    }
    return;
  }
  cellEl.classList.remove('text-only');
  let [min, max] = rangeFor(p.unit, p.num, key);
  // expand the range if the live value blows past it (keeps the bar honest)
  if (p.num < min) min = p.num;
  if (p.num > max) max = p.num;
  const span = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((p.num - min) / span) * 100));
  const fill = cellEl.querySelector('.gauge-fill');
  fill.style.width = pct.toFixed(1) + '%';
  cellEl.querySelector('.gauge-min').textContent = fmtRange(min);
  cellEl.querySelector('.gauge-max').textContent = fmtRange(max);
  // round long decimals for display (e.g. 8.969696969 -> 8.97), keep the unit
  const numStr = Number.isInteger(p.num) ? String(p.num)
    : (Math.abs(p.num) >= 100 ? p.num.toFixed(1) : p.num.toFixed(2));
  const shown = p.unit ? `${numStr} ${p.unit}` : numStr;
  if (valEl.textContent !== shown) {
    valEl.textContent = shown;
    flash(valEl);
  }
}

function flash(el) {
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

async function watchMulti(ecu, jobs, container, view) {
  stopLive();
  stopLogging();
  highlightWatched(view, jobs);

  // build the panel once; ticks only update value cells (no flicker)
  container.className = 'live-panel';
  container.innerHTML = `
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-title">Watching ${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
      <span class="live-meta" id="live-meta">connecting…</span>
      <button class="btn live-log" id="live-log">Stream to file…</button>
      <button class="btn danger live-stop" id="live-stop">Stop</button>
    </div>
    <div class="live-grid" id="live-grid"></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const grid = container.querySelector('#live-grid');
  const meta = container.querySelector('#live-meta');
  const dot = container.querySelector('.live-dot');
  const logBtn = container.querySelector('#live-log');
  const cellEls = new Map(); // key -> value <div> (updated in place)

  const stop = () => {
    stopLive(); stopLogging();
    highlightWatched(view, null);
    dot.classList.add('stopped');
    meta.textContent = 'stopped';
    container.querySelector('.live-title').textContent = `Stopped · ${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    logBtn.textContent = 'Stream to file…';
    sbLeft.textContent = 'stopped';
  };
  container.querySelector('#live-stop').onclick = stop;
  logBtn.onclick = () => toggleLogging();

  function toggleLogging() {
    if (!window.bmacw) { sbLeft.textContent = 'logging unavailable'; return; }
    if (logId) { stopLogging(); logBtn.textContent = 'Stream to file…'; meta.classList.remove('rec'); sbLeft.textContent = 'log saved'; return; }
    logColumns = [...cellEls.keys()];
    if (logColumns.length === 0) { sbLeft.textContent = 'no values yet'; return; }
    const header = ['timestamp_iso', 'elapsed_ms', ...logColumns];
    const name = `bmacw-${ecu.sgbd}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    window.bmacw.startLog(name, header).then((res) => {
      if (res && res.ok) { logId = res.id; logStart = Date.now(); logBtn.textContent = 'Stop logging'; meta.classList.add('rec'); sbLeft.textContent = `logging → ${res.path.split('/').pop()}`; }
    });
  }

  async function readAll() {
    const merged = new Map();
    await Promise.all(jobs.map(async (job) => {
      try {
        const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
        const real = (data.sets || []).slice(1).length ? data.sets.slice(1) : (data.sets || []);
        real.forEach(set => Object.entries(set).forEach(([k, v]) => {
          if (!k.startsWith('_') && k !== 'JOB_STATUS') merged.set(k, v);
        }));
      } catch { /* one job failing shouldn't kill the whole watch */ }
    }));
    return merged;
  }

  async function tick() {
    let merged;
    try { merged = await readAll(); }
    catch (e) {
      stop();
      meta.textContent = 'read failed';
      return;
    }
    // pair value+unit (STAT_x_WERT + STAT_x_EINH -> one reading), humanize key to
    // English, update each gauge cell in place
    const entries = pairWertEinh(merged);
    for (const e of entries) {
      let cell = cellEls.get(e.key);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'live-cell gauge-cell';
        cell.innerHTML = gaugeCellHTML(e.label);
        grid.appendChild(cell);
        cellEls.set(e.key, cell);
      }
      // feed value + merged unit so the gauge shows "13 °C" and scales by unit
      updateGauge(cell, e.label, e.unit ? `${e.value} ${e.unit}` : e.value);
    }
    meta.textContent = `live · ${cellEls.size} values`;
    if (logId && logColumns) {
      window.bmacw.appendLog(logId, [new Date().toISOString(), String(Date.now() - logStart),
        ...logColumns.map(k => merged.has(k) ? merged.get(k) : '')]);
    }
  }

  await tick();
  liveTimer = setInterval(tick, 1000);
}

// generic result renderer: one card per result set, key/value rows
function renderResultSets(sets, container, job) {
  if (!sets || sets.length === 0) {
    container.innerHTML = `<div class="empty"><div>No results from ${job}.</div></div>`;
    return;
  }
  container.className = 'results-panel stagger';
  container.innerHTML = '';
  // skip set 0 (system summary) when real sets follow
  const real = sets.length > 1 ? sets.slice(1) : sets;
  real.forEach((set, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const rows = Object.entries(set)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `<div class="kv"><span class="kv-k">${k}</span><span class="kv-v">${v}</span></div>`)
      .join('');
    card.innerHTML = `${real.length > 1 ? `<div class="result-head">set ${idx + 1}</div>` : ''}${rows}`;
    container.appendChild(card);
  });
  stagger(container, 30);
}

// fixed German -> English fault phrases (symptom / presence / warning-lamp /
// readiness texts)
const FAULT_PHRASES = [
  // symptom (F_SYMPTOM_TEXT)
  ['kein Signal oder Wert', 'No signal or value'],
  ['Signal oder Wert unterhalb Schwelle', 'Signal or value below threshold'],
  ['Signal oder Wert oberhalb Schwelle', 'Signal or value above threshold'],
  ['Signal oder Wert unplausibel', 'Signal or value implausible'],
  ['Kurzschluss nach Masse', 'Short circuit to ground'],
  ['Kurzschluss nach Plus', 'Short circuit to positive'],
  ['Kurzschluss nach Batterie', 'Short circuit to battery'],
  ['Leitungsunterbrechung', 'Open circuit'],
  ['mechanischer Fehler', 'Mechanical fault'],
  ['elektrischer Fehler', 'Electrical fault'],
  // presence (F_VORHANDEN_TEXT)
  ['Fehler momentan nicht vorhanden, OBD-entprellt', 'Not currently present (OBD-confirmed)'],
  ['Fehler momentan nicht vorhanden, nicht OBD-entprellt', 'Not currently present (not OBD-confirmed)'],
  ['Fehler momentan vorhanden, noch nicht OBD-entprellt', 'Currently present (not yet OBD-confirmed)'],
  ['Fehler momentan vorhanden, nicht OBD-entprellt', 'Currently present (not OBD-confirmed)'],
  ['Fehler momentan vorhanden, OBD-entprellt', 'Currently present (OBD-confirmed)'],
  ['Fehler momentan nicht vorhanden', 'Not currently present'],
  ['Fehler momentan vorhanden', 'Currently present'],
  // warning lamp (F_WARNUNG_TEXT)
  ['Fehler verursacht kein Aufleuchten der Warnlampe (MIL)', 'No MIL'],
  ['Fehler wuerde das Aufleuchten der Warnlampe (MIL) verursachen', 'Would trigger MIL'],
  ['Fehler verursacht das Aufleuchten der Warnlampe (MIL)', 'Triggers MIL'],
  // readiness (F_READY_TEXT)
  ['Testbedingungen erfüllt', 'Test conditions met'],
  ['Testbedingungen nicht erfüllt', 'Test conditions not met'],
];
// German fault/P-code-text word tokens -> English, for phrases not in the exact
// table (e.g. "Luftsystem - Durchsatzfehler erkannt"). order matters: longer
// compounds first so they win before their fragments.
const DE_TOKENS = [
  [/Sekundärluftsystem/gi, 'secondary air system'],
  [/Thermischer Ölniveausensor/gi, 'thermal oil level sensor'],
  [/Motorölniveausensor/gi, 'engine oil level sensor'],
  [/Ölniveausensor/gi, 'oil level sensor'],
  [/Durchsatzfehler erkannt/gi, 'flow fault detected'],
  [/Durchsatzfehler/gi, 'flow fault'],
  [/Plausibilitätsfehler/gi, 'plausibility fault'],
  [/Übertemperatur/gi, 'over-temperature'],
  [/Untertemperatur/gi, 'under-temperature'],
  [/Luftsystem/gi, 'air system'], [/Luftmasse/gi, 'air mass'],
  [/Kraftstoffsystem/gi, 'fuel system'], [/Zündsystem/gi, 'ignition system'],
  [/Generator/gi, 'alternator'], [/Lichtmaschine/gi, 'alternator'],
  [/Kurzschluss nach Masse/gi, 'short to ground'], [/Kurzschluss nach Plus/gi, 'short to positive'],
  [/Leitungsunterbrechung/gi, 'open circuit'], [/Unterbrechung/gi, 'open circuit'],
  [/unterhalb Schwelle/gi, 'below threshold'], [/oberhalb Schwelle/gi, 'above threshold'],
  [/unplausibel/gi, 'implausible'], [/erkannt/gi, 'detected'],
  [/Signal/gi, 'signal'], [/Fehler/gi, 'fault'],
];
function deGerman(text) {
  if (!text) return text;
  if (lang() === 'orig') return text; // keep German in EDIABAS mode
  let t = text;
  for (const [de, en] of FAULT_PHRASES) if (t === de) return en;
  // token-level fallback for partial/unlisted phrases (P-code text, etc.)
  let out = t;
  for (const [re, en] of DE_TOKENS) out = out.replace(re, en);
  return out;
}

// environment-measurement labels (F_UW*_TEXT) German -> English. skipped when
// Original (EDIABAS) labels are set.
const ENV_LABELS = {
  'Motordrehzahl': 'Engine RPM',
  'Lichtmaschine Sollspannung': 'Alternator target voltage',
  'Spannung Kl.87': 'Terminal 87 voltage',
  'Spannung Kl.30': 'Terminal 30 voltage (battery)',
  'Status Motorsteuerung': 'Engine management status',
  'Motor Status': 'Engine status',
  'Motortemperatur': 'Engine temperature',
  'Motortemperatur beim Start': 'Engine temp at start',
  '(Motor) - Öltemperatur': 'Engine oil temperature',
  'Öltemperatur': 'Oil temperature',
  'Kühlmitteltemperatur': 'Coolant temperature',
  'Ansauglufttemperatur': 'Intake air temperature',
  'Umgebungstemperatur': 'Ambient temperature',
  'Umgebungsdruck': 'Ambient pressure',
  'Ladedruck': 'Boost pressure',
  'Last': 'Engine load',
  'Fahrgeschwindigkeit': 'Vehicle speed',
  'Batteriespannung': 'Battery voltage',
  'Zündwinkel': 'Ignition angle',
  'Lambdawert': 'Lambda value',
  'Saugrohrdruck': 'Manifold pressure',
  'Differenz zwischen Maximum und Minimum SAF': 'Max-min difference, secondary air mass',
  'Mittlere Diagnosewert minimale Luftmasse': 'Mean diagnostic value, minimum air mass',
  'Sekundärluftmasse': 'Secondary air mass',
  'minimale Luftmasse': 'Minimum air mass',
};
// value-phrase fragments seen in F_UW*_WERT (engine-state enums etc.)
const ENV_VALUE_PHRASES = [
  [/Motor steht/gi, 'engine stopped'],
  [/Motor im Leerlauf/gi, 'engine idling'],
  [/Motor l[äa]uft/gi, 'engine running'],
  [/Sy?nchronisiert und Z[üu]ndung ein/gi, 'synchronized, ignition on'],
  [/Z[üu]ndung ein/gi, 'ignition on'],
  [/Z[üu]ndung aus/gi, 'ignition off'],
  [/^(\d+)\s+[EI]S\s*-\s*/, '$1 '],  // strip the "N ES -" / "N IS -" state-code prefix
];
// German measurement-word tokens, for compound labels not in the exact map
const ENV_TOKENS = [
  [/Motortemperatur/gi, 'engine temp'], [/Öltemperatur/gi, 'oil temp'],
  [/temperatur/gi, 'temperature'], [/Spannung/gi, 'voltage'], [/Drehzahl/gi, 'RPM'],
  [/Luftmasse/gi, 'air mass'], [/Sekundärluft/gi, 'secondary air'], [/Druck/gi, 'pressure'],
  [/Diagnosewert/gi, 'diagnostic value'], [/Differenz zwischen/gi, 'difference between'],
  [/Maximum und Minimum/gi, 'max and min'], [/Mittlere?r?/gi, 'mean'],
  [/minimale?/gi, 'minimum'], [/Status/gi, 'status'], [/Motor\b/gi, 'engine'],
  [/Sollspannung/gi, 'target voltage'], [/Umgebung/gi, 'ambient'],
  [/beim Start/gi, 'at start'], [/Lichtmaschine/gi, 'alternator'],
];
// translate an env label or value phrase, gated on Settings language
function envLabel(text) {
  if (lang() === 'orig' || !text) return text;
  const s = String(text).trim();
  if (ENV_LABELS[s]) return ENV_LABELS[s];
  // value phrases (engine-state enums)
  let out = s;
  for (const [re, en] of ENV_VALUE_PHRASES) out = out.replace(re, en);
  if (out !== s) return out.replace(/\s{2,}/g, ' ').trim();
  // token fallback for unmapped compound labels: translate German word parts
  if (/[A-Za-zÄÖÜäöü]/.test(s)) {
    let t = s;
    for (const [re, en] of ENV_TOKENS) t = t.replace(re, en);
    if (t !== s) return t.replace(/\s{2,}/g, ' ').trim();
  }
  return text;
}

// BMW hex DTC and location text carry BMW's own fault number (e.g. 27DA, 2761).
// map the common ones to OBD-II P-codes; only show a P-code with a real mapping
// (no fabricated codes).
const PCODE_MAP = {
  '2761': 'P0410',  // secondary air system
  '27C3': 'P2563',  // oil level sensor (thermal)
  '27DA': 'P1734',  // BSD bus / alternator comms (BMW-specific)
  '27C2': 'P2562',
  '27C4': 'P2564',
};
// BMW fault number = first token of F_ORT_TEXT ("27DA BSD-Generator" -> 27DA)
function bmwCode(loc, hex) {
  if (loc) { const m = loc.match(/^([0-9A-F]{3,5})\b/i); if (m) return m[1].toUpperCase(); }
  if (hex) return hex.replace(/-/g, '').slice(0, 4).toUpperCase();
  return null;
}
function pCode(loc, hex) {
  const code = bmwCode(loc, hex);
  return code && PCODE_MAP[code] ? PCODE_MAP[code] : null;
}

// fault name: look up the BMW code in the fault DB for the English component name
// (27DA -> "Alternator BSD fault"). falls back to translating F_ORT_TEXT. Original
// (EDIABAS) mode keeps the raw German. keeps the "27DA " code prefix.
function faultName(loc, hex) {
  if (lang() === 'orig') return loc || '';
  const code = bmwCode(loc, hex);
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  if (code && db[code]) return `${code} ${db[code]}`;
  // not in DB: translate the German location text token-wise
  return deGerman(loc) || loc || '';
}

const inpaMode = () => Settings.get('inpaScreens', 'off') === 'on';

// INPA "Comment" (F7): attach a free-text note to the current fault read.
// stored locally with the read so it shows in the export/print.
async function addFaultComment(ecu, container) {
  const note = await inputDialog({
    title: 'Add comment', kind: 'text',
    body: 'Attach a note to this fault read (e.g. "replaced O2 sensor").',
    example: 'replaced O2 sensor 2026-06', confirmLabel: 'Save',
  });
  if (note == null) return;
  faultComment = note;
  const tag = container.querySelector('.fault-comment');
  if (tag) tag.textContent = `Note: ${note}`;
  else {
    const d = document.createElement('div');
    d.className = 'fault-comment'; d.textContent = `Note: ${note}`;
    container.prepend(d);
  }
  sbLeft.textContent = 'comment saved';
}
let faultComment = '';

// INPA "Printing" (F9): export faults as CSV, one fault per row, fields in their
// own columns. includes detailed fields + environment values when present.
function exportFaults(ecu, view) {
  const faults = lastFaultRead || [];
  if (!faults.length) { sbLeft.textContent = 'read codes first'; return; }
  if (!(window.bmacw && window.bmacw.startLog)) { sbLeft.textContent = 'export unavailable'; return; }

  // Build the column set. Environment columns only appear if a detailed read
  // captured them (so the header matches the data).
  const hasEnv = faults.some(c => c.F_UW1_TEXT);
  const header = [
    'index', 'fault_nr', 'location', 'f_code', 'bmw_code', 'p_code', 'p_code_text',
    'type_of_error', 'error_status', 'readiness', 'warning_lamp', 'frequency', 'entry_km',
  ];
  if (hasEnv) for (let i = 1; i <= 4; i++) header.push(`env${i}_name`, `env${i}_value`, `env${i}_unit`);

  const name = `bmacw-faults-${ecu.sgbd}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  window.bmacw.startLog(name, header).then(res => {
    if (!res || !res.ok) { sbLeft.textContent = 'export cancelled'; return; }
    faults.forEach((c, i) => {
      const hex = c.F_HEX_CODE || '';
      const row = [
        i + 1,
        c.F_ORT_NR || '',
        c.F_ORT_TEXT || '',
        hex,
        bmwCode(c.F_ORT_TEXT, hex) || '',
        c.F_PCODE_STRING || pCode(c.F_ORT_TEXT, hex) || '',
        deGerman(c.F_PCODE_TEXT || ''),
        `${c.F_SYMPTOM_NR ? `(${c.F_SYMPTOM_NR}) ` : ''}${deGerman(c.F_SYMPTOM_TEXT) || ''}`,
        `${c.F_VORHANDEN_NR ? `(${c.F_VORHANDEN_NR}) ` : ''}${deGerman(c.F_VORHANDEN_TEXT) || ''}`,
        `${c.F_READY_NR ? `(${c.F_READY_NR}) ` : ''}${deGerman(c.F_READY_TEXT) || ''}`,
        `${c.F_WARNUNG_NR ? `(${c.F_WARNUNG_NR}) ` : ''}${deGerman(c.F_WARNUNG_TEXT) || ''}`,
        c.F_HFK || c.F_LZ || '',
        c.F_UW_KM || '',
      ];
      if (hasEnv) for (let j = 1; j <= 4; j++) {
        row.push(envLabel(c[`F_UW${j}_TEXT`] || ''), envLabel(String(c[`F_UW${j}_WERT`] ?? '')), c[`F_UW${j}_EINH`] || '');
      }
      window.bmacw.appendLog(res.id, row);
    });
    window.bmacw.stopLog(res.id);
    sbLeft.textContent = `saved → ${res.path.split('/').pop()}`;
  });
}

// environment snapshot captured by the DME when the fault was logged: RPM,
// voltages (alternator setpoint, KL87), engine state, mileage. only present
// after a detailed read (F_UW* fields). German to English.
function envBlock(c) {
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    const t = c[`F_UW${i}_TEXT`];
    if (t == null) continue;
    const val = c[`F_UW${i}_WERT`];
    const unit = c[`F_UW${i}_EINH`];
    if (val == null) continue;
    // round long decimals (13.1015625 -> 13.10)
    let shown = val;
    const n = parseFloat(val);
    if (isFinite(n) && !Number.isInteger(n) && /^-?\d/.test(val)) shown = n.toFixed(2);
    const u = unit && unit !== '0-n' ? ` ${unit}` : '';
    rows.push(`<div class="inpa-uw"><span class="inpa-uw-k">${envLabel(t)}</span><span class="inpa-uw-v">${envLabel(String(shown))}${u}</span></div>`);
  }
  if (!rows.length) return '';
  return `<div class="inpa-env"><div class="inpa-env-head">environment: values at code entry</div>${rows.join('')}</div>`;
}

// INPA fault view: mirrors the "MS45 error memory with environment" screen.
// numbered block per fault (type of error, readiness flag, error status,
// F-Code), with the BMW fault title and MIL state.
function renderFaultsInpa(codes, container, ecu) {
  const faults = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  container.className = 'inpa-faults';
  if (faults.length === 0) {
    container.innerHTML = `<div class="inpa-fault-title">${ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU'} error memory</div>
      <div class="inpa-noerr">No faults stored. Fault memory is clean.</div>`;
    return;
  }
  const total = faults.length;
  const blocks = faults.map((c, i) => {
    const hex = c.F_HEX_CODE || '';
    const code = bmwCode(c.F_ORT_TEXT, hex);
    // prefer the real P-code from the detailed read (F_PCODE_STRING), else our map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || pCode(c.F_ORT_TEXT, hex) || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const sym = deGerman(c.F_SYMPTOM_TEXT);
    const ready = deGerman(c.F_READY_TEXT);
    const status = deGerman(c.F_VORHANDEN_TEXT);
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;           // frequency (how many times seen)
    const km = c.F_UW_KM;                       // mileage at first/last entry
    const present = (c.F_VORHANDEN_TEXT || '').toLowerCase().includes('momentan vorhanden')
      && !(c.F_VORHANDEN_TEXT || '').toLowerCase().includes('nicht vorhanden');
    return `
      <div class="inpa-fault">
        <div class="inpa-fault-head">
          <span class="inpa-fault-idx">Error: ${i + 1}(${total})</span>
          <span class="inpa-fault-nr">Nr: ${c.F_ORT_NR || '-'}</span>
          <span class="inpa-fault-name">${faultName(c.F_ORT_TEXT, c.F_HEX_CODE) || 'Unknown'}</span>
          ${present ? '<span class="inpa-fault-present">PRESENT</span>' : ''}
          ${freq ? `<span class="inpa-fault-freq">frequency: ${freq}</span>` : ''}
        </div>
        <div class="inpa-fault-fields">
          <div class="inpa-ff"><span class="inpa-ff-k">type of error:</span><span class="inpa-ff-v">${c.F_SYMPTOM_NR ? `(${c.F_SYMPTOM_NR}) ` : ''}${sym || '-'}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">readiness flag:</span><span class="inpa-ff-v">${c.F_READY_NR ? `(${c.F_READY_NR}) ` : ''}${ready || '-'}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">error status:</span><span class="inpa-ff-v">${c.F_VORHANDEN_NR ? `(${c.F_VORHANDEN_NR}) ` : ''}${status || '-'}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">warning lamp:</span><span class="inpa-ff-v">${c.F_WARNUNG_NR ? `(${c.F_WARNUNG_NR}) ` : ''}${warn || '-'}</span></div>
          ${pstr ? `<div class="inpa-ff"><span class="inpa-ff-k">P-Code:</span><span class="inpa-ff-v mono">${pstr}${ptext ? ` - ${ptext}` : ''}</span></div>` : ''}
          <div class="inpa-ff"><span class="inpa-ff-k">F-Code:</span><span class="inpa-ff-v mono">${hex || '-'}${code ? `  ·  ${code}` : ''}</span></div>
          ${km ? `<div class="inpa-ff"><span class="inpa-ff-k">entry at km:</span><span class="inpa-ff-v">${km}</span></div>` : ''}
        </div>
        ${envBlock(c)}
      </div>`;
  }).join('');
  container.innerHTML = `<div class="inpa-fault-title">${ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU'} error memory with environment</div>${blocks}`;
}

// INPA "Detail" (F2): normal read to get every fault number, then FS_LESEN_DETAIL
// per number, merging rich detail (P-code, frequency, mileage, environment) onto
// each. FS_LESEN_DETAIL needs the fault number as arg; with none it returns
// nothing (hence "0 codes").
async function readFaultsDetailed(ecu, container) {
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading fault memory…</span></div>`;
  try {
    // 1) normal read -> fault numbers
    const base = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN`, { method: 'POST' });
    const faults = (base.sets || []).slice(1).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
    if (!faults.length) { renderFaults([], container, ecu); sbLeft.textContent = '0 faults'; return; }
    // 2) per-fault detail, merged onto the base entry
    container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading detail for ${faults.length} fault(s)…</span></div>`;
    for (const f of faults) {
      const nr = f.F_ORT_NR;
      if (nr == null) continue;
      try {
        const det = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN_DETAIL?arg=${encodeURIComponent(nr)}`, { method: 'POST' });
        const dset = matchDetail(det.sets, nr);
        if (dset) {
          // detail read's F_HEX_CODE / F_ORT_TEXT are bloated freeze-frame dumps.
          // keep the short base FS_LESEN versions for display, pull only the rich
          // detail fields (P-code, frequency, environment).
          const { F_HEX_CODE, F_ORT_TEXT, ...rich } = dset;
          Object.assign(f, rich);
        }
      } catch { /* keep the base entry if detail fails for one */ }
    }
    renderFaults(faults, container, ecu);
    sbLeft.textContent = `${faults.length} fault(s) · detailed`;
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

let lastFaultRead = []; // most recent fault list (for Comment/Print/export)
function renderFaults(codes, container, ecu) {
  lastFaultRead = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  if (inpaMode()) return renderFaultsInpa(codes, container, ecu);
  container.className = 'faults';
  // only real fault entries have a hex code (filters telegram/summary sets)
  const faults = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  if (faults.length === 0) {
    container.innerHTML = `<div class="empty">
      <div class="empty-big">No stored faults</div>
      <div>The module reported a clean fault memory.</div></div>`;
    return;
  }
  container.innerHTML = '';
  container.className = 'faults stagger';
  faults.forEach(c => {
    const present = (c.F_VORHANDEN_TEXT || '').toLowerCase().includes('momentan vorhanden')
      && !(c.F_VORHANDEN_TEXT || '').toLowerCase().includes('nicht vorhanden');
    const hex = c.F_HEX_CODE || '';
    // prefer the detailed P-code (from FS_LESEN_DETAIL) over our static map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || pCode(c.F_ORT_TEXT, hex) || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;
    const km = c.F_UW_KM;
    // detail present? (a detailed read merged the rich fields)
    const detailed = !!(c.F_PCODE_STRING || c.F_UW1_TEXT || c.F_HFK);
    const el = document.createElement('div');
    el.className = 'fault';
    el.innerHTML = `
      <div class="fault-code">
        <div class="fault-hex">${hex || c.F_ORT_NR || '-'}</div>
        ${pstr ? `<div class="fault-pcode">${pstr}</div>` : ''}
      </div>
      <div class="fault-main">
        <div class="fault-loc">${faultName(c.F_ORT_TEXT, c.F_HEX_CODE) || 'Unknown location'}</div>
        <div class="fault-symptom">${deGerman(c.F_SYMPTOM_TEXT) || ''}</div>
        ${detailed ? `
          <div class="fault-detail">
            ${ptext ? `<div class="fd-row"><span class="fd-k">Meaning</span><span class="fd-v">${ptext}</span></div>` : ''}
            <div class="fd-row"><span class="fd-k">Status</span><span class="fd-v">${deGerman(c.F_VORHANDEN_TEXT) || '-'}</span></div>
            ${freq ? `<div class="fd-row"><span class="fd-k">Frequency</span><span class="fd-v">${freq}</span></div>` : ''}
            ${km ? `<div class="fd-row"><span class="fd-k">At mileage</span><span class="fd-v">${km} km</span></div>` : ''}
            ${faultEnvInline(c)}
          </div>` : ''}
      </div>
      <div class="fault-flags">
        ${present ? '<span class="flag present">present</span>' : '<span class="flag">stored</span>'}
        ${warn ? `<span class="flag">${warn}</span>` : ''}
      </div>`;
    container.appendChild(el);
  });
  stagger(container, 40);
}

// inline environment values for the modern fault card (RPM / voltages / state at
// code entry), shown only when a detailed read captured them
function faultEnvInline(c) {
  const items = [];
  for (let i = 1; i <= 4; i++) {
    const t = c[`F_UW${i}_TEXT`]; if (t == null) continue;
    const v = c[`F_UW${i}_WERT`]; if (v == null) continue;
    const u = c[`F_UW${i}_EINH`]; const unit = u && u !== '0-n' ? ` ${u}` : '';
    let shown = v; const n = parseFloat(v);
    if (isFinite(n) && !Number.isInteger(n) && /^-?\d/.test(String(v))) shown = n.toFixed(2);
    items.push(`<span class="fd-env"><span class="fd-env-k">${envLabel(t)}:</span> ${envLabel(String(shown))}${unit}</span>`);
  }
  return items.length ? `<div class="fd-env-row">${items.join('')}</div>` : '';
}

// ---------- settings screen ----------
let lastScreen = showChassis; // where to return to when leaving settings

function showSettings() {
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Settings' }]);
  sbLeft.textContent = 'settings';
  view.innerHTML = head('Preferences', 'Settings', 'Configure how BMacW displays diagnostics.');

  const wrap = document.createElement('div');
  wrap.className = 'settings-list stagger';

  // skin picker: swatch grid
  const themeRow = document.createElement('div');
  themeRow.className = 'setting-row theme-row';
  themeRow.innerHTML = `
    <div class="setting-text" style="margin-bottom:14px">
      <div class="setting-title">Skin</div>
      <div class="setting-desc">Pick a look. Applies instantly and persists.</div>
    </div>`;
  const themeGrid = document.createElement('div');
  themeGrid.className = 'theme-grid';
  const cur = Settings.get('theme', 'instrument');
  THEMES.forEach(t => {
    const card = document.createElement('button');
    card.className = 'theme-card' + (t.id === cur ? ' active' : '');
    card.dataset.theme = t.id;
    card.innerHTML = `
      <span class="theme-swatch sw-${t.id}"></span>
      <span class="theme-meta"><span class="theme-name">${t.name}</span></span>`;
    card.onclick = () => {
      Settings.set('theme', t.id);
      applyTheme(t.id);
      themeGrid.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c === card));
    };
    themeGrid.appendChild(card);
  });
  themeRow.appendChild(themeGrid);
  wrap.appendChild(themeRow);


  // language / labels toggle
  wrap.appendChild(settingRow(
    'Function labels',
    'Show translated English names, or the original EDIABAS job names.',
    [
      { val: 'en', label: 'English' },
      { val: 'orig', label: 'Original (EDIABAS)' },
    ],
    lang(),
    (v) => Settings.set('lang', v),
  ));

  // INPA-style screens toggle: render ECU menu and fault list like the original
  // INPA frontend (Hauptmenue F-key list + labeled error-memory view).
  wrap.appendChild(settingRow(
    'INPA-style screens',
    'Lay out the ECU menu and fault memory exactly like the original INPA frontend.',
    [
      { val: 'on', label: 'INPA layout' },
      { val: 'off', label: 'Modern' },
    ],
    Settings.get('inpaScreens', 'off'),
    (v) => Settings.set('inpaScreens', v),
  ));

  // interface selector (cable vs OBDLink MX+)
  const ifaceRow = settingRow(
    'Diagnostic interface',
    'K+DCAN cable (wired, best for E46 K-line) or OBDLink MX+ (ELM/STN over Wi-Fi). MX+ K-line coverage on the E46 may be partial.',
    [
      { val: 'cable', label: 'K+DCAN cable' },
      { val: 'elm', label: 'OBDLink MX+' },
    ],
    'cable',
    async (v) => {
      await api('/api/interface', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: v }) }).catch(() => {});
      elmHostRow.style.display = v === 'elm' ? '' : 'none';
      if (v === 'elm') refreshElmStatus();
      refreshStatus();
    },
  );
  wrap.appendChild(ifaceRow);

  // MX+ status (ELM mode only): auto-detected Bluetooth serial port
  const elmHostRow = document.createElement('div');
  elmHostRow.className = 'setting-row';
  elmHostRow.style.display = 'none';
  elmHostRow.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">OBDLink MX+ (Bluetooth)</div>
      <div class="setting-desc" id="elm-status">Pair the MX+ in System Settings → Bluetooth. It appears as a serial port automatically.</div>
    </div>`;
  wrap.appendChild(elmHostRow);

  function refreshElmStatus() {
    api('/api/port').then(p => {
      const el = elmHostRow.querySelector('#elm-status');
      if (el) el.textContent = p.port
        ? `Detected: ${p.port}`
        : 'No OBDLink MX+ found. Pair it in System Settings → Bluetooth first.';
    }).catch(() => {});
  }

  // load current interface state
  api('/api/interface').then(cfg => {
    ifaceRow.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.textContent === (cfg.mode === 'elm' ? 'OBDLink MX+' : 'K+DCAN cable')));
    elmHostRow.style.display = cfg.mode === 'elm' ? '' : 'none';
    if (cfg.mode === 'elm') refreshElmStatus();
  }).catch(() => {});

  view.appendChild(wrap);
  stagger(wrap, 40);

  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => lastScreen() }]);
}

function settingRow(title, desc, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">${title}</div>
      <div class="setting-desc">${desc}</div>
    </div>
    <div class="seg" role="group"></div>`;
  const seg = row.querySelector('.seg');
  options.forEach(opt => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (opt.val === current ? ' active' : '');
    b.textContent = opt.label;
    b.onclick = () => {
      seg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      onChange(opt.val);
    };
    seg.appendChild(b);
  });
  return row;
}

// ---------- connection status ----------
// LED reflects cable connectivity (K+DCAN serial port present), not the .NET
// engine. green = cable detected; amber = engine up but no cable; red = engine
// unreachable.
let engineUp = false;
async function pollEngine() {
  try { await api('/api/health'); engineUp = true; }
  catch { engineUp = false; }
}
async function pollCable() {
  if (!engineUp) {
    led.className = 'led off'; linkText.textContent = 'engine offline';
    return null;
  }
  try {
    const { port } = await api('/api/port');
    if (port) {
      led.className = 'led ok';
      linkText.textContent = 'cable: ' + port.replace('/dev/', '');
    } else {
      led.className = 'led idle';
      linkText.textContent = 'no cable';
    }
    return port;
  } catch {
    led.className = 'led idle'; linkText.textContent = 'no cable';
    return null;
  }
}
// Battery (KL30) + Ignition (KL15) indicators, INPA-style. only meaningful with a
// car on the cable; shows "off/-" otherwise. cheap, best-effort.
const batLed = document.getElementById('bat-led');
const batVal = document.getElementById('bat-val');
const ignLed = document.getElementById('ign-led');
const ignVal = document.getElementById('ign-val');
async function pollState(port) {
  if (!engineUp || !port) {
    batLed.className = 'kl-led off'; batVal.textContent = '-';
    ignLed.className = 'kl-led off'; ignVal.textContent = '-';
    return;
  }
  try {
    const s = await api('/api/state');
    if (s.battery != null) { batLed.className = 'kl-led on'; batVal.textContent = s.battery.toFixed(1) + ' V'; }
    else { batLed.className = 'kl-led off'; batVal.textContent = 'off'; }
    if (s.ignition === true) { ignLed.className = 'kl-led on'; ignVal.textContent = 'on'; }
    else if (s.ignition === false) { ignLed.className = 'kl-led off'; ignVal.textContent = 'off'; }
    else { ignLed.className = 'kl-led off'; ignVal.textContent = '-'; }
  } catch {
    batLed.className = 'kl-led off'; batVal.textContent = '-';
    ignLed.className = 'kl-led off'; ignVal.textContent = '-';
  }
}
// battery/ignition is a real DME transaction: poll slowly (~12s) and only with a
// cable present. hammering it collides with other reads and can wake/sleep the
// bus. cable/engine status stays on the fast timer (free local checks).
let lastStatePoll = 0;
async function refreshStatus() {
  await pollEngine();
  const port = await pollCable();
  const now = Date.now();
  if (port && now - lastStatePoll > 12000) {
    lastStatePoll = now;
    await pollState(port);
    if (typeof syncVselState === 'function') syncVselState();
  } else if (!port) {
    await pollState(null); // clear the indicators when unplugged
    if (typeof syncVselState === 'function') syncVselState();
  }
}

(async function boot() {
  // wait for the sidecar, then show the start screen
  for (let i = 0; i < 40; i++) {
    await pollEngine();
    if (engineUp) break;
    await new Promise(r => setTimeout(r, 400));
  }
  await pollCable();
  setInterval(refreshStatus, 3000);
  document.getElementById('settings-btn').onclick = showSettings;
  document.getElementById('flash-btn').onclick = showFlashing;
  // custom window controls (frameless window for Aero)
  if (window.bmacw) {
    document.getElementById('win-close').onclick = () => window.bmacw.winClose();
    document.getElementById('win-min').onclick = () => window.bmacw.winMinimize();
    document.getElementById('win-zoom').onclick = () => window.bmacw.winZoom();
  }
  showChassis().catch(e => {
    view.innerHTML = `<div class="empty"><div class="empty-big" style="color:var(--red)">Engine unreachable</div><div>${e.message}</div></div>`;
  });
})();
