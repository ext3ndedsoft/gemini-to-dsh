/**
 * Builds a static preview of the quota panel for design review.
 *
 * The stylesheet is extracted from `client.js` so the preview cannot drift from what the
 * overlay actually renders; only the markup is mirrored here. Open the result in a browser
 * (or screenshot it headlessly) to check spacing, contrast and the weekly rings.
 *
 *   node preview/build-preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function group(name, weekly, five) {
  return `<div class="grp">${ring(weekly)}
    <div class="meta"><b>${name}</b>
      <span>weekly resets in 6d 22h</span>
      <span class="badge" style="color:${tone(five)}"><i></i>5h ${five}%</span>
    </div>
  </div>`;
}

function account({ email, tier, groups, models, pinned }) {
  return `<div class="card" style="animation-delay:0ms">
    <div class="top">
      <span class="dot" style="background:${tone(71)}"></span>
      <div class="who"><b>${email}</b><span>${tier}${pinned ? ' · pinned' : ''}</span></div>
      ${pinned ? '' : '<button class="mini">pin</button>'}
    </div>
    ${groups
      .map((g) => group(g.name, g.weekly, g.five))
      .join('')}
    <div class="rows">${models
      .map(
        (m) =>
          `<div class="row"><span class="nm">${m.id}</span><span class="pct">${m.pct}%</span><span class="nm" style="flex:0 0 auto;opacity:.5">${m.reset}</span></div>`
      )
      .join('')}</div>
  </div>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ag-limits preview</title>
<style>
  html,body{margin:0;height:100%;background:
    radial-gradient(80% 60% at 70% 10%,#191926,transparent 60%),
    radial-gradient(60% 50% at 10% 90%,#121a20,transparent 60%),#08080c;}
  body{display:grid;place-items:end end;padding:40px;font-family:ui-sans-serif,system-ui}
${styles}
</style></head>
<body>
<div class="agq" style="position:fixed;right:14px;bottom:14px;display:flex;flex-direction:column;align-items:flex-end">
  <div class="panel"><div class="panel-in">
    <div class="head">
      <span class="mark">A</span><h1>Antigravity</h1><span class="chip">AI Pro</span>
      <button class="icon">⟳</button>
    </div>
    <div class="scroll">
    <div class="seg"><span class="thumb" style="left:calc(3px + 1 * ((100% - 6px) / 4))"></span><button>DNS</button><button class="on">Proxy</button><button>VPN</button><button>Direct</button></div>
    <div class="state"><span class="dot" style="background:var(--good);box-shadow:0 0 8px var(--good)"></span>
      <em>dagami › bezmezhau › direct</em></div>
    <div class="relay">
      <div class="txt"><b>Relay</b><span>DNS · 132 ok · 0 fail</span></div>
      <button class="switch on"><i></i></button>
    </div>
    <div class="sect">accounts</div>
    ${account({
      email: 'someone@example.com',
      tier: 'AI Pro · session',
      groups: [
        { name: 'Gemini Models', weekly: 71, five: 99 },
        { name: 'Claude and GPT models', weekly: 96, five: 100 }
      ],
      models: [
        { id: 'gemini-3.8-flash-tiered', pct: 99, reset: 'in 3h 44m' },
        { id: 'claude-opus-4-6-thinking', pct: 100, reset: 'in 7d' },
        { id: 'gemini-3-flash', pct: 88, reset: 'in 5h 10m' }
      ]
    })}
    ${account({
      email: 'second@example.com',
      tier: 'AI Pro',
      pinned: true,
      groups: [{ name: 'Gemini Models', weekly: 98, five: 100 }],
      models: [{ id: 'gemini-3.8-flash-tiered', pct: 100, reset: 'in 6d' }]
    })}
    </div>
    <div class="foot">
      <button class="btn wide">add account</button>
      <button class="btn">test route</button>
      <button class="btn">hide</button>
    </div>
  </div></div>
  <div class="pill">${ring(71, 34, true)}<span><b>71%</b><span class="sub">weekly</span></span></div>
</div>
</body></html>`;

const out = path.join(here, 'preview.html');
fs.writeFileSync(out, html);
console.log('written:', out, `(${html.length} bytes)`);