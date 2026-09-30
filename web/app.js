/* Sapphire Stock - client. Data lives in Supabase; every write is an RPC that
   checks permissions and records the change for the admin. */
(() => {
'use strict';

const sb = supabase.createClient(SAPPHIRE_CONFIG.url, SAPPHIRE_CONFIG.key, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sapphire-auth' }
});
const EMAIL_DOMAIN = '@users.sapphire-stock.app';
const PERMS = {
  count: 'Count stock',
  receive: 'Record deliveries & removals',
  add_products: 'Add new products',
  see_expected: 'See expected quantities while counting',
  see_prices: 'See buying prices, sales & profit',
  reports: 'View reports',
  close: 'Save report & start new stock take'
};
const DEFAULT_WORKER = ['count', 'receive', 'add_products'];

const S = {
  me: null, products: [], costs: new Map(), period: null, lines: new Map(), moves: [],
  changes: [], users: [], tab: null, cat: '', todo: false, prodCat: '', report: null, lastChangeId: 0
};

// ------------------------------------------------------------ helpers
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const q = v => v === null || v === undefined ? '' : String(Math.round(Number(v) * 100) / 100);
const money = v => v === null || v === undefined || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US');
const isAdmin = () => S.me?.role === 'admin';
const can = p => p === 'admin' ? isAdmin() : (isAdmin() || (S.me?.perms || []).includes(p));
const when = ts => { const d = new Date(ts); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
const friendly = e => {
  const m = e?.message || String(e);
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'No internet connection — not saved. Try again.';
  if (/JWT|not authenticated/i.test(m)) return 'Your sign-in expired. Please sign in again.';
  return m;
};

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.className = 'toast', 3000);
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

async function fetchAll(build) {  // pages past Supabase's 1000-row limit
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

function show(view) {
  for (const v of ['bootView', 'loginView', 'appView']) $('#' + v).classList.toggle('hide', v !== view);
}

// ------------------------------------------------------------ auth
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = $('#loginBtn');
  $('#loginErr').textContent = ''; btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: f.username.value.trim().toLowerCase() + EMAIL_DOMAIN, password: f.password.value
  });
  btn.disabled = false;
  if (error) {
    $('#loginErr').textContent = /invalid/i.test(error.message) ? 'Wrong username or password' : friendly(error);
    return;
  }
  f.password.value = '';
  await start();
});

$('#logoutBtn').addEventListener('click', async () => {
  await sb.removeAllChannels();
  await sb.auth.signOut();
  S.me = null; show('loginView');
});

async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('loginView');
  const { data: me, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) { show('loginView'); $('#loginErr').textContent = friendly(error); return; }
  if (!me || !me.active) {
    await sb.auth.signOut();
    show('loginView'); $('#loginErr').textContent = 'This account is disabled. Ask the admin.';
    return;
  }
  S.me = me;
  $('#whoName').textContent = (me.full_name || me.username) + (isAdmin() ? ' · admin' : '');
  applyPerms();
  show('appView');
  await reload();
  if (!S.tab) openTab(can('count') ? 'count' : 'deliveries');
  subscribe();
  if (me.must_change) openPw(true);
}

function applyPerms() {
  $$('[data-need]').forEach(el => el.classList.toggle('hide', !can(el.dataset.need)));
  $$('.admin-only').forEach(el => el.classList.toggle('hide', !isAdmin()));
}

// ------------------------------------------------------------ data
async function reload() {
  try {
    const [prods, costs, per] = await Promise.all([
      fetchAll(() => sb.from('products').select('*').order('name')),
      can('see_prices') ? fetchAll(() => sb.from('product_costs').select('*')) : [],
      sb.from('periods').select('*').eq('status', 'open').maybeSingle()
    ]);
    if (per.error) throw per.error;
    S.products = prods;
    S.costs = new Map(costs.map(c => [c.product_id, num(c.buy)]));
    S.period = per.data;
    if (S.period) {
      const [lines, moves] = await Promise.all([
        fetchAll(() => sb.from('lines').select('*').eq('period_id', S.period.id)),
        fetchAll(() => sb.from('movements').select('*').eq('period_id', S.period.id).order('created_at', { ascending: false }))
      ]);
      S.lines = new Map(lines.map(l => [l.product_id, l]));
      S.moves = moves;
    } else { S.lines = new Map(); S.moves = []; }
    if (isAdmin()) {
      const [ch, us] = await Promise.all([
        sb.from('changes').select('*').order('id', { ascending: false }).limit(500),
        sb.from('profiles').select('*').order('username')
      ]);
      if (ch.error) throw ch.error;
      const fresh = ch.data.filter(c => c.id > S.lastChangeId && !c.seen && c.user_id !== S.me.id);
      if (S.lastChangeId && fresh.length) {
        const c = fresh[0];
        toast(`${c.username}: ${c.action}${c.product_name ? ' — ' + c.product_name : ''}`);
      }
      S.lastChangeId = ch.data[0]?.id || S.lastChangeId || 1;
      S.changes = ch.data;
      S.users = us.data || [];
    }
    setSync(true);
    render();
  } catch (e) {
    setSync(false);
    toast(friendly(e), true);
  }
}

let reloadTimer;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 350); }

function subscribe() {
  sb.removeAllChannels();
  sb.channel('sapphire')
    .on('postgres_changes', { event: '*', schema: 'public' }, scheduleReload)
    .subscribe(status => {
      if (status === 'SUBSCRIBED') setSync(true);
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setSync(false);
    });
}
window.addEventListener('online', () => { setSync(true); reload(); });
window.addEventListener('offline', () => setSync(false));
window.addEventListener('focus', () => { if (S.me) scheduleReload(); });

function setSync(ok) {
  $('#sync').className = 'sync ' + (ok ? 'ok' : 'bad');
  $('#syncTxt').textContent = ok ? 'Live' : 'Offline';
}

// One row of the open stock take for a product.
function calc(p) {
  const l = S.lines.get(p.id) || { opening: 0, closing: null };
  let inQ = 0, outQ = 0;
  for (const m of S.moves) if (m.product_id === p.id) m.type === 'in' ? inQ += +m.qty : outQ += +m.qty;
  const opening = +l.opening || 0, closing = num(l.closing);
  const expected = opening + inQ - outQ;
  const counted = closing !== null;
  const sold = counted ? expected - closing : null;
  const sell = num(p.sell), buy = S.costs.get(p.id) ?? null;
  const current = counted ? closing : expected;
  return {
    p, l, opening, inQ, outQ, expected, closing, counted, sold, current, sell, buy,
    sales: counted && sell !== null ? sold * sell : null,
    profit: counted && sell !== null && buy !== null ? sold * (sell - buy) : null,
    costValue: buy !== null ? current * buy : null,
    sellValue: sell !== null ? current * sell : null
  };
}

const activeRows = () => S.products.filter(p => p.active).map(calc);
function sum(rows, k) { return rows.reduce((a, r) => a + (r[k] || 0), 0); }

// ------------------------------------------------------------ rendering
function render() {
  renderStrip();
  renderBadge();
  if (S.tab === 'count') renderCount();
  if (S.tab === 'deliveries') renderMoves();
  if (S.tab === 'products') renderProducts();
  if (S.tab === 'changes') renderChanges();
  if (S.tab === 'users') renderUsers();
  if (S.tab === 'reports' && S.report) renderReports();
}

function renderStrip() {
  const rows = activeRows();
  const counted = rows.filter(r => r.counted).length;
  const units = sum(rows, 'sold');
  const per = S.period ? esc(S.period.name) : 'No open stock take';
  let h;
  if (can('see_prices')) {
    const rev = sum(rows, 'sales'), prof = sum(rows, 'profit');
    h = `<div class="stat hero"><div class="l">Sales this period</div><div class="big">${money(rev)}</div><div class="s">${q(units)} units sold · ${counted}/${rows.length} counted</div></div>
      <div class="stat"><div class="l">Gross profit</div><div class="big">${money(prof)}</div><div class="s">${rev ? Math.round(prof / rev * 100) : 0}% margin</div></div>
      <div class="stat"><div class="l">Stock at cost</div><div class="big">${money(sum(rows, 'costValue'))}</div><div class="s">${rows.length} products</div></div>
      <div class="stat"><div class="l">Stock at selling price</div><div class="big">${money(sum(rows, 'sellValue'))}</div><div class="s">${per}</div></div>`;
  } else {
    h = `<div class="stat hero"><div class="l">${per}</div><div class="big">${counted} / ${rows.length}</div><div class="s">products counted</div>
      <div class="meter"><i style="width:${rows.length ? counted / rows.length * 100 : 0}%"></i></div></div>
      <div class="stat"><div class="l">Deliveries this period</div><div class="big">${S.moves.filter(m => m.type === 'in').length}</div><div class="s">${S.moves.filter(m => m.type === 'out').length} removals</div></div>`;
  }
  $('#strip').innerHTML = h;
}

function renderBadge() {
  const n = S.changes.filter(c => !c.seen).length;
  const b = $('#unseenBadge');
  b.textContent = n; b.classList.toggle('hide', !n);
}

function chips(el, cats, current, onPick) {
  el.innerHTML = ['', ...cats].map(c => `<button type="button" class="chip${c === current ? ' on' : ''}" data-cat="${esc(c)}">${esc(c || 'All')}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('.chip'); if (b) onPick(b.dataset.cat); };
}
const categories = () => [...new Set(S.products.filter(p => p.active).map(p => p.category || 'Other'))].sort((a, b) => a.localeCompare(b));

// ---- stock count
function renderCount() {
  const exp = can('see_expected'), pr = can('see_prices');
  $('#countNote').textContent = exp
    ? 'Sold = opening + received − removed − counted. Received fills in from Deliveries. Leave a count blank if you haven\'t counted that item yet.'
    : 'Count what is on the shelf and type the number. Leave it blank if you haven\'t counted that item yet. It saves by itself.';
  const cats = categories();
  const todoChip = `<button type="button" class="chip todo${S.todo ? ' on' : ''}" data-todo="1">Not counted</button>`;
  chips($('#chipsCount'), cats, S.cat, c => { S.cat = c; renderCount(); });
  $('#chipsCount').insertAdjacentHTML('beforeend', todoChip);
  $('#chipsCount').querySelector('.todo').onclick = () => { S.todo = !S.todo; renderCount(); };

  const focused = document.activeElement?.closest?.('.crow');
  const keep = focused ? { pid: focused.dataset.pid, val: document.activeElement.value } : null;

  const s = $('#qCount').value.trim().toLowerCase();
  const rows = activeRows().filter(r => (!S.cat || (r.p.category || 'Other') === S.cat)
    && (!s || r.p.name.toLowerCase().includes(s)) && (!S.todo || !r.counted || String(r.p.id) === keep?.pid));
  const nCols = 2 + (exp ? 3 : 0) + (pr ? 2 : 0);
  const before = 2 + (exp ? 2 : 0);  // number columns before the count box
  const after = nCols - before;   // CSS repeat() cannot take 0
  $('#countRows').style.setProperty('--cols', `minmax(170px, 2.4fr) repeat(${before}, minmax(60px, 1fr)) 170px`
    + (after ? ` repeat(${after}, minmax(60px, 1fr))` : ''));
  const head = `<div class="crow head"><div class="c-name">Product</div>
    ${exp ? '<div class="c-n">Opening</div>' : ''}<div class="c-n">Received</div><div class="c-n">Removed</div>
    ${exp ? '<div class="c-n">Expected</div>' : ''}<div class="c-in">Counted now</div>
    ${exp ? '<div class="c-n">Sold</div>' : ''}${pr ? '<div class="c-n">Sales</div><div class="c-n">Profit</div>' : ''}</div>`;
  $('#countRows').innerHTML = head + (rows.length ? rows.map(r => `
    <div class="crow${r.counted ? ' done' : ''}${r.sold !== null && r.sold < 0 ? ' neg' : ''}" data-pid="${r.p.id}">
      <div class="c-name"><b>${esc(r.p.name)}</b><small>${esc(r.p.category || 'Other')}${r.l.counted_by ? ' · ✓ ' + esc(r.l.counted_by) : ''}</small></div>
      ${exp ? `<div class="c-n" data-l="Opening">${q(r.opening)}</div>` : ''}
      <div class="c-n" data-l="Received">${q(r.inQ) || '0'}</div><div class="c-n" data-l="Removed">${q(r.outQ) || '0'}</div>
      ${exp ? `<div class="c-n" data-l="Expected">${q(r.expected)}</div>` : ''}
      <div class="c-in">${can('count') && S.period ? `<button type="button" class="step" data-d="-1" aria-label="less">−</button>
        <input class="qty" inputmode="decimal" autocomplete="off" value="${q(r.closing)}" data-saved="${q(r.closing)}" placeholder="—" aria-label="Count for ${esc(r.p.name)}">
        <button type="button" class="step" data-d="1" aria-label="more">+</button>` : q(r.closing)}</div>
      ${exp ? `<div class="c-n" data-l="Sold">${r.sold === null ? '' : q(r.sold)}</div>` : ''}
      ${pr ? `<div class="c-n" data-l="Sales">${r.sales === null ? '' : money(r.sales)}</div><div class="c-n" data-l="Profit">${r.profit === null ? '' : money(r.profit)}</div>` : ''}
    </div>`).join('') : '<p class="muted center pad">No products match.</p>');

  if (keep) {
    const inp = $(`.crow[data-pid="${keep.pid}"] .qty`);
    if (inp) { inp.value = keep.val; inp.focus(); }
  }
  renderCloseBar();
}

function renderCloseBar() {
  const rows = activeRows(), pr = can('see_prices');
  const counted = rows.filter(r => r.counted).length;
  $('#closebar').innerHTML = `
    <div><div class="k">Counted</div><div class="v">${counted}/${rows.length}</div></div>
    ${can('see_expected') ? `<div><div class="k">Units sold</div><div class="v">${q(sum(rows, 'sold'))}</div></div>` : ''}
    ${pr ? `<div><div class="k">Sales</div><div class="v">${money(sum(rows, 'sales'))}</div></div>
            <div><div class="k">Profit</div><div class="v">${money(sum(rows, 'profit'))}</div></div>` : ''}
    ${can('close') && S.period ? '<div class="act"><button class="btn warn" type="button" id="closeBtn">Save report &amp; start new period</button></div>' : ''}`;
  const b = $('#closeBtn'); if (b) b.onclick = openClose;
}

$('#qCount').addEventListener('input', renderCount);

async function saveCount(row) {
  const inp = row.querySelector('.qty');
  const raw = inp.value.trim().replace(',', '.');
  if (raw === inp.dataset.saved) return;
  if (raw !== '' && (isNaN(raw) || Number(raw) < 0)) { toast('Enter a number, 0 or more', true); inp.value = inp.dataset.saved; return; }
  row.classList.add('saving');
  try {
    await rpc('set_count', { p_product: +row.dataset.pid, p_qty: raw === '' ? null : Number(raw) });
    inp.dataset.saved = raw;
    const l = S.lines.get(+row.dataset.pid) || { opening: 0 };
    S.lines.set(+row.dataset.pid, { ...l, closing: raw === '' ? null : Number(raw), counted_by: raw === '' ? null : S.me.username });
    row.classList.toggle('done', raw !== '');
    renderStrip(); renderCloseBar();
  } catch (e) { toast(friendly(e), true); row.classList.add('err'); }
  row.classList.remove('saving');
}

$('#countRows').addEventListener('change', e => { const r = e.target.closest('.crow'); if (r && e.target.matches('.qty')) saveCount(r); });
$('#countRows').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('.qty')) return;
  e.preventDefault();
  const r = e.target.closest('.crow');
  saveCount(r);
  const next = r.nextElementSibling?.querySelector('.qty');
  if (next) next.focus();
});
$('#countRows').addEventListener('click', e => {
  const b = e.target.closest('.step'); if (!b) return;
  const r = b.closest('.crow'), inp = r.querySelector('.qty');
  inp.value = Math.max(0, (parseFloat(inp.value) || 0) + Number(b.dataset.d));
  clearTimeout(r._t); r._t = setTimeout(() => saveCount(r), 700);
});

// ---- close period
function openClose() {
  const rows = activeRows(), unc = rows.filter(r => !r.counted).length;
  const f = $('#fClose'), today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  f.closed.value = today;
  f.next.value = 'Stock take from ' + today;
  $('#closeInfo').textContent = `The counts become final and a new stock take starts with opening stock = these counts.`
    + (unc ? ` ${unc} product(s) are not counted — they will be treated as not sold.` : '');
  f.querySelector('.err').textContent = '';
  $('#dlgClose').showModal();
}
$('#fClose').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  try {
    await rpc('close_period', { p_closed_name: f.closed.value, p_new_name: f.next.value });
    $('#dlgClose').close(); toast('Report saved. New stock take started.'); S.report = null; reload();
  } catch (err) { f.querySelector('.err').textContent = friendly(err); }
});

// ---- deliveries
function renderMoves() {
  const byId = new Map(S.products.map(p => [p.id, p]));
  $('#moveBody').innerHTML = S.moves.length ? S.moves.map(m => `<tr>
    <td>${esc(byId.get(m.product_id)?.name || '?')}</td>
    <td><span class="tag ${m.type}">${m.type === 'in' ? 'Received' : 'Removed'}</span></td>
    <td class="n">${q(m.qty)}</td><td class="nowrap">${when(m.created_at)}</td><td>${esc(m.created_by || '')}</td>
    <td class="muted">${esc(m.note || '')}</td>
    <td>${isAdmin() ? `<button class="btn small danger" type="button" data-del="${m.id}">Delete</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted center pad">No deliveries recorded in this stock take yet.</td></tr>';
}
$('#moveBody').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (!confirm('Delete this delivery?')) return;
  try { await rpc('delete_movement', { p_id: +b.dataset.del }); toast('Deleted'); reload(); } catch (err) { toast(friendly(err), true); }
});
$('#addMove').addEventListener('click', () => {
  const f = $('#fMove'); f.reset(); f.qty.value = 1; f.querySelector('.err').textContent = '';
  $('#prodList').innerHTML = S.products.filter(p => p.active).map(p => `<option value="${esc(p.name)}">`).join('');
  $('#dlgMove').showModal(); f.product.focus();
});
$('#fMove').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target, err = f.querySelector('.err');
  const p = S.products.find(x => x.name.toLowerCase() === f.product.value.trim().toLowerCase());
  if (!p) { err.textContent = 'Pick a product from the list'; return; }
  try {
    await rpc('add_movement', { p_product: p.id, p_type: f.type.value, p_qty: Number(f.qty.value), p_note: f.note.value,
      p_cost: f.cost.value === '' ? null : Number(f.cost.value), p_update_cost: f.updCost.checked });
    $('#dlgMove').close(); toast(f.type.value === 'in' ? 'Delivery saved' : 'Removal saved'); reload();
  } catch (x) { err.textContent = friendly(x); }
});

// ---- products
function renderProducts() {
  const pr = can('see_prices'), adm = isAdmin();
  chips($('#chipsProd'), categories(), S.prodCat, c => { S.prodCat = c; renderProducts(); });
  $('#prodHead').innerHTML = `<tr><th>Product</th><th>Category</th><th class="n">Sell</th>${pr ? '<th class="n">Buy</th><th class="n">Margin</th>' : ''}
    <th class="n">In stock</th>${pr ? '<th class="n">Value</th>' : ''}${adm ? '<th class="n">Reorder at</th><th></th>' : ''}</tr>`;
  const s = $('#qProd').value.trim().toLowerCase();
  const list = S.products.filter(p => (adm || p.active) && (!S.prodCat || (p.category || 'Other') === S.prodCat)
    && (!s || p.name.toLowerCase().includes(s)));
  $('#prodBody').innerHTML = list.map(p => {
    const r = calc(p), low = p.reorder_level > 0 && r.current <= p.reorder_level;
    return `<tr class="${p.active ? '' : 'off'}">
      <td>${esc(p.name)}${p.active ? '' : ' <span class="tag">inactive</span>'}</td><td>${esc(p.category || 'Other')}</td>
      <td class="n">${money(r.sell)}</td>${pr ? `<td class="n">${money(r.buy)}</td><td class="n">${r.sell !== null && r.buy !== null ? money(r.sell - r.buy) : '—'}</td>` : ''}
      <td class="n${low ? ' warn' : ''}">${q(r.current)}${low ? ' ⚠' : ''}</td>${pr ? `<td class="n">${money(r.costValue)}</td>` : ''}
      ${adm ? `<td class="n">${q(p.reorder_level) || ''}</td><td><button class="btn small" type="button" data-edit="${p.id}">Edit</button></td>` : ''}</tr>`;
  }).join('') || '<tr><td colspan="9" class="muted center pad">No products match.</td></tr>';
}
$('#qProd').addEventListener('input', renderProducts);

function openProd(p) {
  const f = $('#fProd'); f.reset(); f.querySelector('.err').textContent = '';
  f.dataset.id = p ? p.id : '';
  $('#dlgProdTitle').textContent = p ? 'Edit product' : 'Add product';
  $('#catList').innerHTML = categories().map(c => `<option value="${esc(c)}">`).join('');
  $('#openFld').classList.toggle('hide', !!p);
  $$('#fProd .edit-only').forEach(el => el.classList.toggle('hide', !p));
  f.buy.closest('.fld').classList.toggle('hide', !can('see_prices'));
  if (p) {
    f.name.value = p.name; f.category.value = p.category || ''; f.sell.value = q(p.sell);
    f.buy.value = q(S.costs.get(p.id)); f.reorder.value = q(p.reorder_level); f.active.checked = p.active;
  }
  $('#dlgProd').showModal(); f.name.focus();
}
$('#addProd').addEventListener('click', () => openProd(null));
$('#prodBody').addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) openProd(S.products.find(p => p.id === +b.dataset.edit)); });
$('#fProd').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target, n = v => v === '' ? null : Number(v);
  try {
    if (f.dataset.id) {
      await rpc('update_product', { p_id: +f.dataset.id, p_name: f.name.value, p_category: f.category.value, p_sell: n(f.sell.value),
        p_buy: n(f.buy.value), p_reorder: n(f.reorder.value), p_active: f.active.checked });
    } else {
      await rpc('add_product', { p_name: f.name.value, p_category: f.category.value, p_sell: n(f.sell.value),
        p_buy: n(f.buy.value), p_opening: n(f.opening.value) || 0 });
    }
    $('#dlgProd').close(); toast('Product saved'); reload();
  } catch (x) { f.querySelector('.err').textContent = friendly(x); }
});

// ---- reports
async function loadReports() {
  $('#repBody').innerHTML = '<tr><td class="muted center pad">Loading…</td></tr>';
  try {
    const pr = can('see_prices');
    const [periods, lines, moves, lcosts] = await Promise.all([
      fetchAll(() => sb.from('periods').select('*').order('id', { ascending: false })),
      fetchAll(() => sb.from('lines').select('*').order('period_id').order('product_id')),
      fetchAll(() => sb.from('movements').select('period_id,product_id,type,qty').order('id')),
      pr ? fetchAll(() => sb.from('line_costs').select('*').order('period_id').order('product_id')) : []
    ]);
    S.report = { periods, lines, moves, lcosts, open: null };
    renderReports();
  } catch (e) { toast(friendly(e), true); }
}

function periodRows(perId) {
  const R = S.report, per = R.periods.find(p => p.id === perId), closed = per.status === 'closed';
  const net = new Map();
  for (const m of R.moves) if (m.period_id === perId) {
    const o = net.get(m.product_id) || { in: 0, out: 0 };
    o[m.type] += +m.qty; net.set(m.product_id, o);
  }
  const lc = new Map(R.lcosts.filter(c => c.period_id === perId).map(c => [c.product_id, num(c.buy)]));
  const byId = new Map(S.products.map(p => [p.id, p]));
  return R.lines.filter(l => l.period_id === perId).map(l => {
    const p = byId.get(l.product_id) || { name: '?', category: '' };
    const mv = net.get(l.product_id) || { in: 0, out: 0 };
    const closing = num(l.closing), opening = +l.opening || 0;
    const sold = closing === null ? null : opening + mv.in - mv.out - closing;
    const sell = closed ? num(l.sell) : num(p.sell);
    const buy = closed ? (lc.get(l.product_id) ?? null) : (S.costs.get(l.product_id) ?? null);
    return { name: p.name, category: p.category || 'Other', opening, in: mv.in, out: mv.out, closing, sold, sell, buy,
      sales: sold !== null && sell !== null ? sold * sell : null,
      profit: sold !== null && sell !== null && buy !== null ? sold * (sell - buy) : null,
      value: buy !== null ? (closing ?? opening + mv.in - mv.out) * buy : null, counted_by: l.counted_by };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderReports() {
  const R = S.report, pr = can('see_prices');
  const range = $('#repRange').value, now = new Date();
  const from = range === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1)
    : range === '3m' ? new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()) : null;
  const pers = R.periods.filter(p => !from || new Date(p.closed_at || p.created_at) >= from);
  $('#repHead').innerHTML = `<tr><th>Stock take</th><th>Date</th><th class="n">Units sold</th>${pr ? '<th class="n">Sales</th><th class="n">Profit</th><th class="n">Stock value</th>' : ''}<th></th></tr>`;
  let tu = 0, ts = 0, tp = 0;
  $('#repBody').innerHTML = pers.map(p => {
    const rows = periodRows(p.id), u = sum(rows, 'sold'), s = sum(rows, 'sales'), pf = sum(rows, 'profit');
    tu += u; ts += s; tp += pf;
    return `<tr class="${R.open === p.id ? 'sel' : ''}"><td><b>${esc(p.name)}</b> ${p.status === 'open' ? '<span class="tag in">open</span>' : ''}</td>
      <td class="nowrap">${p.closed_at ? when(p.closed_at) : 'in progress'}</td><td class="n">${q(u)}</td>
      ${pr ? `<td class="n">${money(s)}</td><td class="n">${money(pf)}</td><td class="n">${money(sum(rows, 'value'))}</td>` : ''}
      <td class="nowrap"><button class="btn small" type="button" data-rep="${p.id}">View</button>
        <button class="btn small" type="button" data-csv="${p.id}">Excel</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted center pad">No stock takes in this range.</td></tr>';
  $('#repTotals').textContent = `${pers.length} stock take(s) · ${q(tu)} units` + (pr ? ` · sales ${money(ts)} · profit ${money(tp)}` : '');
  renderReportDetail();
}

function renderReportDetail() {
  const R = S.report, el = $('#repDetail');
  if (!R.open) { el.innerHTML = ''; return; }
  const per = R.periods.find(p => p.id === R.open), rows = periodRows(R.open), pr = can('see_prices');
  el.innerHTML = `<h3>${esc(per.name)}</h3><div class="panel scroll"><table class="grid"><thead><tr><th>Product</th><th>Category</th>
    <th class="n">Opening</th><th class="n">Received</th><th class="n">Removed</th><th class="n">Counted</th><th class="n">Sold</th>
    ${pr ? '<th class="n">Sell</th><th class="n">Sales</th><th class="n">Profit</th>' : ''}<th>Counted by</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.category)}</td><td class="n">${q(r.opening)}</td><td class="n">${q(r.in)}</td>
      <td class="n">${q(r.out)}</td><td class="n">${q(r.closing)}</td><td class="n${r.sold < 0 ? ' warn' : ''}">${q(r.sold)}</td>
      ${pr ? `<td class="n">${money(r.sell)}</td><td class="n">${r.sales === null ? '' : money(r.sales)}</td><td class="n">${r.profit === null ? '' : money(r.profit)}</td>` : ''}
      <td class="muted">${esc(r.counted_by || '')}</td></tr>`).join('')}
    </tbody></table></div><p class="note">A negative "sold" (red) means the count is higher than expected — check it.</p>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exportCsv(perId) {
  const per = S.report.periods.find(p => p.id === perId), rows = periodRows(perId), pr = can('see_prices');
  const head = ['Product', 'Category', 'Opening', 'Received', 'Removed', 'Counted', 'Sold'].concat(pr ? ['Buy', 'Sell', 'Sales', 'Profit', 'Stock value'] : []);
  const cell = v => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = [head.join(',')].concat(rows.map(r => [r.name, r.category, r.opening, r.in, r.out, r.closing, r.sold]
    .concat(pr ? [r.buy, r.sell, r.sales, r.profit, r.value] : []).map(cell).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `Sapphire ${per.name}.csv`.replace(/[\\/:*?"<>|]/g, '-');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#repRange').addEventListener('change', () => S.report && renderReports());
$('#repBody').addEventListener('click', e => {
  const v = e.target.closest('[data-rep]'), c = e.target.closest('[data-csv]');
  if (v) { S.report.open = +v.dataset.rep; renderReports(); }
  if (c) exportCsv(+c.dataset.csv);
});

// ---- changes
function renderChanges() {
  const who = $('#chUser'), cur = who.value;
  const names = [...new Set(S.changes.map(c => c.username))].sort();
  who.innerHTML = '<option value="">Everyone</option>' + names.map(n => `<option${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const onlyNew = $('#chNew').checked;
  const list = S.changes.filter(c => (!cur || c.username === cur) && (!onlyNew || !c.seen));
  $('#markSeen').classList.toggle('hide', !S.changes.some(c => !c.seen));
  $('#chBody').innerHTML = list.map(c => `<tr class="${c.seen ? '' : 'new'}">
    <td class="nowrap">${when(c.ts)}</td><td>${esc(c.username)}</td>
    <td><span class="tag ${esc(c.action.replace(/\s+/g, '-'))}">${esc(c.action)}</span></td><td>${esc(c.product_name || '')}</td>
    <td>${c.field ? `<span class="muted">${esc(c.field)}:</span> ${esc(c.old_value ?? '—')} → <b>${esc(c.new_value ?? '—')}</b> ` : ''}<span class="muted">${esc(c.note || '')}</span></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted center pad">No changes yet.</td></tr>';
}
$('#chUser').addEventListener('change', renderChanges);
$('#chNew').addEventListener('change', renderChanges);
$('#markSeen').addEventListener('click', async () => {
  try { await rpc('mark_changes_seen'); toast('All marked as reviewed'); reload(); } catch (e) { toast(friendly(e), true); }
});

// ---- accounts
function renderUsers() {
  $('#userBody').innerHTML = S.users.map(u => `<tr class="${u.active ? '' : 'off'}">
    <td><b>${esc(u.full_name || u.username)}</b><br><small class="muted">${esc(u.username)}</small></td>
    <td>${u.role === 'admin' ? '<span class="tag admin">Everything (admin)</span>' : (u.perms.length ? u.perms.map(p => `<span class="tag">${esc(PERMS[p] || p)}</span>`).join(' ') : '<span class="muted">Nothing yet</span>')}</td>
    <td>${u.active ? '<span class="tag in">Active</span>' : '<span class="tag out">Disabled</span>'}</td>
    <td><button class="btn small" type="button" data-user="${u.id}">Edit</button></td></tr>`).join('');
}
function openUser(u) {
  const f = $('#fUser'); f.reset(); f.querySelector('.err').textContent = '';
  f.dataset.id = u ? u.id : '';
  $('#dlgUserTitle').textContent = u ? 'Edit account' : 'Add account';
  $('#pwLbl').textContent = u ? 'New password (leave blank to keep)' : 'Password (at least 8 characters)';
  f.password.required = !u;
  f.username.disabled = !!u;
  $$('#fUser .edit-only').forEach(el => el.classList.toggle('hide', !u));
  const perms = u ? u.perms : DEFAULT_WORKER;
  $('#permGrid').innerHTML = '<legend>Worker is allowed to</legend>' + Object.entries(PERMS).map(([k, label]) =>
    `<label class="chk"><input type="checkbox" name="perm" value="${k}"${perms.includes(k) ? ' checked' : ''}> ${esc(label)}</label>`).join('');
  if (u) { f.full_name.value = u.full_name || ''; f.username.value = u.username; f.role.value = u.role; f.active.checked = u.active; }
  const sync = () => $('#permGrid').classList.toggle('hide', f.role.value === 'admin');
  f.role.onchange = sync; sync();
  $('#dlgUser').showModal();
}
$('#addUser').addEventListener('click', () => openUser(null));
$('#userBody').addEventListener('click', e => { const b = e.target.closest('[data-user]'); if (b) openUser(S.users.find(u => u.id === b.dataset.user)); });
$('#fUser').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target, perms = $$('#permGrid input:checked').map(i => i.value);
  try {
    if (f.dataset.id) {
      await rpc('admin_update_user', { p_id: f.dataset.id, p_full_name: f.full_name.value, p_role: f.role.value, p_perms: perms, p_active: f.active.checked });
      if (f.password.value) await rpc('admin_set_password', { p_id: f.dataset.id, p_password: f.password.value });
    } else {
      await rpc('admin_create_user', { p_username: f.username.value.trim().toLowerCase(), p_full_name: f.full_name.value,
        p_password: f.password.value, p_role: f.role.value, p_perms: perms });
    }
    $('#dlgUser').close(); toast('Account saved'); reload();
  } catch (x) { f.querySelector('.err').textContent = friendly(x); }
});

// ---- password
function openPw(forced) {
  const f = $('#fPw'); f.reset(); f.querySelector('.err').textContent = '';
  $('#pwForced').classList.toggle('hide', !forced);
  $('#pwCancel').classList.toggle('hide', forced);
  f.dataset.forced = forced ? '1' : '';
  $('#dlgPw').showModal();
}
$('#pwBtn').addEventListener('click', () => openPw(false));
$('#dlgPw').addEventListener('cancel', e => { if ($('#fPw').dataset.forced) e.preventDefault(); });
$('#fPw').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target, err = f.querySelector('.err');
  if (f.new.value !== f.new2.value) { err.textContent = 'New passwords do not match'; return; }
  try {
    await rpc('change_my_password', { p_old: f.old.value, p_new: f.new.value });
    S.me.must_change = false; $('#dlgPw').close(); toast('Password changed');
  } catch (x) { err.textContent = friendly(x); }
});

// ------------------------------------------------------------ tabs
function openTab(t) {
  S.tab = t;
  $$('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('[data-panel]').forEach(p => p.classList.toggle('hide', p.id !== 'tab-' + t));
  if (t === 'reports') loadReports(); else render();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) openTab(b.dataset.tab); });

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') { S.me = null; show('loginView'); } });
start().catch(e => { show('loginView'); $('#loginErr').textContent = friendly(e); });
})();
