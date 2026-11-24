/**
 * Builds static previews of the redesigned 3-tab quota panel for docs and design review.
 *
 * The stylesheet is extracted directly from `plugins/quota-overlay/client.js`, so the
 * preview cannot drift from what the overlay actually renders.
 *
 *   node preview/build-preview.mjs accounts
 *   node preview/build-preview.mjs route
 *   node preview/build-preview.mjs settings
 *
 * Then screenshot `preview/preview-<variant>.html` (assets/panel-*.png are made this way).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const variant = (process.argv[2] || 'accounts').toLowerCase();
if (!['accounts', 'route', 'settings', 'pill'].includes(variant)) {
  console.error('usage: node preview/build-preview.mjs accounts|route|settings|pill');
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

function ring(pct, size = 26) {
  const stroke = 2.2;
  const radius = size / 2 - stroke / 2 - 1.5;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  return `<div class="ring" style="position:relative;width:${size}px;height:${size}px;flex:0 0 auto"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;transform:rotate(-90deg)">
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="${stroke}"/>
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${tone(pct)}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
  </svg></div>`;
}

const pillMarkup = (pct, toneColor, routeLabel = 'DNS') =>
  '<div class="pill">' +
  ring(pct, 26) +
  '<span class="txt"><b>' + pct + '%</b><span class="cap"><i class="st" style="background:' + toneColor +
  '"></i>сброс 6д</span></span>' +
  '<span class="route"><i class="st" style="background:var(--good)"></i>' + routeLabel + '</span>' +
  '</div>';

if (variant === 'pill') {
  const page = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>pill</title><style>',
    'html,body{margin:0;background:#fff}',
    'body{padding:14px;display:inline-block}',
    styles,
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

function qbox(name, fivePct, fiveReset, weekPct) {
  return `<div class="qbox">
    <div class="qbox-h"><b>${name}</b><span>5ч ${fiveReset}</span></div>
    <div class="qbox-v"><strong style="color:${tone(fivePct)}">${fivePct}%</strong><span>нед ${weekPct}%</span></div>
    <div class="bar"><i style="width:${fivePct}%;background:${tone(fivePct)}"></i></div>
  </div>`;
}

function accountCard({ email, meta, pinned, latency, when, requests, groups, models, expanded }) {
  return `<div class="acard${pinned ? ' pinned' : ''}">
    <div class="acard-top">
      <span class="dot" style="background:var(--good)"></span>
      <div class="acard-who">
        <div class="acard-mail"><b>${email}</b></div>
        <div class="acard-meta">${meta}</div>
      </div>
      <div class="acard-acts">
        <button class="pill-btn${pinned ? ' on' : ''}">${pinned ? 'пин' : 'выбрать'}</button>
        <button class="pill-btn">тест</button>
        ${pinned ? '' : '<button class="pill-btn">выкл</button><button class="pill-btn danger">×</button>'}
      </div>
    </div>
    <div class="qgrid">${groups.map((g) => qbox(g.name, g.five, g.reset, g.weekly)).join('')}</div>
    <div class="acard-foot">
      <div class="lat"><span>ответ:</span><b>${latency}</b><span>· ${when}</span>${requests ? `<span>· ${requests}</span>` : ''}</div>
      <button class="pill-btn">модели (${models.length}) ${expanded ? '▴' : '▾'}</button>
    </div>
    ${
      expanded
        ? `<div class="models-grid">${models
            .map((m) => `<div class="mrow"><span>${m.id}</span><b style="color:${tone(m.pct)}">${m.pct}%</b></div>`)
            .join('')}</div>`
        : ''
    }
  </div>`;
}

const accountsView = `<div class="view">
  <div class="bar-info"><span>Ротация: <b>авто (5%)</b></span><button class="pill-btn">сбросить пин</button></div>
  ${accountCard({
    email: 'someone@example.com',
    meta: 'Google AI Pro · session',
    pinned: true,
    latency: '2.4 с',
    when: 'только что',
    requests: '6 запр.',
    groups: [
      { name: 'Gemini', five: 99, reset: '3ч 44м', weekly: 71 },
      { name: 'Claude and GPT', five: 100, reset: '4ч 12м', weekly: 100 },
    ],
    models: [
      { id: 'gemini-4-hydrogen-sonar', pct: 99 },
      { id: 'gemini-4-neon-high', pct: 99 },
      { id: 'gemini-4-carbon-high', pct: 99 },
      { id: 'gemini-3.8-flash-tiered', pct: 99 },
      { id: 'claude-opus-5-5-high', pct: 100 },
      { id: 'claude-sonnet-5-5-high', pct: 100 },
    ],
    expanded: true,
  })}
  ${accountCard({
    email: 'backup@example.com',
    meta: 'Google AI Pro',
    pinned: false,
    latency: '3.1 с',
    when: '5 мин назад',
    requests: '',
    groups: [
      { name: 'Gemini', five: 100, reset: '4ч 50м', weekly: 100 },
      { name: 'Claude and GPT', five: 100, reset: '4ч 50м', weekly: 100 },
    ],
    models: [
      { id: 'gemini-4-hydrogen-sonar', pct: 100 },
      { id: 'gemini-3.8-flash-tiered', pct: 100 },
      { id: 'claude-opus-4-6-thinking', pct: 100 },
      { id: 'claude-sonnet-4-6', pct: 100 },
    ],
    expanded: false,
  })}
</div>`;

const channels = [
  { name: 'bezmezhau', ms: 42, on: true },
  { name: 'geohideeu', ms: 68, on: false },
  { name: 'geohide', ms: 91, on: false },
  { name: 'magicdns', ms: 114, on: false },
];

const routeView = `<div class="view">
  <div class="seg">
    <span class="thumb" style="left:3px"></span>
    <button class="on">DNS</button>
    <button>Proxy</button>
    <button>VPN</button>
    <button>Direct</button>
  </div>
  <div class="state"><span class="dot" style="background:var(--good)"></span><em>bezmezhau › geohideeu › geohide › magicdns › direct</em></div>
  <div class="relay">
    <div class="txt"><b>Relay-маршрутизация</b><span>DNS · 132 ok · 0 fail</span></div>
    <button class="switch on"><i></i></button>
  </div>
  <div class="sub">
    <div class="sub-h"><span class="subhead">Smart-DNS каналы</span></div>
    <div class="chips">
      ${channels.map((c) => `<button class="chip-btn${c.on ? ' on' : ''}">${c.name}<small>${c.ms}ms</small></button>`).join('')}
    </div>
    <input class="input" placeholder="свой DNS: 1.2.3.4, 5.6.7.8">
    <div class="btn-row"><button class="btn primary" disabled>сохранить свой DNS</button></div>
  </div>
  <div class="sub">
    <div class="sub-h"><span class="subhead">Диагностика каналов</span><span class="hint">сторож: 1 мин назад</span></div>
    <div class="btn-row">
      <button class="btn">замерить каналы</button>
      <button class="btn">проверить сторожа</button>
    </div>
    <div class="bench-list">
      <div class="bench-row"><b>bezmezhau</b><span style="color:var(--good)">42 мс</span></div>
      <div class="bench-row"><b>geohideeu</b><span style="color:var(--good)">68 мс</span></div>
      <div class="bench-row"><b>geohide</b><span style="color:var(--good)">91 мс</span></div>
    </div>
  </div>
</div>`;

const searchModels = [
  { id: 'gemini-3.5-flash-lite', label: '3.5-flash-lite' },
  { id: 'gemini-2.5-flash-lite', label: '2.5-flash-lite' },
  { id: 'gemini-3.1-flash-lite', label: '3.1-flash-lite' },
  { id: 'gemini-2.5-flash', label: '2.5-flash' },
  { id: 'gemini-3-flash', label: '3-flash' },
  { id: 'gemini-3.8-flash-tiered', label: '3.8-flash-tiered' },
  { id: 'gemini-4-hydrogen-sonar', label: '4-hydrogen', wide: true },
  { id: 'gemini-4-neon', label: '4-neon', on: true },
  { id: 'gemini-4-carbon', label: '4-carbon' },
];

const settingsView = `<div class="view">
  <div class="sub">
    <div class="sub-h"><span class="subhead">web-search модель</span><span class="hint">вручную</span></div>
    <div class="models-pick">
      <button class="chip-btn wide">auto (3.5-flash-lite)</button>
      ${searchModels
        .map((m) => `<button class="chip-btn${m.wide ? ' wide' : ''}${m.on ? ' on' : ''}">${m.label}</button>`)
        .join('')}
    </div>
    <div class="hint">Сейчас для Google Search grounding используется: gemini-4-neon</div>
  </div>
  <div class="guard">
    <div class="txt"><b>сторож 5h</b><span>уводить запросы на другой аккаунт, когда пятичасовое окно ниже порога</span></div>
    <label class="num"><input value="5" readonly><span>%</span></label>
    <button class="switch on"><i></i></button>
  </div>
  <div class="sub">
    <div class="subhead">состояние сервисов</div>
    <div class="bench-list">
      <div class="bench-row"><b>Bridge · 127.0.0.1:8787</b><span style="color:var(--good)">работает</span></div>
      <div class="bench-row"><b>Egress · 127.0.0.1:8789</b><span style="color:var(--good)">работает</span></div>
      <div class="bench-row"><b>Закреплённый аккаунт</b><span>someone@example.com</span></div>
    </div>
  </div>
</div>`;

const tabIndex = variant === 'accounts' ? 0 : variant === 'route' ? 1 : 2;
const modeTag =
  variant === 'accounts'
    ? '01 · ACCOUNTS & QUOTAS'
    : variant === 'route'
      ? '02 · ROUTE & EGRESS'
      : '03 · SEARCH & GUARD';
const bodyView = variant === 'accounts' ? accountsView : variant === 'route' ? routeView : settingsView;

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>quota-overlay preview · ${variant}</title>
<style>
  html,body{margin:0;width:480px;height:860px;background:#0d1117;overflow:hidden}
  .frame{width:480px;height:860px;padding:18px 24px;box-sizing:border-box;font-family:ui-sans-serif,system-ui;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
    background:#ffffff;border:2px solid #0a0a0a;border-radius:18px;overflow:hidden}
  .top-bar{width:432px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex:none}
  .tag-blk{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;background:#0a0a0a;color:#fff;
    font-family:Consolas,'Cascadia Mono',monospace;font-size:10px;font-weight:700;letter-spacing:0.7px}
  .tag-blk i{width:5px;height:5px;border-radius:50%;background:#fff}
  .tag-wht{padding:4px 11px;border-radius:999px;background:#fff;color:#0a0a0a;border:1.5px solid #0a0a0a;box-shadow:2px 2px 0 #0a0a0a;
    font-family:Consolas,'Cascadia Mono',monospace;font-size:10px;font-weight:800;letter-spacing:0.5px}
  .agq{position:relative;display:flex;flex-direction:column;align-items:flex-end;width:432px;flex:1;min-height:0}
${styles}
  .agq .panel{width:432px;height:734px;max-height:none;border:2px solid #0a0a0a;box-shadow:6px 6px 0 rgba(10,10,10,0.22);margin-bottom:10px}
  .agq .panel-in{max-height:none;height:100%}
  .agq .scroll{overflow:hidden}
  .agq .pill{border:2px solid #0a0a0a;box-shadow:4px 4px 0 rgba(10,10,10,0.22)}
  .agq, .agq *{animation:none !important;transition:none !important;opacity:1 !important}
  .agq .btn:disabled{opacity:.42 !important}
</style></head>
<body>
<div class="frame">
<div class="top-bar">
  <span class="tag-blk"><i></i>${modeTag}</span>
  <span class="tag-wht">127.0.0.1:8787</span>
</div>
<div class="agq">
  <div class="panel"><div class="panel-in">
    <div class="head">
      <span class="mark">A</span>
      <div class="head-t"><h1>Antigravity</h1><small>2 акк. · Google AI Pro · только что</small></div>
      <button class="icon" aria-label="обновить"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M12.9 8a4.9 4.9 0 1 1-1.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.2 2.9v2.8H10.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="icon" aria-label="закрыть">×</button>
    </div>
    <div class="summary">
      <button class="sum-card">
        <div class="sum-top"><span class="dot" style="background:var(--good)"></span><span>Закреплён</span></div>
        <div class="sum-main">someone</div>
        <div class="sum-sub">5ч 99% · нед 71%</div>
      </button>
      <button class="sum-card">
        <div class="sum-top"><span class="dot" style="background:var(--good)"></span><span>Маршрут</span></div>
        <div class="sum-main">DNS · bezmezhau</div>
        <div class="sum-sub">132 ok · 0 fail</div>
      </button>
    </div>
    <div class="tabs" role="tablist">
      <span class="tab-pill" style="left:calc(3px + ${tabIndex} * ((100% - 6px) / 3))"></span>
      <button role="tab" aria-selected="${variant === 'accounts'}">Аккаунты<sup>2</sup></button>
      <button role="tab" aria-selected="${variant === 'route'}"><span class="tdot" style="background:var(--good)"></span>Маршрут</button>
      <button role="tab" aria-selected="${variant === 'settings'}">Настройки</button>
    </div>
    <div class="scroll">${bodyView}</div>
    <div class="foot">
      <button class="btn primary">+ аккаунт</button>
      <button class="btn">тест маршрута</button>
    </div>
  </div></div>
  ${pillMarkup(71, 'var(--good)', 'DNS')}
</div>
</div>
</body></html>`;

const out = path.join(here, `preview-${variant}.html`);
fs.writeFileSync(out, html);
console.log('written:', out, `(${html.length} bytes)`);
