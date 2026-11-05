/**
 * Builds a static preview of the quota panel for docs and design review.
 *
 * The stylesheet is extracted from `client.js`, so the preview cannot drift from what the
 * overlay actually renders; only the markup is mirrored here. Two variants exist because
 * the transport row has two sub-panels worth looking at: the DNS chips and the proxy field.
 *
 *   node preview/build-preview.mjs dns
 *   node preview/build-preview.mjs proxy
 *
 * Then screenshot `preview/preview-<variant>.html` (assets/panel-*.png are made this way).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const variant = (process.argv[2] || 'dns').toLowerCase();
if (!['dns', 'proxy'].includes(variant)) {
  console.error('usage: node preview/build-preview.mjs dns|proxy');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '..', 'plugins', 'quota-overlay', 'client.js');
const client = fs.readFileSync(plugin, 'utf8');

const stylesheet = client.match(/const CSS = `([\s\S]*?)`;/);
if (!stylesheet) {
  console.error('cannot find the CSS block in client.js');
  process.exit(1);
}

const styles = stylesheet[1];

const tone = (pct) => (pct > 50 ? 'var(--good)' : pct > 20 ? 'var(--warn)' : 'var(--bad)');

function ring(pct, size = 46, bare = false) {
  const radius = size / 2 - 4.5;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="3"/>
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${tone(pct)}" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
  </svg>${bare ? '' : `<b>${pct}%</b>`}</div>`;
}

function group(name, weekly, five, reset) {
  return `<div class="grp">${ring(weekly)}
    <div class="meta"><b>${name}</b>
      <span>weekly resets ${reset}</span>
      <span class="badge" style="color:${tone(five)}"><i></i>5h ${five}%</span>
    </div>
  </div>`;
}

function account({ email, tier, groups, models, pinned }) {
  return `<div class="card">
    <div class="top">
      <span class="dot" style="background:${tone(71)}"></span>
      <div class="who"><b>${email}</b><span>${tier}${pinned ? ' · pinned' : ''}</span></div>
      ${pinned ? '' : '<button class="mini">pin</button>'}
    </div>
    ${groups.map((g) => group(g.name, g.weekly, g.five, g.reset || 'in 6d 22h')).join('')}
    <div class="rows">${models
      .map(
        (m) =>
          `<div class="row"><span class="nm">${m.id}</span><span class="pct">${m.pct}%</span><span class="nm" style="flex:0 0 auto;opacity:.5">${m.reset}</span></div>`
      )
      .join('')}</div>
  </div>`;
}

const chain = 'bezmezhau › geohideeu › geohide › magicdns › direct';
const channels = ['bezmezhau', 'geohideeu', 'geohide', 'magicdns'];

const dnsPanel = `<div class="sub">
  <div class="subhead">выход dns</div>
  <div class="chips">
    <button class="chip-btn${variant === 'dns' ? ' on' : ''}">наша цепочка</button>
    ${channels.map((name) => `<button class="chip-btn">${name}</button>`).join('')}
  </div>
  <input class="input" placeholder="свой DNS: 1.2.3.4, 5.6.7.8">
  <div class="foot"><button class="btn wide" disabled>сохранить свой DNS</button></div>
  <div class="hint">адреса пишутся в ~/.dsh/ag-egress.json и переживают перезапуск</div>
</div>`;

const proxyPanel = `<div class="sub">
  <div class="subhead">выход через прокси</div>
  <input class="input" value="socks5://someone:secret@10.0.0.7:1080">
  <div class="parsed ok">понял как: socks5 · 10.0.0.7:1080 · с логином</div>
  <input class="input" placeholder="запасной прокси — необязательно">
  <div class="parsed ok">туннель открылся за 214 мс</div>
  <div class="foot">
    <button class="btn">проверить</button>
    <button class="btn wide">сохранить и включить</button>
    <button class="btn">убрать</button>
  </div>
  <div class="hint">адрес пишется в ~/.dsh/ag-egress.json; «проверить» ничего не меняет</div>
</div>`;

const stateLine =
  variant === 'dns'
    ? `<em>${chain}</em>`
    : `<em>режим dns — прокси включится после сохранения</em>`;

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>quota-overlay preview · ${variant}</title>
<style>
  html,body{margin:0;background:
    radial-gradient(90% 70% at 75% 6%,#1b1b2b,transparent 62%),
    radial-gradient(70% 60% at 8% 96%,#101a22,transparent 60%),#07070b;}
  body{padding:18px;font-family:ui-sans-serif,system-ui;display:inline-block}
  .agq{position:relative}
${styles}
  /* after the real stylesheet, so these win: the panel scrolls in the app, a docs shot shows it whole */
  .agq .panel{max-height:none}
  .agq .panel-in{max-height:none}
  .agq .scroll{max-height:none;overflow:visible;mask-image:none;flex:none}
  .agq .foot{position:static}
  /* a screenshot is one frame: settle everything instead of catching the entrance */
  .agq, .agq *{animation:none !important;transition:none !important;opacity:1 !important}
</style></head>
<body>
<div class="agq">
  <div class="panel"><div class="panel-in">
    <div class="head">
      <span class="mark">A</span><h1>Antigravity</h1><span class="chip">Google AI Pro</span>
      <button class="icon">⟳</button>
    </div>
    <div class="scroll">
      <div class="seg"><span class="thumb" style="left:calc(3px + ${variant === 'dns' ? 0 : 1} * ((100% - 6px) / 4))"></span>
        <button class="${variant === 'dns' ? 'on' : ''}">DNS</button>
        <button class="${variant === 'proxy' ? 'on' : ''}">Proxy</button>
        <button>VPN</button>
        <button>Direct</button>
      </div>
      <div class="state"><span class="dot" style="background:var(--good);box-shadow:0 0 8px var(--good)"></span>${stateLine}</div>
      ${variant === 'dns' ? dnsPanel : proxyPanel}
      <div class="relay">
        <div class="txt"><b>Relay</b><span>${variant === 'dns' ? 'DNS' : 'Proxy'} · 132 ok · 0 fail</span></div>
        <button class="switch on"><i></i></button>
      </div>
      <div class="sect">accounts</div>
      ${account({
        email: 'someone@example.com',
        tier: 'Google AI Pro · session',
        pinned: true,
        groups: [{ name: 'Gemini Models', weekly: 71, five: 99, reset: 'in 6d 22h' }],
        models: [{ id: 'gemini-3.8-flash-tiered', pct: 99, reset: 'in 3h 44m' }]
      })}
    </div>
    <div class="foot">
      <button class="btn wide">+ аккаунт</button>
      <button class="btn">маршрут</button>
      <button class="btn">скрыть</button>
    </div>
  </div></div>
</div>
</body></html>`;

const out = path.join(here, `preview-${variant}.html`);
fs.writeFileSync(out, html);
console.log('written:', out, `(${html.length} bytes)`);