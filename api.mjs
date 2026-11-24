// VTXOnline shared backend (Netlify Function + Netlify Blobs).
import crypto from 'node:crypto';

const ADMIN_HASH = '06b91202fcab8d562d4d706bc4184325f1239daf9ea1c3354968d8ef901fa924';
const CATS = ['Fashion','Shoes','Beauty','Accessories','Electronics','Home','Food','Other'];
const N = 48;
const AI_SYSTEM = `You are VTX AI, the in-app guide for VTXOnline Shopping, a marketplace where brand owners sell products and shoppers order from them.
Explain things simply and directly, in under 120 words. Use plain text with **bold** for key terms. Never invent features.
Never reveal or guess passwords, admin credentials or private data.

How the app works:
- Sign in / Create account (name, email, phone, password 6+ chars).
- Create store (#/store): brand name, logo, description, tagline, announcement bar, banner, WhatsApp. Non-admin owners pay a one-time listing fee online with Paystack (card, bank transfer or USSD). After payment the store automatically shows Publishing (automatic checks, a few seconds) and then Active (live). Draft means a check failed.
- Products (#/products): add product with real photo, price, description (10+ chars). New products show Publishing, then Active. Draft shows the reason.
- Market (#/market): shoppers browse Active products and brands, search, filter by category.
- Cart and Checkout: name, phone, address, city, state, optional GPS location, optional discount code, tap Pay and pay the total online with Paystack (card, bank transfer or USSD). The order is confirmed automatically; unpaid orders are cancelled after 30 minutes and can be paid from Orders with Pay now.
- Orders (#/orders): Awaiting payment -> Paid (automatic after Paystack confirms) -> Shipped (brand owner) -> Delivered (buyer taps I received it). Brand owners see delivery details after payment is confirmed.
- Commission: VTXOnline keeps the commission percent (given in context) of each confirmed order; the brand gets the rest. Admin marks Seller paid out.
- Customers (#/customers), Discounts (#/discounts: code + percent), Marketing (#/marketing: store link, WhatsApp share), Analytics (#/chart: live brand index chart, simulated movement, sales push brands up), Connect store (#/connect: Shopify product import; Printify, WooCommerce, Etsy, Wix, Other save a request for the admin).
- Balance (#/wallet): sellers earn the payout (after commission) of each online order once the buyer confirms delivery. Sellers can withdraw to a bank account (Opay or any bank) or a crypto wallet (USDT on BNB Smart Chain, Ethereum, Polygon or TRON). The admin sends the money manually and marks the withdrawal paid or rejected. POS sales are paid directly to the seller and do not add to the balance.
- VTX POS (/pos/): staff sign in with the same VTX Online login to sell in person, manage products and see online orders. It also has a Design studio to design clothes, bags, shoes and more and save them as products.
- Settings (#/settings): profile, password; admin also payment account, fee, commission, backup.
- Data is stored in the user's own browser in this version; other people's devices do not see it until a shared database is connected.

When useful, end with navigation tags in exactly this form: [[go:#/store|Open Create store]]. Allowed targets: #/home #/market #/orders #/products #/customers #/chart #/marketing #/discounts #/store #/wallet #/connect #/menu #/settings #/cart #/auth #/admin.
If the question is unrelated to the app, say you can only help with VTXOnline.`;
const PLATFORMS = ['Shopify','Printify','WooCommerce','Etsy','Wix','Other store'];

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const rid = p => p + crypto.randomBytes(6).toString('hex');
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const pst = p => p.status || 'active';

async function getStores() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return { main: getStore({ name: 'vtx', consistency: 'strong' }), img: getStore({ name: 'vtx-img', consistency: 'strong' }) };
  } catch (e) {
    console.error('blobs unavailable', e);
    throw new HttpError(503, 'Shared storage is not available on this deployment. ' + String((e && e.message) || e).slice(0, 160));
  }
}

class DB {
  constructor(st) { this.st = st; this.d = {}; this.dirty = new Set(); }
  async get(k, def) { if (!(k in this.d)) { const v = await this.st.get(k, { type: 'json' }); this.d[k] = v ?? def; } return this.d[k]; }
  col(k) { return this.get(k, []); }
  mark(k) { this.dirty.add(k); }
  async flush() {
    if (!this.dirty.size) return;
    const meta = await this.get('meta', {});
    if (this.dirty.has('brands') || this.dirty.has('products')) {
      const all = [...(await this.col('brands')), ...(await this.col('products'))].filter(x => x.status === 'publishing').map(x => x.publishAt || 0);
      meta.nextAt = all.length ? Math.min(...all) : 0;
    }
    meta.v = (meta.v || 0) + 1;
    this.dirty.add('meta');
    for (const k of this.dirty) await this.st.setJSON(k, this.d[k]);
    this.dirty.clear();
  }
}

const hashPw = (ph, salt) => crypto.scryptSync(ph, salt, 32).toString('hex');
function setPw(u, ph) { u.salt = crypto.randomBytes(8).toString('hex'); u.pw = hashPw(ph, u.salt); delete u.pass; }
function checkPw(u, ph) {
  if (typeof ph !== 'string' || !/^[a-f0-9]{64}$|^x/.test(ph)) return false;
  if (u.pw) { const a = Buffer.from(hashPw(ph, u.salt)), b = Buffer.from(u.pw); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  return !!u.pass && u.pass === ph;
}
const pubUser = u => { const { pw, salt, pass, ...r } = u; return r; };

async function init(db) {
  let meta = await db.get('meta', null);
  if (meta) return;
  const t = Date.now();
  const secret = crypto.randomBytes(32).toString('hex');
  db.d.secret = { s: secret }; db.mark('secret');
  db.d.meta = { v: 1, nextAt: 0, lastTick: 0, bump: {} };
  db.d.settings = { fee: 1500, commission: 0.1, usdRate: 0, account: { name: 'Nnaemeka Chiagozie Cyprian', bank: 'Opay', number: '7015166537' } }; db.mark('settings');
  db.d.users = [{ id: 'u_admin', name: 'VTX Admin', email: (process.env.ADMIN_EMAIL || 'admin@vtxonline.com').toLowerCase(), phone: '', pass: ADMIN_HASH, role: 'admin', created: t }]; db.mark('users');
  db.d.brands = [{ id: 'b_vtx', ownerId: 'u_admin', name: 'VTX Apparel', category: 'Fashion', description: 'Sharp, modern streetwear from the VTX studio. Official VTXOnline brand.', logo: '', status: 'active', created: t, featured: true }]; db.mark('brands');
  for (const k of ['products', 'orders', 'payments', 'connections', 'discounts', 'ledger', 'possales']) { db.d[k] = []; db.mark(k); }
  db.d.series = {}; db.mark('series');
  db.mark('meta');
  await db.flush();
}

/* ----- auth ----- */
const b64 = s => Buffer.from(s).toString('base64url');
async function signToken(db, uid) {
  const { s } = await db.get('secret', null);
  const p = uid + '.' + (Date.now() + 30 * 864e5);
  return b64(p) + '.' + crypto.createHmac('sha256', s).update(p).digest('hex');
}
async function authUser(req, db) {
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const [pb, sig] = h.slice(7).split('.');
  if (!pb || !sig) return null;
  let p; try { p = Buffer.from(pb, 'base64url').toString(); } catch (e) { return null; }
  const { s } = await db.get('secret', null);
  const good = crypto.createHmac('sha256', s).update(p).digest('hex');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const [uid, exp] = p.split('.');
  if (Date.now() > Number(exp)) return null;
  return (await db.col('users')).find(u => u.id === uid) || null;
}
function need(u) { if (!u) bad('Please sign in first.', 401); return u; }
function needAdmin(u) { need(u); if (u.role !== 'admin') bad('Admin only.', 403); return u; }

/* ----- time based work ----- */
async function sweep(db, now) {
  const brands = await db.col('brands'), prods = await db.col('products');
  brands.forEach(b => { if (b.status === 'publishing' && (b.publishAt || 0) <= now) { b.status = (b.name && b.description) ? 'active' : 'draft'; db.mark('brands'); } });
  prods.forEach(p => {
    if (p.status === 'publishing' && (p.publishAt || 0) <= now) {
      const why = !(p.images && p.images.length) ? 'Add at least one real photo.' : !(p.price > 0) ? 'Set a price above 0.' : (p.description || '').trim().length < 10 ? 'Write a longer description (10+ characters).' : '';
      if (why) { p.status = 'draft'; p.note = why; } else { p.status = 'active'; p.note = ''; }
      db.mark('products');
    }
  });
}
async function tick(db, now) {
  const meta = await db.get('meta', {}), series = await db.get('series', {}), brands = await db.col('brands');
  const steps = Math.max(1, Math.min(6, Math.floor((now - (meta.lastTick || 0)) / 12000)));
  meta.bump = meta.bump || {};
  const live = brands.filter(b => b.status === 'active');
  for (let s = 0; s < steps; s++) {
    live.forEach(b => {
      let a = series[b.id];
      if (!a) { let v = 70 + Math.random() * 60; a = []; for (let i = 0; i < N; i++) { v = Math.max(10, v * (1 + (Math.random() - .5) * .05)); a.push(+v.toFixed(2)); } series[b.id] = a; }
      const bump = meta.bump[b.id] || 0, last = a[a.length - 1];
      a.push(+Math.max(5, last * (1 + (Math.random() - .5) * .04 + bump * .01)).toFixed(2)); if (a.length > N) a.shift();
      meta.bump[b.id] = bump * .7;
    });
  }
  Object.keys(series).forEach(id => { if (!live.some(b => b.id === id)) delete series[id]; });
  meta.lastTick = now; db.mark('series'); db.mark('meta');
}

/* ----- visibility ----- */
async function buildState(db, u) {
  const admin = u?.role === 'admin';
  const [users, brands, products, orders, payments, conns, discs] = await Promise.all(['users', 'brands', 'products', 'orders', 'payments', 'connections', 'discounts'].map(k => db.col(k)));
  const settings = await db.get('settings', {}), series = await db.get('series', {});
  const mine = u ? brands.filter(b => b.ownerId === u.id).map(b => b.id) : [];
  const activeIds = new Set(brands.filter(b => b.status === 'active').map(b => b.id));
  const S = {
    settings: { fee: settings.fee, commission: settings.commission, usdRate: settings.usdRate || 0, account: settings.account, minWithdraw: settings.minWithdraw ?? 1000, payOn: payConfigured(), paystackKey: process.env.PAYSTACK_PUBLIC_KEY || '' },
    wd: admin ? (await db.col('ledger')).filter(l => l.type === 'withdrawal' && l.status === 'pending').length : 0,
    series, me: u ? u.id : null,
    brands: admin ? brands : brands.filter(b => activeIds.has(b.id) || mine.includes(b.id)),
    products: admin ? products : products.filter(p => (pst(p) === 'active' && activeIds.has(p.brandId)) || mine.includes(p.brandId)),
    users: admin ? users.map(pubUser) : (u ? [pubUser(u)] : []),
    payments: admin ? payments : (u ? payments.filter(p => p.userId === u.id) : []),
    connections: admin ? conns : (u ? conns.filter(c => c.userId === u.id) : []),
    discounts: admin ? discs : discs.filter(d => mine.includes(d.brandId)),
    orders: []
  };
  if (u) {
    const blank = { name: '', phone: '', address: '', city: '', state: '', landmark: '' };
    S.orders = admin ? orders : orders.filter(o => o.buyerId === u.id || mine.includes(o.brandId)).map(o => {
      const asSeller = mine.includes(o.brandId) && o.buyerId !== u.id;
      if (!asSeller) return o;
      const hide = ['verifying', 'cancelled'].includes(o.status);
      return { ...o, ref: '', ship: hide ? blank : o.ship };
    });
  }
  return S;
}

/* ----- helpers ----- */
const okImg = s => typeof s === 'string' && (/^\/api\?img=[a-f0-9]{24}$/.test(s) || /^https:\/\/[^\s"'<>]{4,500}$/.test(s));
const okUrl = s => s === '' || okImg(s);
const myBrandOf = async (db, u) => (await db.col('brands')).find(b => b.ownerId === u.id);
function cleanProduct(d) {
  const name = str(d.name, 80), description = str(d.description, 1500), price = num(d.price), stock = Math.max(0, Math.floor(num(d.stock)));
  if (!name) bad('Product name is required.');
  if (!(price > 0)) bad('Enter a price above 0.');
  const category = CATS.includes(d.category) ? d.category : 'Other';
  const images = (Array.isArray(d.images) ? d.images : []).filter(okImg).slice(0, 4);
  const out = { name, description, price, stock, category, images };
  if ('barcode' in d) out.barcode = str(d.barcode, 40);
  if ('cost' in d) out.cost = Math.max(0, num(d.cost));
  if ('low' in d) out.low = Math.max(0, Math.floor(num(d.low)));
  return out;
}
const counted = o => ['paid', 'shipped', 'delivered'].includes(o.status);

/* ----- Paystack online payments ----- */
const payConfigured = () => !!(process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_PUBLIC_KEY);
async function paystackVerify(ref) {
  const key = process.env.PAYSTACK_SECRET_KEY; if (!key) bad('Online payment is not set up yet.', 503);
  let r; try { r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(ref), { headers: { authorization: 'Bearer ' + key } }); } catch (e) { bad('Could not reach the payment provider. Try again.', 502); }
  const j = await r.json().catch(() => ({}));
  return r.ok && j.status ? j.data : null;
}
async function fulfill(db, ref, u) {
  const now = Date.now();
  if (ref.startsWith('VTXO-')) {
    const orders = await db.col('orders'); let mine = orders.filter(o => o.payRef === ref);
    if (u) mine = mine.filter(o => o.buyerId === u.id);
    if (!mine.length) return { paid: false, error: 'Order not found.' };
    if (mine.every(o => !['verifying', 'cancelled'].includes(o.status))) return { paid: true, already: true };
    const data = await paystackVerify(ref);
    if (!data || data.status !== 'success') return { paid: false, status: data ? data.status : 'unknown' };
    const expected = Math.round(mine.reduce((a, o) => a + o.subtotal, 0) * 100);
    if (data.currency !== 'NGN' || data.amount < expected) return { paid: false, error: 'The amount paid does not match the order.' };
    const prods = await db.col('products'), meta = await db.get('meta', {}); meta.bump = meta.bump || {};
    mine.forEach(o => {
      if (o.status === 'cancelled') o.items.forEach(i => { const p = prods.find(x => x.id === i.pid); if (p) p.stock = Math.max(0, p.stock - i.qty); });
      if (['verifying', 'cancelled'].includes(o.status)) {
        o.status = 'paid'; o.paidAt = now; o.payMethod = 'Paystack'; o.payTx = String(data.id || ''); o.note = '';
        meta.bump[o.brandId] = (meta.bump[o.brandId] || 0) + Math.min(8, 2 + o.subtotal / 20000);
      }
    });
    db.mark('orders'); db.mark('products'); db.mark('meta'); return { paid: true };
  }
  if (ref.startsWith('VTXF-')) {
    const pays = await db.col('payments'); const p = pays.find(x => x.reference === ref && (!u || x.userId === u.id));
    if (!p) return { paid: false, error: 'Payment not found.' };
    if (p.status === 'approved') return { paid: true, already: true };
    const data = await paystackVerify(ref);
    if (!data || data.status !== 'success') return { paid: false, status: data ? data.status : 'unknown' };
    if (data.currency !== 'NGN' || data.amount < Math.round(p.amount * 100)) return { paid: false, error: 'The amount paid does not match the listing fee.' };
    p.status = 'approved'; p.paidAt = now; p.payTx = String(data.id || '');
    const b = (await db.col('brands')).find(x => x.id === p.brandId);
    if (b && ['unpaid', 'rejected', 'pending'].includes(b.status)) { b.status = 'publishing'; b.publishAt = now + 3000; db.mark('brands'); }
    db.mark('payments'); return { paid: true };
  }
  return { paid: false, error: 'Unknown reference.' };
}
async function cleanupUnpaid(db, now) {
  const orders = await db.col('orders'), prods = await db.col('products');
  orders.forEach(o => {
    if (o.status === 'verifying' && o.payRef && now - o.created > 30 * 60 * 1000) {
      o.status = 'cancelled'; o.note = 'Not paid in time';
      o.items.forEach(i => { const p = prods.find(x => x.id === i.pid); if (p) p.stock += i.qty; });
      db.mark('orders'); db.mark('products');
    }
  });
}

/* ----- wallet ----- */
async function ensureCredits(db, userId) {
  const brandIds = (await db.col('brands')).filter(b => b.ownerId === userId).map(b => b.id);
  if (!brandIds.length) return;
  const orders = await db.col('orders'), led = await db.col('ledger'); let ch = false;
  orders.forEach(o => {
    if (brandIds.includes(o.brandId) && o.status === 'delivered' && !o.payoutDone && !led.some(l => l.orderId === o.id)) {
      led.push({ id: rid('l_'), userId, type: 'credit', orderId: o.id, amount: o.payout, created: Date.now(), note: 'Order ' + o.id }); ch = true;
    }
  });
  if (ch) db.mark('ledger');
}
function walletSummary(led, orders, brandIds, userId) {
  const mine = led.filter(l => l.userId === userId);
  const credits = r2(mine.filter(l => l.type === 'credit').reduce((a, l) => a + l.amount, 0));
  const live = mine.filter(l => l.type === 'withdrawal' && l.status !== 'rejected');
  const out = r2(live.reduce((a, l) => a + l.amount, 0));
  return {
    available: r2(credits - out), earned: credits,
    withdrawn: r2(mine.filter(l => l.type === 'withdrawal' && l.status === 'paid').reduce((a, l) => a + l.amount, 0)),
    held: r2(mine.filter(l => l.type === 'withdrawal' && l.status === 'pending').reduce((a, l) => a + l.amount, 0)),
    pending: r2(orders.filter(o => brandIds.includes(o.brandId) && ['paid', 'shipped'].includes(o.status)).reduce((a, o) => a + o.payout, 0))
  };
}
const NETWORKS = ['BNB Smart Chain (BEP-20)', 'Ethereum (ERC-20)', 'Polygon', 'TRON (TRC-20)'];

/* ----- actions ----- */
async function act(body, db, u, st) {
  const a = body.a, now = Date.now();
  switch (a) {
    case 'state': {
      const meta = await db.get('meta', {});
      const needSweep = meta.nextAt && now >= meta.nextAt, needTick = now - (meta.lastTick || 0) >= 12000;
      if (body.v && body.v === meta.v && !needSweep && !needTick) return { same: true, v: meta.v };
      if (needSweep) await sweep(db, now);
      if (needTick) { await tick(db, now); await cleanupUnpaid(db, now); }
      await db.flush();
      const m2 = await db.get('meta', {});
      return { v: m2.v, state: await buildState(db, u) };
    }
    case 'signup': {
      const name = str(body.name, 60), email = str(body.email, 120).toLowerCase(), phone = str(body.phone, 30);
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || phone.length < 5) bad('Enter your name, a valid email and phone number.');
      if (!/^[a-f0-9]{64}$|^x/.test(body.pass || '')) bad('Invalid password.');
      const users = await db.col('users');
      if (users.some(x => x.email === email)) bad('That email already has an account. Sign in instead.');
      const nu = { id: rid('u_'), name, email, phone, role: 'user', created: now }; setPw(nu, body.pass);
      users.push(nu); db.mark('users');
      return { token: await signToken(db, nu.id) };
    }
    case 'login': {
      const email = str(body.email, 120).toLowerCase();
      const users = await db.col('users'), x = users.find(y => y.email === email);
      if (!x || !checkPw(x, body.pass)) { await new Promise(r => setTimeout(r, 400)); bad('Email or password is incorrect.'); }
      if (!x.pw) { setPw(x, body.pass); db.mark('users'); }
      return { token: await signToken(db, x.id) };
    }
    case 'profile': {
      need(u); const users = await db.col('users'), x = users.find(y => y.id === u.id);
      x.name = str(body.name, 60) || x.name; x.phone = str(body.phone, 30);
      if (u.role === 'admin' && body.email) {
        const e = str(body.email, 120).toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) bad('Enter a valid email.');
        if (users.some(y => y.email === e && y.id !== x.id)) bad('That email is already used.');
        x.email = e;
      }
      db.mark('users'); return { ok: 1 };
    }
    case 'password': {
      need(u); const users = await db.col('users'), x = users.find(y => y.id === u.id);
      if (!checkPw(x, body.old)) bad('Current password is incorrect.');
      if (!/^[a-f0-9]{64}$|^x/.test(body.new || '')) bad('Invalid password.');
      setPw(x, body.new); db.mark('users'); return { ok: 1 };
    }
    case 'settings': {
      needAdmin(u); const s = await db.get('settings', {});
      const ac = body.account || {};
      s.account = { name: str(ac.name, 80) || s.account.name, bank: str(ac.bank, 40) || s.account.bank, number: str(ac.number, 20) || s.account.number };
      s.minWithdraw = Math.max(0, num(body.minWithdraw));
      s.fee = Math.max(0, num(body.fee)); s.commission = Math.min(1, Math.max(0, num(body.commission))); s.usdRate = Math.max(0, num(body.usdRate));
      db.mark('settings'); return { ok: 1 };
    }
    case 'upload': {
      need(u); const d = body.d;
      const m = typeof d === 'string' && d.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) bad('That image could not be used.');
      if (d.length > 1_400_000) bad('That photo is too large.');
      const id = crypto.randomBytes(12).toString('hex');
      await st.img.set(id, d);
      return { url: '/api?img=' + id };
    }
    case 'brand.create': {
      need(u); const brands = await db.col('brands');
      if (brands.some(b => b.ownerId === u.id)) bad('You already have a store.');
      const name = str(body.name, 40), description = str(body.description, 1000);
      if (!name || !description) bad('Add a brand name and description.');
      const logo = okUrl(body.logo || '') ? (body.logo || '') : '';
      const admin = u.role === 'admin';
      brands.push({ id: rid('b_'), ownerId: u.id, name, category: CATS.includes(body.category) ? body.category : 'Other', description, logo, status: admin ? 'publishing' : 'unpaid', publishAt: now + 6000, created: now });
      db.mark('brands'); return { ok: 1 };
    }
    case 'brand.save': {
      need(u); const b = await myBrandOf(db, u); if (!b) bad('Create your store first.');
      b.name = str(body.name, 40) || b.name; b.tagline = str(body.tagline, 80); b.description = str(body.description, 1000) || b.description;
      b.announce = str(body.announce, 100); b.whatsapp = str(body.whatsapp, 30);
      if (body.logo && okImg(body.logo)) b.logo = body.logo;
      if (body.banner && okImg(body.banner)) b.banner = body.banner;
      if (b.status === 'draft') { b.status = 'publishing'; b.publishAt = now + 4000; }
      db.mark('brands'); return { ok: 1 };
    }
    case 'pay.submit': {
      need(u); const b = await myBrandOf(db, u);
      if (!b || !['unpaid', 'rejected'].includes(b.status)) bad('Nothing to pay for right now.');
      bad('Manual payments are no longer accepted. Please pay online.');
      const ref = str(body.ref, 80);
      const s = await db.get('settings', {}), pays = await db.col('payments');
      pays.push({ id: rid('pay_'), brandId: b.id, userId: u.id, amount: s.fee, ref, proof: okUrl(body.proof || '') ? (body.proof || '') : '', status: 'pending', created: now });
      b.status = 'pending'; db.mark('payments'); db.mark('brands'); return { ok: 1 };
    }
    case 'pay.act': {
      needAdmin(u); const pays = await db.col('payments'), p = pays.find(x => x.id === body.id); if (!p) bad('Payment not found.', 404);
      const b = (await db.col('brands')).find(x => x.id === p.brandId);
      if (body.v === 'approve') { p.status = 'approved'; if (b) { b.status = 'publishing'; b.publishAt = now + 8000; } }
      else if (body.v === 'reject') { p.status = 'rejected'; if (b) b.status = 'rejected'; }
      else bad('Unknown action.');
      db.mark('payments'); db.mark('brands'); return { ok: 1 };
    }
    case 'brand.admin': {
      needAdmin(u); const brands = await db.col('brands'), b = brands.find(x => x.id === body.id); if (!b) bad('Brand not found.', 404);
      if (body.v === 'delete') {
        if (b.id === 'b_vtx') bad('The VTX Apparel brand cannot be deleted.');
        db.d.brands = brands.filter(x => x.id !== b.id); db.d.products = (await db.col('products')).filter(p => p.brandId !== b.id); db.mark('brands'); db.mark('products');
      } else if (['active', 'suspended'].includes(body.v)) { if (b.id === 'b_vtx' && body.v === 'suspended') bad('The VTX Apparel brand cannot be suspended.'); b.status = body.v; db.mark('brands'); }
      else bad('Unknown action.');
      return { ok: 1 };
    }
    case 'product.save': {
      need(u); const b = await myBrandOf(db, u); if (!b || !['active', 'publishing', 'draft'].includes(b.status)) bad('Your store must be created and paid before adding products.');
      const data = cleanProduct(body.data || {}), prods = await db.col('products');
      if (data.barcode && prods.some(x => x.brandId === b.id && x.barcode === data.barcode && x.id !== body.id)) bad('Another product already uses that barcode.');
      const meta = { status: 'publishing', publishAt: now + 6000, note: '' };
      if (body.id) {
        const p = prods.find(x => x.id === body.id); if (!p) bad('Product not found.', 404);
        if (p.brandId !== b.id && u.role !== 'admin') bad('Not your product.', 403);
        Object.assign(p, data, meta);
      } else prods.push({ id: rid('p_'), brandId: b.id, created: now, ...data, ...meta });
      db.mark('products'); return { ok: 1 };
    }
    case 'product.import': {
      need(u); const b = await myBrandOf(db, u); if (!b || b.status !== 'active') bad('Your store must be Active before importing.');
      const prods = await db.col('products'); let n = 0;
      for (const d of (Array.isArray(body.products) ? body.products : []).slice(0, 30)) {
        try { prods.push({ id: rid('p_'), brandId: b.id, created: now, source: 'import', ...cleanProduct(d), status: 'publishing', publishAt: now + 6000, note: '' }); n++; } catch (e) { /* skip bad rows */ }
      }
      db.mark('products'); return { count: n };
    }
    case 'product.delete': {
      need(u); const prods = await db.col('products'), p = prods.find(x => x.id === body.id); if (!p) return { ok: 1 };
      const b = (await db.col('brands')).find(x => x.id === p.brandId);
      if (u.role !== 'admin' && b?.ownerId !== u.id) bad('Not your product.', 403);
      db.d.products = prods.filter(x => x.id !== p.id); db.mark('products'); return { ok: 1 };
    }
    case 'code': {
      const code = str(body.code, 20).toUpperCase(); const ids = Array.isArray(body.brandIds) ? body.brandIds : [];
      const d = (await db.col('discounts')).find(x => x.code === code && x.active && ids.includes(x.brandId));
      return { discount: d ? { id: d.id, code: d.code, percent: d.percent, brandId: d.brandId } : null };
    }
    case 'order.create': {
      need(u);
      const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []; if (!items.length) bad('Your cart is empty.');
      const sh = body.ship || {};
      const ship = { name: str(sh.name, 80), phone: str(sh.phone, 30), address: str(sh.address, 250), city: str(sh.city, 60), state: str(sh.state, 60), landmark: str(sh.landmark, 120), lat: str(sh.lat, 20), lng: str(sh.lng, 20) };
      if (!ship.name || ship.phone.length < 5 || !ship.address || !ship.city || !ship.state) bad('Fill in your name, phone number, address, city and state.');
      if (!payConfigured()) bad('Online payment is not set up yet. Please try again later.', 503);
      const ref = str(body.ref, 80), payRef = 'VTXO-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const prods = await db.col('products'), brands = await db.col('brands'), settings = await db.get('settings', {});
      const by = {};
      for (const it of items) {
        const p = prods.find(x => x.id === it.pid), qty = Math.floor(num(it.qty));
        if (!p || pst(p) !== 'active' || brands.find(b => b.id === p.brandId)?.status !== 'active') bad('One of the items is no longer available.');
        if (qty < 1) bad('Invalid quantity.'); if (qty > p.stock) bad('Only ' + p.stock + ' of ' + p.name + ' left in stock.');
        (by[p.brandId] = by[p.brandId] || []).push({ p, qty });
      }
      const discs = await db.col('discounts'); const code = str(body.code, 20).toUpperCase();
      const dsc = code ? discs.find(x => x.code === code && x.active && by[x.brandId]) : null;
      const orders = await db.col('orders'), made = []; let total = 0;
      for (const [bid, xs] of Object.entries(by)) {
        const gross = xs.reduce((s, x) => s + x.p.price * x.qty, 0);
        const disc = dsc && dsc.brandId === bid ? Math.round(gross * dsc.percent) / 100 : 0;
        const net = gross - disc, r = settings.commission ?? 0.1, com = Math.round(net * r * 100) / 100;
        let id; do { id = 'VTX-' + crypto.randomBytes(3).toString('hex').toUpperCase(); } while (orders.some(o => o.id === id));
        orders.push({ id, buyerId: u.id, brandId: bid, items: xs.map(x => ({ pid: x.p.id, name: x.p.name, price: x.p.price, qty: x.qty })), gross, discount: disc, code: disc ? dsc.code : '', subtotal: net, rate: r, commission: com, payout: net - com, ship, ref, payRef, status: 'verifying', payoutDone: false, created: now });
        xs.forEach(x => { x.p.stock -= x.qty; }); total += net; made.push(id);
      }
      if (dsc && Object.values(by).length) { dsc.uses = (dsc.uses || 0) + 1; db.mark('discounts'); }
      const users = await db.col('users'), me = users.find(x => x.id === u.id); if (me && !me.phone) { me.phone = ship.phone; db.mark('users'); }
      db.mark('orders'); db.mark('products'); return { orders: made, total, reference: payRef };
    }
    case 'order.act': {
      need(u); const orders = await db.col('orders'), o = orders.find(x => x.id === body.id); if (!o) bad('Order not found.', 404);
      const brand = (await db.col('brands')).find(b => b.id === o.brandId); const admin = u.role === 'admin', seller = brand?.ownerId === u.id, buyer = o.buyerId === u.id;
      const v = body.v;
      if (v === 'confirm' && admin && o.status === 'verifying') { o.status = 'paid'; const m = await db.get('meta', {}); m.bump = m.bump || {}; m.bump[o.brandId] = (m.bump[o.brandId] || 0) + Math.min(8, 2 + o.subtotal / 20000); db.mark('meta'); }
      else if (v === 'ship' && (admin || seller) && o.status === 'paid') o.status = 'shipped';
      else if (v === 'deliver' && (admin || buyer) && o.status === 'shipped') o.status = 'delivered';
      else if (v === 'payout' && admin && counted(o)) o.payoutDone = true;
      else if (v === 'cancel' && admin && ['verifying', 'paid'].includes(o.status)) {
        o.status = 'cancelled'; const prods = await db.col('products');
        o.items.forEach(i => { const p = prods.find(x => x.id === i.pid); if (p) p.stock += i.qty; }); db.mark('products');
      } else bad('That action is not allowed right now.', 403);
      if (o.status === 'delivered' && brand) await ensureCredits(db, brand.ownerId);
      db.mark('orders'); return { ok: 1 };
    }
    case 'conn.add': {
      need(u); const platform = PLATFORMS.includes(body.platform) ? body.platform : 'Other store';
      (await db.col('connections')).push({ id: rid('c_'), userId: u.id, platform, url: str(body.url, 200), status: body.status === 'imported' ? 'imported' : 'requested', count: Math.max(0, Math.floor(num(body.count))), created: now });
      db.mark('connections'); return { ok: 1 };
    }
    case 'conn.del': {
      need(u); const c = await db.col('connections');
      db.d.connections = c.filter(x => !(x.id === body.id && (u.role === 'admin' || x.userId === u.id))); db.mark('connections'); return { ok: 1 };
    }
    case 'disc.save': {
      need(u); const b = await myBrandOf(db, u); if (!b) bad('Create your store first.');
      const code = str(body.code, 20).toUpperCase(); if (!/^[A-Z0-9]{3,20}$/.test(code)) bad('Use 3 to 20 letters or numbers.');
      const percent = Math.min(90, Math.max(1, Math.round(num(body.percent)))); const ds = await db.col('discounts');
      if (ds.some(x => x.code === code && x.brandId === b.id)) bad('You already have that code.');
      ds.push({ id: rid('d_'), brandId: b.id, code, percent, active: true, uses: 0, created: now }); db.mark('discounts'); return { ok: 1 };
    }
    case 'disc.toggle': case 'disc.del': {
      need(u); const b = await myBrandOf(db, u); const ds = await db.col('discounts'), d = ds.find(x => x.id === body.id);
      if (!d || (u.role !== 'admin' && d.brandId !== b?.id)) bad('Discount not found.', 404);
      if (a === 'disc.toggle') d.active = !d.active; else db.d.discounts = ds.filter(x => x.id !== d.id);
      db.mark('discounts'); return { ok: 1 };
    }
    case 'ai': {
      need(u); const key = process.env.ANTHROPIC_API_KEY; if (!key) bad('The online assistant is not set up.', 503);
      const clean = (Array.isArray(body.messages) ? body.messages : []).slice(-10)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 600) }));
      while (clean.length && clean[0].role !== 'user') clean.shift();
      if (!clean.length) bad('No message.');
      const c = body.context || {}; const ctx = { page: str(c.page, 30), role: u.role, storeStatus: str(c.storeStatus, 20), fee: (await db.get('settings', {})).fee, commissionPercent: Math.round(((await db.get('settings', {})).commission ?? 0.1) * 100), productCount: num(c.productCount) };
      let r; try {
        r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: process.env.VTX_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 450, system: AI_SYSTEM + '\n\nCurrent user context (JSON): ' + JSON.stringify(ctx), messages: clean }) });
      } catch (e) { bad('The assistant could not be reached.', 502); }
      if (!r.ok) bad('The assistant is busy. Try again.', 502);
      const j = await r.json();
      return { reply: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() };
    }
    case 'fee.init': {
      need(u); if (!payConfigured()) bad('Online payment is not set up yet. Please try again later.', 503);
      const b = await myBrandOf(db, u); if (!b || !['unpaid', 'rejected'].includes(b.status)) bad('Nothing to pay for right now.');
      const s = await db.get('settings', {}), pays = await db.col('payments');
      if (!(s.fee > 0)) { b.status = 'publishing'; b.publishAt = now + 3000; db.mark('brands'); return { free: true }; }
      let p = pays.find(x => x.brandId === b.id && x.status === 'awaiting' && x.amount === s.fee);
      if (!p) { p = { id: rid('pay_'), brandId: b.id, userId: u.id, amount: s.fee, ref: '', reference: 'VTXF-' + crypto.randomBytes(8).toString('hex').toUpperCase(), proof: '', status: 'awaiting', method: 'Paystack', created: now }; pays.push(p); db.mark('payments'); }
      return { reference: p.reference, amount: p.amount, email: u.email };
    }
    case 'order.verify': case 'fee.verify': {
      need(u); const ref = str(body.reference, 60);
      if (!/^VTX[OF]-[A-Z0-9]{16}$/.test(ref)) bad('Bad payment reference.');
      return await fulfill(db, ref, u);
    }
    case 'wallet.state': {
      need(u); await ensureCredits(db, u.id); await db.flush();
      const brandIds = (await db.col('brands')).filter(b => b.ownerId === u.id).map(b => b.id);
      const led = await db.col('ledger'), orders = await db.col('orders'), settings = await db.get('settings', {});
      const entries = led.filter(l => l.userId === u.id).sort((a, b) => b.created - a.created).slice(0, 100);
      return { summary: walletSummary(led, orders, brandIds, u.id), entries, minWithdraw: settings.minWithdraw ?? 1000, saved: u.payout || {}, hasStore: brandIds.length > 0 };
    }
    case 'wallet.withdraw': {
      need(u); await ensureCredits(db, u.id);
      const brandIds = (await db.col('brands')).filter(b => b.ownerId === u.id).map(b => b.id);
      const led = await db.col('ledger'), orders = await db.col('orders'), settings = await db.get('settings', {});
      const sum = walletSummary(led, orders, brandIds, u.id), amount = r2(num(body.amount)), min = settings.minWithdraw ?? 1000;
      if (!(amount > 0)) bad('Enter an amount.');
      if (amount < min) bad('The minimum withdrawal is ' + min + '.');
      if (amount > sum.available) bad('That is more than your available balance.');
      let dest;
      if (body.method === 'bank') {
        const b = body.bank || {}; dest = { bankName: str(b.bankName, 60), accountName: str(b.accountName, 80), accountNumber: str(b.accountNumber, 24).replace(/\s/g, '') };
        if (!dest.bankName || !dest.accountName || !/^[A-Za-z0-9-]{6,24}$/.test(dest.accountNumber)) bad('Enter your bank name, account name and a valid account number.');
      } else if (body.method === 'crypto') {
        const w = body.wallet || {}; dest = { network: NETWORKS.includes(w.network) ? w.network : NETWORKS[0], address: str(w.address, 80) };
        const evm = /^0x[a-fA-F0-9]{40}$/.test(dest.address), tron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(dest.address);
        if (dest.network.startsWith('TRON') ? !tron : !evm) bad('That wallet address does not match the network you chose.');
      } else bad('Choose bank or crypto wallet.');
      let rate = settings.usdRate > 0 ? settings.usdRate : num(body.rate); if (!(rate >= 100 && rate <= 20000)) rate = 1500;
      led.push({ id: rid('w_'), userId: u.id, type: 'withdrawal', method: body.method, dest, amount, usdt: body.method === 'crypto' ? r2(amount / rate) : 0, rate, status: 'pending', created: now });
      const users = await db.col('users'), me = users.find(x => x.id === u.id); me.payout = { bank: body.method === 'bank' ? dest : (me.payout || {}).bank, wallet: body.method === 'crypto' ? dest : (me.payout || {}).wallet };
      db.mark('ledger'); db.mark('users'); return { ok: 1 };
    }
    case 'wallet.admin': {
      needAdmin(u); const led = await db.col('ledger'), users = await db.col('users');
      const list = led.filter(l => l.type === 'withdrawal').sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created - a.created).slice(0, 200)
        .map(l => { const x = users.find(y => y.id === l.userId); return { ...l, userName: x?.name || '', userEmail: x?.email || '', userPhone: x?.phone || '' }; });
      return { withdrawals: list };
    }
    case 'wallet.act': {
      needAdmin(u); const led = await db.col('ledger'), l = led.find(x => x.id === body.id && x.type === 'withdrawal'); if (!l) bad('Withdrawal not found.', 404);
      if (l.status !== 'pending') bad('That withdrawal is already ' + l.status + '.');
      if (body.v === 'paid') { l.status = 'paid'; l.txref = str(body.txref, 120); l.paidAt = now; }
      else if (body.v === 'reject') { l.status = 'rejected'; l.rejectedAt = now; l.note = str(body.note, 120); }
      else bad('Unknown action.');
      db.mark('ledger'); return { ok: 1 };
    }
    case 'pos.state': {
      need(u); const meta = await db.get('meta', {});
      if (meta.nextAt && now >= meta.nextAt) { await sweep(db, now); await db.flush(); }
      const b = await myBrandOf(db, u);
      const settings = await db.get('settings', {});
      const base = { me: { id: u.id, name: u.name, email: u.email, role: u.role }, settings: { account: settings.account, usdRate: settings.usdRate || 0 } };
      if (!b) return { ...base, noStore: true };
      if (b.status !== 'active') return { ...base, brand: { id: b.id, name: b.name, status: b.status } };
      const prods = (await db.col('products')).filter(p => p.brandId === b.id);
      const sales = (await db.col('possales')).filter(s => s.brandId === b.id).slice(-400);
      const orders = (await db.col('orders')).filter(o => o.brandId === b.id).slice(-400).map(o => ['verifying', 'cancelled'].includes(o.status) ? { ...o, ref: '', ship: { name: o.ship.name, phone: '', address: '', city: '', state: '', landmark: '' } } : { ...o, ref: '' });
      return { ...base, brand: b, products: prods, sales, orders };
    }
    case 'pos.sale': {
      need(u); const b = await myBrandOf(db, u);
      if (!b || b.status !== 'active') bad('Your store must be Active to use the POS.');
      const prods = await db.col('products'), sales = await db.col('possales');
      const cid = str(body.cid, 40); if (!/^[A-Za-z0-9_-]{6,40}$/.test(cid)) bad('Bad sale id.');
      const dup = sales.find(s => s.id === cid); if (dup) return { sale: dup, dup: true };
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map(i => {
        const p = prods.find(x => x.id === i.pid && x.brandId === b.id); if (!p) bad('An item in this sale no longer exists.');
        const qty = Math.floor(num(i.qty)); if (qty < 1) bad('Invalid quantity.');
        return { pid: p.id, name: p.name, price: Math.max(0, r2(num(i.price))), cost: p.cost || 0, qty };
      });
      if (!items.length) bad('The sale is empty.');
      const sub = r2(items.reduce((a, i) => a + i.price * i.qty, 0));
      const d = body.disc || {}; const dv = Math.max(0, num(d.value));
      const disc = r2(d.type === 'amt' ? Math.min(sub, dv) : sub * Math.min(100, dv) / 100);
      const net = r2(sub - disc), vat = r2(net * (b.posVat || 0) / 100), total = r2(net + vat);
      const tenders = (Array.isArray(body.tenders) ? body.tenders : []).slice(0, 6).map(t => ({ method: ['Cash', 'Transfer', 'Card'].includes(t.method) ? t.method : 'Cash', amount: Math.max(0, r2(num(t.amount))), ref: str(t.ref, 80) })).filter(t => t.amount > 0);
      const paid = r2(tenders.reduce((a, t) => a + t.amount, 0));
      if (paid < total - 0.01) bad('Payment is less than the total.');
      let no = str(body.no, 20); if (!/^POS-[A-Z0-9]{4,14}$/.test(no) || sales.some(s => s.no === no)) no = 'POS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      let t = num(body.time) || now; if (t > now || t < now - 7 * 864e5) t = now;
      const cu = body.cust || {};
      const sale = { id: cid, no, brandId: b.id, cashierId: u.id, cashier: u.name, time: t, items, sub, disc, vat, total, tenders, tendered: Math.max(0, r2(num(body.tendered))) || paid, change: Math.max(0, r2(num(body.change))), cust: { name: str(cu.name, 60), phone: str(cu.phone, 30) }, note: str(body.note, 120), status: 'paid' };
      items.forEach(i => { const p = prods.find(x => x.id === i.pid); p.stock = Math.max(0, p.stock - i.qty); });
      sales.push(sale);
      const m = await db.get('meta', {}); m.bump = m.bump || {}; m.bump[b.id] = (m.bump[b.id] || 0) + Math.min(6, 1 + total / 20000);
      db.mark('possales'); db.mark('products'); db.mark('meta');
      return { sale };
    }
    case 'pos.refund': {
      need(u); const sales = await db.col('possales'), s = sales.find(x => x.id === body.id); if (!s) bad('Sale not found.', 404);
      const b = (await db.col('brands')).find(x => x.id === s.brandId);
      if (u.role !== 'admin' && b?.ownerId !== u.id) bad('Not your sale.', 403);
      if (s.status === 'refunded') return { sale: s };
      s.status = 'refunded'; s.refundedBy = u.name; s.refundedAt = now;
      const prods = await db.col('products'); s.items.forEach(i => { const p = prods.find(x => x.id === i.pid); if (p) p.stock += i.qty; });
      db.mark('possales'); db.mark('products'); return { sale: s };
    }
    case 'pos.settings': {
      need(u); const b = await myBrandOf(db, u); if (!b) bad('Create your store first.');
      b.posVat = Math.min(100, Math.max(0, num(body.vat))); b.posFooter = str(body.footer, 120); b.posAddress = str(body.address, 160); b.posPhone = str(body.phone, 30);
      const a = body.account || {}; b.posAccount = { name: str(a.name, 80), bank: str(a.bank, 40), number: str(a.number, 20) };
      db.mark('brands'); return { ok: 1 };
    }
    case 'migrate': {
      needAdmin(u); const c = body.c, recs = (Array.isArray(body.recs) ? body.recs : []).slice(0, 40);
      const clean = o => { const r = { ...o }; for (const k of ['logo', 'banner', 'proof']) if (r[k] && !okImg(r[k])) r[k] = ''; if (Array.isArray(r.images)) r.images = r.images.filter(okImg); return r; };
      if (c === 'settings') {
        const s = await db.get('settings', {}), r = recs[0] || {};
        if (r.account) s.account = { name: str(r.account.name, 80), bank: str(r.account.bank, 40), number: str(r.account.number, 20) };
        if (r.fee >= 0) s.fee = num(r.fee); if (r.commission >= 0 && r.commission <= 1) s.commission = num(r.commission);
        db.mark('settings'); return { ok: 1 };
      }
      if (!['brands', 'products', 'users', 'orders', 'payments', 'discounts', 'connections'].includes(c)) bad('Unknown collection.');
      const list = await db.col(c);
      for (const raw of recs) {
        if (!raw || typeof raw.id !== 'string') continue; let r = clean(raw);
        if (c === 'users') {
          if (r.id === 'u_admin') { const a0 = list.find(x => x.id === 'u_admin'); if (a0 && /^[a-f0-9]{64}$/.test(raw.pass || '')) { a0.pass = raw.pass; delete a0.pw; delete a0.salt; a0.name = str(raw.name, 60) || a0.name; a0.phone = str(raw.phone, 30); } continue; }
          if (list.some(x => x.email === String(r.email).toLowerCase() && x.id !== r.id)) continue;
          r = { id: r.id, name: str(r.name, 60), email: String(r.email).toLowerCase(), phone: str(r.phone, 30), role: 'user', created: r.created || now, pass: r.pass };
        }
        const i = list.findIndex(x => x.id === r.id); if (i >= 0) list[i] = { ...list[i], ...r }; else list.push(r);
      }
      db.mark(c); return { ok: 1 };
    }
    default: bad('Unknown request.', 404);
  }
}

export default async (req) => {
  try {
    const st = await getStores();
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'GET') {
      const id = url.searchParams.get('img');
      if (!id) return json({ ok: true, app: 'VTXOnline', storage: true, onlinePayments: payConfigured() });
      if (!/^[a-f0-9]{24}$/.test(id)) return new Response('Not found', { status: 404 });
      const d = await st.img.get(id, { type: 'text' });
      const m = d && d.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (!m) return new Response('Not found', { status: 404 });
      return new Response(Buffer.from(m[2], 'base64'), { headers: { 'content-type': m[1], 'cache-control': 'public, max-age=31536000, immutable', ...CORS } });
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const sig = req.headers.get('x-paystack-signature');
    if (sig) {
      const raw = await req.text(), key = process.env.PAYSTACK_SECRET_KEY || '';
      const good = key ? crypto.createHmac('sha512', key).update(raw).digest('hex') : '';
      if (!good || good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return new Response('invalid signature', { status: 401 });
      let ev = {}; try { ev = JSON.parse(raw); } catch (e) { /* ignore */ }
      if (ev.event === 'charge.success' && ev.data && typeof ev.data.reference === 'string') {
        const wdb = new DB(st.main); await init(wdb);
        try { await fulfill(wdb, ev.data.reference, null); await wdb.flush(); } catch (e) { console.error('webhook', e); }
      }
      return new Response('ok', { status: 200 });
    }
    const body = await req.json().catch(() => ({}));
    const db = new DB(st.main);
    await init(db);
    const user = await authUser(req, db);
    const out = await act(body, db, user, st);
    await db.flush();
    return json(out);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
};

export const config = { path: '/api' };
