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
if (!['dns', 'proxy', 'pill'].includes(variant)) {
  console.error('usage: node preview/build-preview.mjs dns|proxy|pill');
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

function ring(pct, size = 46, bare = false, thin = false) {
  const stroke = thin ? 2 : 3;
  const radius = size / 2 - stroke / 2 - 1.5;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="${stroke}"/>
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${tone(pct)}" stroke-width="${stroke}" stroke-linecap="round"
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

function account({ email, tier, groups, models, pinned, latency, when, requests }) {
  return `<div class="card">
    <div class="top">
      <span class="dot" style="background:${tone(71)}"></span>
      <div class="who"><span class="mail"><b>${email}</b><button class="del" aria-label="удалить"><svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M1.6 1.6 8.4 8.4M8.4 1.6 1.6 8.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></span><span>${tier}${pinned ? ' · pinned' : ''}</span></div>
      ${pinned ? '<span class="here">этот</span>' : '<button class="mini">переключить</button>'}
    </div>
    <div class="lat"><span>ответ</span><b>${latency || '—'}</b><span class="when">${when || 'нет замера'}</span><span class="req">${requests || ''}</span><button class="mini">проверить</button></div>
    ${groups.map((g) => group(g.name, g.weekly, g.five, g.reset || 'in 6d 22h')).join('')}
    <div class="rows">${models
      .map(
        (m) =>
          `<div class="row"><span class="nm">${m.id}</span><span class="pct">${m.pct}%</span><span class="nm" style="flex:0 0 auto;opacity:.5">${m.reset}</span></div>`
      )
      .join('')}</div>
  </div>`;
}

const pillMarkup = (pct, toneColor, routeLabel = 'DNS') =>
  '<div class="pill">' +
  ring(pct, 26, true, true) +
  '<span class="txt"><b>' + pct + '%</b><span class="cap"><i class="st" style="background:' + toneColor +
  '"></i>сброс 6д</span></span>' +
  '<span class="route"><i class="st" style="background:var(--good)"></i>' + routeLabel + '</span>' +
  '</div>';

const chain = 'bezmezhau › geohideeu › geohide › magicdns › direct';
const channels = ['bezmezhau', 'geohideeu', 'geohide', 'magicdns'];
const searchModels = [
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-3.8-flash-tiered',
];

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

const searchPanel = `<div class="sub">
  <div class="subhead">web-search модель</div>
  <div class="chips" style="margin-bottom:0">
    <button class="chip-btn${variant === 'dns' ? ' on' : ''}">auto</button>
    ${searchModels
      .map((id) => {
        const active = variant === 'proxy' && id === 'gemini-2.5-flash-lite';
        return `<button class="chip-btn${active ? ' on' : ''}">${id.replace(/^gemini-/, '')}</button>`;
      })
      .join('')}
  </div>
  <div class="hint">${
    variant === 'dns'
      ? 'сейчас: gemini-3.5-flash-lite · авто из каталога'
      : 'сейчас: gemini-2.5-flash-lite · выбрана вручную'
  }</div>
</div>`;

const stateLine =
  variant === 'dns'
    ? `<em>${chain}</em>`
    : `<em>режим dns — прокси включится после сохранения</em>`;

if (variant === 'pill') {
  const page = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>pill</title><style>',
    'html,body{margin:0;background:#fff}',
    'body{padding:14px;display:inline-block}',
    styles,
    '.agq{--good:#ffffff;--warn:#d4d4d8;--bad:#71717a}',
    '.agq *{animation:none !important;transition:none !important;opacity:1 !important}',
    '.row{display:flex;gap:10px;align-items:center}',
    '</style></head><body><div class="agq"><div class="row">',
    pillMarkup(100, 'var(--good)', 'DNS') + pillMarkup(71, 'var(--good)', 'PROXY') + pillMarkup(12, 'var(--warn)', 'DIRECT'),
    '</div></div></body></html>',
  ].join('\n');
  const out = path.join(here, 'preview-pill.html');
  fs.writeFileSync(out, page);
  console.log('written:', out);
  process.exit(0);
}

const modeTag = variant === 'dns' ? '01 · DNS + AUTO SEARCH' : '02 · PROXY + MANUAL MODEL';

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>quota-overlay preview · ${variant}</title>
<style>
  html,body{margin:0;width:448px;height:1138px;background:#ffffff;overflow:hidden}
  body{padding:20px 24px;box-sizing:border-box;font-family:ui-sans-serif,system-ui;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
    border:2px solid #0a0a0a;border-radius:18px}
  .top-bar{width:396px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .tag-blk{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;background:#0a0a0a;color:#fff;
    font-family:Consolas,'Cascadia Mono',monospace;font-size:10px;font-weight:700;letter-spacing:0.7px}
  .tag-blk i{width:5px;height:5px;border-radius:50%;background:#fff}
  .tag-wht{padding:4px 11px;border-radius:999px;background:#fff;color:#0a0a0a;border:1.5px solid #0a0a0a;box-shadow:2px 2px 0 #0a0a0a;
    font-family:Consolas,'Cascadia Mono',monospace;font-size:10px;font-weight:800;letter-spacing:0.5px}
  .agq{position:relative;display:flex;flex-direction:column;align-items:flex-end;width:396px}
${styles}
  /* after the real stylesheet, so these win: pure B&W manga contrast + full panel height */
  .agq{--good:#ffffff;--warn:#d4d4d8;--bad:#71717a}
  .agq .panel{max-height:none;width:396px;border:2px solid #0a0a0a;box-shadow:6px 6px 0 rgba(10,10,10,0.22)}
  .agq .panel-in{max-height:none}
  .agq .scroll{max-height:none;overflow:visible;mask-image:none;flex:none}
  .agq .foot{position:static}
  .agq .foot .btn{white-space:nowrap}
  .agq .pill{border:2px solid #0a0a0a;box-shadow:4px 4px 0 rgba(10,10,10,0.22)}
  /* a screenshot is one frame: settle everything instead of catching the entrance */
  .agq, .agq *{animation:none !important;transition:none !important;opacity:1 !important}
</style></head>
<body>
<div class="top-bar">
  <span class="tag-blk"><i></i>${modeTag}</span>
  <span class="tag-wht">127.0.0.1:8787</span>
</div>
<div class="agq">
  <div class="panel"><div class="panel-in">
    <div class="head">
      <span class="mark">A</span><div><h1>Antigravity</h1><small>1 акк. · Google AI Pro · маршрут и квоты</small></div>
      <button class="icon" aria-label="обновить"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M12.9 8a4.9 4.9 0 1 1-1.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.2 2.9v2.8H10.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="icon" aria-label="закрыть">×</button>
    </div>
    <div class="scroll">
      <div class="seg"><span class="thumb" style="left:calc(3px + ${variant === 'dns' ? 0 : 1} * ((100% - 6px) / 4))"></span>
        <button class="${variant === 'dns' ? 'on' : ''}">DNS</button>
        <button class="${variant === 'proxy' ? 'on' : ''}">Proxy</button>
        <button>VPN</button>
        <button>Direct</button>
      </div>
      <div class="state"><span class="dot" style="background:var(--good);box-shadow:0 0 6px rgba(255,255,255,0.6)"></span>${stateLine}</div>
      ${variant === 'dns' ? dnsPanel : proxyPanel}
      <div class="relay">
        <div class="txt"><b>Relay</b><span>${variant === 'dns' ? 'DNS' : 'Proxy'} · 132 ok · 0 fail</span></div>
        <button class="switch on"><i></i></button>
      </div>
      <div class="guard">
        <div class="txt"><b>сторож 5h</b><span>уводить запросы на другой аккаунт, когда пятичасовое ниже порога</span></div>
        <label class="num"><input value="5" readonly><span>%</span></label>
        <button class="switch on"><i></i></button>
      </div>
      ${searchPanel}
      <div class="sect">accounts</div>
      ${account({
        email: 'someone@example.com',
        tier: 'Google AI Pro · session',
        pinned: true,
        latency: '2.9 с',
        when: '2 мин назад',
        requests: '6 запр.',
        groups: [{ name: 'Gemini Models', weekly: 71, five: 99, reset: 'in 6d 22h' }],
        models: [
          { id: 'gemini-4-hydrogen-sonar', pct: 99, reset: 'in 3h 44m' },
          { id: 'gemini-3.8-flash-tiered', pct: 99, reset: 'in 3h 44m' },
        ],
      })}
    </div>
    <div class="foot">
      <button class="btn wide primary">+ аккаунт</button>
      <button class="btn">проверить маршрут</button>
    </div>
  </div></div>
  ${pillMarkup(71, 'var(--good)', variant === 'dns' ? 'DNS' : 'PROXY')}
</div>
</body></html>`;

const out = path.join(here, `preview-${variant}.html`);
fs.writeFileSync(out, html);
console.log('written:', out, `(${html.length} bytes)`);
