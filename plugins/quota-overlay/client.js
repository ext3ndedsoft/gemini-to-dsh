window.__ModuleLoader__.load({
	id: "dsh-plugin-ag-limits",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const BRIDGE = "http://127.0.0.1:8787";
		const EGRESS = "http://127.0.0.1:8789";
		const QUOTA_MS = 30000;
		const PILL_MS = 180000;
		const EGRESS_MS = 8000;
		const OPEN_KEY = "ag-limits:open";
		const MODE_KEY = "ag-limits:mode";
		const TAB_KEY = "ag-limits:tab";

		/* ---------------------------------------------------------------- styles */

		const CSS = `
.agq{--bg:rgba(10,10,13,.95);--panel:rgba(12,12,15,.92);--card:rgba(255,255,255,.035);--card-hover:rgba(255,255,255,.055);
	--line:rgba(255,255,255,.085);--line-strong:rgba(255,255,255,.16);
	--text:#f2f2f5;--fg:#f2f2f5;--muted:#8e8e9a;--faint:#5c5c66;
	--good:#34d399;--warn:#fbbf24;--bad:#f87171;--ease:cubic-bezier(.22,1,.36,1);
	font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
.agq *{box-sizing:border-box}
@keyframes agq-panel-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@keyframes agq-panel-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(6px) scale(.99)}}
@keyframes agq-view-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes agq-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
	.agq *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
}
.agq button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.agq button:focus-visible,.agq .input:focus-visible{outline:1px solid rgba(255,255,255,.45);outline-offset:2px}

/* collapsed pill (38px tall) */
.agq .pill{display:flex;align-items:center;gap:8px;text-align:left;padding:5px 12px 5px 5px;border-radius:999px;cursor:pointer;
	background:rgba(0,0,0,.96);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.14);
	box-shadow:0 8px 24px rgba(0,0,0,.78);transition:transform .15s ease,border-color .15s ease}
.agq .pill:hover{transform:translateY(-1px);border-color:rgba(255,255,255,.26)}
.agq .pill:active{transform:scale(.97)}
.agq .pill b{display:block;font-size:14px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1;white-space:nowrap}
.agq .pill .cap{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--muted);line-height:1;margin-top:3px;white-space:nowrap}
.agq .pill .st{width:4px;height:4px;border-radius:50%;flex:0 0 auto}
.agq .pill .txt{display:block;text-align:left}
.agq .pill .route{display:flex;align-items:center;gap:5px;align-self:stretch;margin:5px 0 5px 2px;padding-left:10px;border-left:1px solid var(--line);font-size:9px;font-weight:650;letter-spacing:.09em;color:var(--muted);white-space:nowrap}
.agq .pill .route .st{width:5px;height:5px}

/* panel shell */
.agq .panel{display:flex;overflow:hidden;width:432px;max-width:calc(100vw - 28px);max-height:min(82vh,680px);margin-bottom:10px;
	border-radius:20px;border:1px solid var(--line-strong);background:var(--bg);backdrop-filter:blur(22px) saturate(1.2);
	box-shadow:0 28px 75px rgba(0,0,0,.78),inset 0 1px 0 rgba(255,255,255,.06);
	animation:agq-panel-in .2s var(--ease) both;transform-origin:bottom right}
.agq .panel.closing{animation:agq-panel-out .15s ease both;pointer-events:none}
.agq .panel-in{display:flex;flex-direction:column;min-height:0;flex:1;width:100%;max-height:min(82vh,680px)}

/* header */
.agq .head{display:flex;align-items:center;gap:10px;padding:13px 14px 10px;flex:none}
.agq .mark{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;font-size:13px;font-weight:750;flex:none;
	background:#f2f2f5;color:#0a0a0c;box-shadow:0 2px 8px rgba(255,255,255,.12)}
.agq .head-t{flex:1;min-width:0}
.agq .head h1{font-size:13.5px;font-weight:650;letter-spacing:-.01em;margin:0;line-height:1.2}
.agq .head small{display:block;font-size:10.5px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agq .icon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;padding:0;flex:none;
	color:var(--muted);font-size:16px;line-height:1;border:1px solid transparent;transition:color .15s,background .15s,border-color .15s,transform .12s}
.agq .icon:hover{color:var(--text);background:rgba(255,255,255,.07);border-color:var(--line)}
.agq .icon:active{transform:scale(.94)}
.agq .icon.is-busy svg{animation:agq-spin .85s linear infinite}
.agq .icon.is-busy{color:var(--text)}
.agq .icon[disabled]{opacity:.55;cursor:default}

/* summary strip (2 cards) */
.agq .summary{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:0 14px 10px;flex:none}
.agq .sum-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:12px;text-align:left;
	background:var(--card);border:1px solid var(--line);transition:border-color .15s,background .15s}
.agq .sum-card:hover{background:var(--card-hover);border-color:var(--line-strong)}
.agq .sum-top{display:flex;align-items:center;gap:5px;font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.agq .sum-top .dot{width:5px;height:5px;border-radius:50%;flex:none}
.agq .sum-main{font-size:11.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agq .sum-sub{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* 3-tab switcher */
.agq .tabs{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:2px;margin:0 14px 8px;padding:3px;
	border-radius:11px;background:rgba(255,255,255,.04);border:1px solid var(--line);flex:none}
.agq .tabs .tab-pill{position:absolute;top:3px;bottom:3px;width:calc((100% - 6px) / 3);border-radius:8px;pointer-events:none;
	background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.15);
	transition:left .24s var(--ease)}
.agq .tabs button{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:5px;
	padding:6px 4px;border-radius:8px;font-size:11.5px;font-weight:500;color:var(--muted);transition:color .15s}
.agq .tabs button:hover{color:var(--text)}
.agq .tabs button[aria-selected="true"]{color:var(--text);font-weight:600}
.agq .tabs sup{font-size:9.5px;color:var(--muted);font-variant-numeric:tabular-nums;top:0}
.agq .tabs .tdot{width:5px;height:5px;border-radius:50%}

/* scroll area */
.agq .scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:2px 14px 12px;
	scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
.agq .scroll::-webkit-scrollbar{width:5px}
.agq .scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:99px}
.agq .view{display:flex;flex-direction:column;gap:8px;animation:agq-view-in .2s var(--ease) both}

/* toolbar inside Accounts */
.agq .bar-info{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:11px;
	background:rgba(255,255,255,.025);border:1px solid var(--line);font-size:10.5px;color:var(--muted)}
.agq .bar-info b{color:var(--text);font-weight:600}

/* compact account card */
.agq .acard{border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--card);
	transition:border-color .16s,opacity .16s}
.agq .acard:hover{border-color:rgba(255,255,255,.16)}
.agq .acard.pinned{border-color:rgba(52,211,153,.35);background:linear-gradient(180deg,rgba(52,211,153,.045),transparent 52px),var(--card)}
.agq .acard.disabled{opacity:.55}
.agq .acard-top{display:flex;align-items:center;gap:7px}
.agq .acard-who{flex:1;min-width:0}
.agq .acard-mail{display:flex;align-items:center;gap:5px;min-width:0}
.agq .acard-mail b{font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agq .acard-meta{font-size:10px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agq .acard-acts{display:flex;align-items:center;gap:4px;flex:none}

.agq .pill-btn{font-size:10px;font-weight:500;color:var(--muted);border:1px solid var(--line);border-radius:7px;padding:3px 7px;
	transition:color .14s,border-color .14s,background .14s;white-space:nowrap}
.agq .pill-btn:hover:not(:disabled){color:var(--text);border-color:rgba(255,255,255,.24);background:rgba(255,255,255,.06)}
.agq .pill-btn.on{color:#052e16;background:var(--good);border-color:transparent;font-weight:650}
.agq .pill-btn.danger:hover,.agq .pill-btn.ask{color:#fecaca;border-color:rgba(248,113,113,.5);background:rgba(248,113,113,.15)}
.agq .pill-btn:disabled{opacity:.45;cursor:default}

/* 2-col group quota bars */
.agq .qgrid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}
.agq .qbox{padding:7px 8px;border-radius:9px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.055)}
.agq .qbox-h{display:flex;align-items:center;justify-content:space-between;gap:4px;font-size:10px;color:var(--muted)}
.agq .qbox-h b{color:var(--text);font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agq .qbox-v{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-top:4px;font-variant-numeric:tabular-nums}
.agq .qbox-v strong{font-size:12px;font-weight:650}
.agq .qbox-v span{font-size:9.5px;color:var(--muted)}
.agq .bar{height:3.5px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:5px}
.agq .bar i{display:block;height:100%;border-radius:99px;transition:width .4s var(--ease)}

.agq .acard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;font-size:10px;color:var(--muted)}
.agq .acard-foot .lat{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;white-space:nowrap}
.agq .acard-foot .lat b{color:var(--text);font-variant-numeric:tabular-nums}
.agq .models-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:7px;padding-top:7px;border-top:1px solid var(--line)}
.agq .mrow{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10px;min-width:0}
.agq .mrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.agq .mrow b{font-variant-numeric:tabular-nums;font-weight:600;flex:none}

/* Route & settings cards */
.agq .seg{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:3px;border-radius:11px;
	background:rgba(255,255,255,.04);border:1px solid var(--line)}
.agq .seg .thumb{position:absolute;top:3px;bottom:3px;width:calc((100% - 6px) / 4);border-radius:8px;pointer-events:none;
	background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);transition:left .24s var(--ease)}
.agq .seg button{position:relative;z-index:1;padding:6px 0;border-radius:8px;font-size:11.5px;font-weight:500;color:var(--muted);transition:color .15s}
.agq .seg button:hover{color:var(--text)}
.agq .seg button.on{color:var(--text);font-weight:600}

.agq .state{display:flex;align-items:center;gap:7px;padding:2px 2px;font-size:11px;color:var(--muted)}
.agq .dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.agq .state em{font-style:normal;color:var(--text);opacity:.88;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.agq .sub{padding:11px 12px;border-radius:13px;border:1px solid var(--line);background:var(--card);display:flex;flex-direction:column;gap:8px}
.agq .sub-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
.agq .subhead{font-size:9.5px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.agq .chips{display:flex;flex-wrap:wrap;gap:5px}
.agq .chip-btn{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;padding:5px 9px;border-radius:8px;
	border:1px solid var(--line);color:var(--muted);background:rgba(255,255,255,.025);transition:all .14s}
.agq .chip-btn:hover:not(:disabled){color:var(--text);border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.06)}
.agq .chip-btn.on{color:var(--text);font-weight:600;border-color:rgba(255,255,255,.48);background:rgba(255,255,255,.11)}
.agq .chip-btn small{font-size:9.5px;color:var(--good);font-variant-numeric:tabular-nums}

.agq .models-pick{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.agq .models-pick .chip-btn{justify-content:space-between;width:100%}
.agq .models-pick .chip-btn.wide{grid-column:1 / -1;justify-content:center}

.agq .relay,.agq .guard{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:13px;
	background:var(--card);border:1px solid var(--line);transition:opacity .18s}
.agq .guard.off{opacity:.65}
.agq .relay .txt,.agq .guard .txt{flex:1;min-width:0}
.agq .relay .txt b,.agq .guard .txt b{display:block;font-size:11.5px;font-weight:600}
.agq .relay .txt span,.agq .guard .txt span{display:block;font-size:10px;color:var(--muted);margin-top:2px;line-height:1.35}
.agq .guard .num{display:flex;align-items:center;gap:3px;font-size:10.5px;color:var(--muted)}
.agq .guard .num input{width:34px;padding:3px 0;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--text);
	background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:7px;outline:none}
.agq .guard .num input:focus{border-color:rgba(255,255,255,.45)}
.agq .guard .num input:disabled{opacity:.45}

.agq .switch{width:36px;height:20px;border-radius:99px;position:relative;flex:0 0 auto;
	background:rgba(255,255,255,.09);border:1px solid var(--line);transition:background .18s,border-color .18s}
.agq .switch i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:99px;background:#787882;
	transition:left .18s var(--ease),background .18s}
.agq .switch.on{background:var(--good);border-color:var(--good)}
.agq .switch.on i{left:18px;background:#04140d}

.agq .input{width:100%;background:rgba(0,0,0,.32);border:1px solid var(--line);border-radius:9px;
	color:var(--text);font:inherit;font-size:11px;padding:7px 10px;outline:none;transition:border-color .15s}
.agq .input:focus{border-color:rgba(255,255,255,.42)}
.agq .input.bad{border-color:rgba(248,113,113,.55)}
.agq .parsed{font-size:10px;color:var(--muted);line-height:1.35}
.agq .parsed.ok{color:var(--good)}
.agq .parsed.bad{color:var(--bad)}
.agq .hint{font-size:10px;color:var(--muted);line-height:1.4}
.agq .err{font-size:10.5px;color:var(--bad);margin-top:6px;word-break:break-word}
.agq .empty{font-size:11px;color:var(--muted);padding:12px 4px;text-align:center}

.agq .bench-list{display:flex;flex-direction:column;gap:4px;margin-top:2px}
.agq .bench-row{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;padding:4px 8px;border-radius:7px;background:rgba(0,0,0,.22)}
.agq .bench-row b{font-weight:600}
.agq .bench-row span{font-variant-numeric:tabular-nums}

/* persistent status note & footer */
.agq .toast-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 14px 8px;padding:7px 10px;
	border-radius:10px;background:rgba(255,255,255,.06);border:1px solid var(--line-strong);font-size:10.5px;color:var(--text)}
.agq .toast-bar.ok{border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.09)}
.agq .toast-bar.bad{border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.1)}
.agq .toast-bar button{color:var(--muted);font-size:13px;line-height:1;padding:0 3px}
.agq .toast-bar button:hover{color:var(--text)}

.agq .btn-row{display:flex;gap:6px}
.agq .btn{flex:1;border:1px solid var(--line);border-radius:10px;padding:7px 10px;font-size:11px;font-weight:500;color:var(--muted);
	background:rgba(255,255,255,.03);white-space:nowrap;transition:background .15s,color .15s,border-color .15s}
.agq .btn:hover:not(:disabled){background:rgba(255,255,255,.08);color:var(--text);border-color:var(--line-strong)}
.agq .btn:disabled{opacity:.42;cursor:default}
.agq .btn.primary{background:#f2f2f5;color:#0a0a0c;border-color:transparent;font-weight:650}
.agq .btn.primary:hover:not(:disabled){background:#fff;color:#000}

.agq .foot{display:flex;gap:7px;flex:none;padding:10px 14px 12px;border-top:1px solid var(--line);background:rgba(0,0,0,.22)}
`;

		try {
			if (typeof document !== "undefined" && !document.getElementById("agq-css")) {
				const tag = document.createElement("style");
				tag.id = "agq-css";
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		} catch {}

		/* ---------------------------------------------------------------- helpers */

		const pctOf = (fraction) => Math.round((typeof fraction === "number" ? fraction : 0) * 100);
		const toneOf = (pct) => (pct > 50 ? "var(--good)" : pct > 20 ? "var(--warn)" : "var(--bad)");
		const clamp = (value) => Math.max(0, Math.min(100, value));
		const KEEP_MODEL = (id) => /^claude-/.test(id) || /^gemini-(?:3\.8|4)/.test(id);
		const searchModelLabel = (id) => (id === "gemini-4-hydrogen-sonar" ? "4-hydrogen" : String(id || "").replace(/^gemini-/, ""));

		function resetIn(iso) {
			if (!iso) return "";
			const at = typeof iso === "number" ? iso : Date.parse(iso);
			if (!Number.isFinite(at)) return "";
			const minutes = Math.round((at - Date.now()) / 60000);
			if (minutes <= 0) return "сейчас";
			if (minutes < 60) return minutes + "м";
			const hours = Math.floor(minutes / 60);
			if (hours < 48) return hours + "ч" + (minutes % 60 ? " " + (minutes % 60) + "м" : "");
			return Math.round(hours / 24) + "д";
		}

		function shortLeft(iso) {
			return resetIn(iso);
		}

		function fiveHourOf(account) {
			const groups = (account && account.groups) || [];
			const buckets = groups.flatMap((g) => g.fiveHour || []);
			if (buckets.length) return Math.min(...buckets.map((b) => pctOf(b.remaining)));
			return null;
		}

		function weeklyOf(account) {
			const groups = (account && account.groups) || [];
			const weekly = groups.flatMap((group) => (group.weekly || []).map((bucket) => ({ ...bucket, group: group.name })));
			if (!weekly.length) return null;
			return weekly.reduce((worst, bucket) => (pctOf(bucket.remaining) < pctOf(worst.remaining) ? bucket : worst), weekly[0]);
		}

		function worstOf(account) {
			const groups = (account && account.groups) || [];
			const buckets = groups.flatMap((group) => group.buckets || []);
			if (buckets.length) return Math.min(...buckets.map((bucket) => pctOf(bucket.remaining)));
			if (!account || !account.models) return null;
			let worst = null;
			for (const [id, value] of Object.entries(account.models)) {
				if (!KEEP_MODEL(id)) continue;
				const pct = pctOf(value.fraction);
				if (worst === null || pct < worst) worst = pct;
			}
			return worst;
		}

		async function getJson(url, options) {
			const res = await fetch(url, { cache: "no-store", ...options });
			const json = await res.json().catch(() => null);
			return { ok: res.ok, status: res.status, json };
		}

		function explainError(text) {
			const raw = String(text || "").trim();
			if (!raw) return "";
			if (/aborted due to timeout|operation was aborted/i.test(raw)) return "не ответил вовремя — попробую снова";
			if (/ECONNRESET|socket hang up|other side closed/i.test(raw)) return "соединение оборвалось";
			if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return "не нашёл адрес — проверь сеть";
			if (/ECONNREFUSED|127\.0\.0\.1|localhost/i.test(raw)) return "мост не отвечает";
			if (/\b401\b|unauthorized|invalid_grant/i.test(raw)) return "нужно войти заново";
			if (/\b429\b|rate limit|resource_exhausted/i.test(raw)) return "квота исчерпана, жду сброса";
			if (/\b403\b|permission|forbidden/i.test(raw)) return "доступ закрыт для этого аккаунта";
			return raw.length > 90 ? raw.slice(0, 87) + "…" : raw;
		}

		function agoOf(at) {
			if (!at) return "";
			const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
			if (sec < 45) return "только что";
			const min = Math.round(sec / 60);
			if (min < 60) return min + " мин назад";
			const hours = Math.round(min / 60);
			return hours + " ч назад";
		}

		/* ---------------------------------------------------------------- hooks */

		function useLimits(open = false) {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const seqRef = React.useRef(0);
			const abortRef = React.useRef(null);

			const load = React.useCallback(async (force) => {
				const seq = ++seqRef.current;
				try {
					abortRef.current?.abort();
				} catch {}
				const controller = new AbortController();
				abortRef.current = controller;
				setLoading(true);
				try {
					const res = await getJson(BRIDGE + "/limits" + (force ? "?force=1" : ""), {
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
					});
					if (seq !== seqRef.current) return;
					if (!res.ok) throw new Error("bridge " + res.status);
					setData(res.json);
					setError(null);
				} catch (err) {
					if (seq !== seqRef.current || (err && err.name === "AbortError")) return;
					setError(String((err && err.message) || err));
				} finally {
					if (seq === seqRef.current) setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				let alive = true;
				load(false);
				const timer = setInterval(() => {
					if (alive && typeof document !== "undefined" && document.visibilityState !== "hidden") load(false);
				}, open ? QUOTA_MS : PILL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
					try {
						abortRef.current?.abort();
					} catch {}
				};
			}, [load, open]);

			return { data, error, loading, load };
		}

		function useEgress() {
			const [state, setState] = React.useState(null);
			const [online, setOnline] = React.useState(true);

			const load = React.useCallback(async () => {
				try {
					const res = await getJson(EGRESS + "/", { signal: AbortSignal.timeout(EGRESS_MS) });
					setState(res.ok ? res.json : null);
					setOnline(Boolean(res.ok));
				} catch {
					setState(null);
					setOnline(false);
				}
			}, []);

			React.useEffect(() => {
				load();
				let source = null;
				try {
					source = new EventSource(EGRESS + "/events");
					source.onmessage = (event) => {
						try {
							setState(JSON.parse(event.data));
							setOnline(true);
						} catch {}
					};
					source.onerror = () => setOnline(false);
				} catch {}
				const timer = setInterval(() => {
					if (typeof document === "undefined" || document.visibilityState !== "hidden") load();
				}, 60000);
				return () => {
					clearInterval(timer);
					try {
						source?.close();
					} catch {}
				};
			}, [load]);

			return { state, online, reload: load, setState };
		}

		/* ---------------------------------------------------------------- atoms */

		function Ring({ pct, size = 26, bare = true }) {
			const stroke = 2.2;
			const radius = size / 2 - stroke / 2 - 1.5;
			const center = size / 2;
			const circumference = 2 * Math.PI * radius;
			const filled = (clamp(pct) / 100) * circumference;
			const color = toneOf(pct);
			return h(
				"div",
				{ className: "ring", style: { position: "relative", width: size, height: size, flex: "0 0 auto" } },
				h(
					"svg",
					{ width: size, height: size, viewBox: "0 0 " + size + " " + size, style: { display: "block", transform: "rotate(-90deg)" } },
					h("circle", { cx: center, cy: center, r: radius, fill: "none", stroke: "rgba(255,255,255,.1)", strokeWidth: stroke }),
					h("circle", {
						cx: center,
						cy: center,
						r: radius,
						fill: "none",
						stroke: color,
						strokeWidth: stroke,
						strokeLinecap: "round",
						strokeDasharray: circumference,
						strokeDashoffset: circumference - filled,
						style: { transition: "stroke-dashoffset .45s cubic-bezier(.3,.8,.4,1)" }
					})
				),
				bare ? null : h("b", null, pct + "%")
			);
		}

		function Segmented({ value, onChange }) {
			const options = [
				{ id: "dns", label: "DNS" },
				{ id: "proxy", label: "Proxy" },
				{ id: "vpn", label: "VPN" },
				{ id: "direct", label: "Direct" }
			];
			const index = Math.max(0, options.findIndex((o) => o.id === value));
			return h(
				"div",
				{ className: "seg", role: "tablist" },
				h("span", { className: "thumb", style: { left: "calc(3px + " + index + " * ((100% - 6px) / 4))" } }),
				options.map((o) =>
					h(
						"button",
						{
							key: o.id,
							role: "tab",
							"aria-selected": value === o.id,
							className: value === o.id ? "on" : "",
							onClick: () => onChange(o.id)
						},
						o.label
					)
				)
			);
		}

		function readProxy(value) {
			const raw = (value || "").trim();
			if (!raw) return { ok: false, error: "пусто" };
			const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : "http://" + raw;
			let url;
			try {
				url = new URL(withScheme);
			} catch {
				return { ok: false, error: "не похоже на адрес" };
			}
			const scheme = url.protocol.replace(":", "").toLowerCase();
			if (!["http", "https", "socks5", "socks5h", "socks"].includes(scheme)) {
				return { ok: false, error: "схема " + scheme + " не поддерживается" };
			}
			if (!url.hostname) return { ok: false, error: "нужен адрес хоста" };
			if (!url.port) return { ok: false, error: "нужен порт, например " + url.hostname + ":3128" };
			return {
				ok: true,
				href: withScheme,
				scheme,
				host: url.hostname,
				port: url.port,
				auth: Boolean(url.username),
				label: scheme + " · " + url.hostname + ":" + url.port + (url.username ? " · с логином" : " · без логина")
			};
		}

		/* ---------------------------------------------------------------- AccountCard */

		function AccountCard({ account, pinned, onSwitch, onToggleEnabled, onCheck, onRemove, onNotify, checking }) {
			const [confirming, setConfirming] = React.useState(false);
			const [removing, setRemoving] = React.useState(false);
			const [expanded, setExpanded] = React.useState(false);
			const confirmTimerRef = React.useRef(null);
			React.useEffect(() => () => {
				if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
			}, []);

			const askRemove = () => {
				if (account.native) {
					onNotify("аккаунт сессии удалить нельзя — это твой основной вход", "bad");
					return;
				}
				if (!confirming) {
					setConfirming(true);
					if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
					confirmTimerRef.current = setTimeout(() => setConfirming(false), 3500);
					return;
				}
				if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
				setRemoving(true);
				setConfirming(false);
				onRemove(account.id);
			};

			const enabled = account.enabled !== false;
			const groups = account.groups || [];
			const models = Object.entries(account.models || {}).sort((a, b) => {
				const ka = KEEP_MODEL(a[0]) ? 0 : 1;
				const kb = KEEP_MODEL(b[0]) ? 0 : 1;
				if (ka !== kb) return ka - kb;
				return a[1].fraction - b[1].fraction;
			});
			const worst = worstOf(account);
			const lat = account.latency;
			const dotColor = !enabled ? "var(--faint)" : account.ok && !account.limitedUntil ? toneOf(worst ?? 100) : "var(--bad)";

			return h(
				"div",
				{ className: "acard" + (pinned ? " pinned" : "") + (!enabled ? " disabled" : "") },
				h(
					"div",
					{ className: "acard-top" },
					h("span", { className: "dot", style: { background: dotColor } }),
					h(
						"div",
						{ className: "acard-who" },
						h("div", { className: "acard-mail" }, h("b", { title: account.email || account.id }, account.email || account.id)),
						h(
							"div",
							{ className: "acard-meta" },
							[
								account.tierName,
								account.native ? "session" : null,
								!enabled ? "выключен" : null,
								account.limitedUntil ? "лимит · сброс " + resetIn(account.limitedUntil) : null
							]
								.filter(Boolean)
								.join(" · ") || "account"
						)
					),
					h(
						"div",
						{ className: "acard-acts" },
						h(
							"button",
							{
								className: "pill-btn" + (pinned ? " on" : ""),
								disabled: !enabled,
								onClick: () => onSwitch(pinned ? null : account.id),
								title: pinned ? "снять закрепление (перейти в авто-режим)" : "закрепить этот аккаунт первым"
							},
							pinned ? "пин" : "выбрать"
						),
						h(
							"button",
							{
								className: "pill-btn",
								disabled: checking || !enabled,
								onClick: () => onCheck(account.id),
								title: "замерить задержку маленьким запросом"
							},
							checking ? "…" : "тест"
						),
						!account.native
							? h(
									"button",
									{
										className: "pill-btn",
										onClick: () => onToggleEnabled(account.id, !enabled),
										title: enabled ? "временно отключить аккаунт из ротации" : "включить аккаунт обратно"
									},
									enabled ? "выкл" : "вкл"
								)
							: null,
						!account.native
							? h(
									"button",
									{
										className: "pill-btn danger" + (confirming ? " ask" : ""),
										onClick: askRemove,
										disabled: removing,
										title: "удалить аккаунт"
									},
									removing ? "…" : confirming ? "точно?" : "×"
								)
							: null
					)
				),
				!account.ok
					? h("div", { className: "err" }, explainError(account.error) || "недоступен")
					: groups.length
						? h(
								"div",
								{ className: "qgrid" },
								groups.map((g, idx) => {
									const weekly = (g.weekly || [])[0];
									const five = (g.fiveHour || [])[0];
									const wPct = weekly ? pctOf(weekly.remaining) : null;
									const fPct = five ? pctOf(five.remaining) : null;
									const mainPct = fPct ?? wPct ?? 0;
									const shortName = g.name.replace(/\s+models$/i, "");
									return h(
										"div",
										{ className: "qbox", key: g.name + idx },
										h(
											"div",
											{ className: "qbox-h" },
											h("b", { title: g.description || g.name }, shortName),
											h("span", null, five && five.resetAt ? "5ч " + resetIn(five.resetAt) : weekly && weekly.resetAt ? "нед " + resetIn(weekly.resetAt) : "")
										),
										h(
											"div",
											{ className: "qbox-v" },
											h("strong", { style: { color: toneOf(mainPct) } }, (fPct !== null ? fPct : wPct) + "%"),
											h("span", null, wPct !== null && fPct !== null ? "нед " + wPct + "%" : wPct !== null ? "weekly" : "5h")
										),
										h("div", { className: "bar" }, h("i", { style: { width: clamp(mainPct) + "%", background: toneOf(mainPct) } }))
									);
								})
							)
						: h("div", { className: "hint", style: { marginTop: 6 } }, "данные квоты пока недоступны"),
				h(
					"div",
					{ className: "acard-foot" },
					h(
						"div",
						{ className: "lat" },
						h("span", null, "ответ:"),
						h("b", null, lat ? (lat.ms / 1000).toFixed(1) + " с" : "—"),
						lat ? h("span", null, "· " + agoOf(lat.at)) : null,
						account.requests ? h("span", null, "· " + account.requests + " запр.") : null
					),
					account.ok && models.length
						? h(
								"button",
								{ className: "pill-btn", onClick: () => setExpanded((v) => !v) },
								"модели (" + models.length + ") " + (expanded ? "▴" : "▾")
							)
						: null
				),
				expanded && models.length
					? h(
							"div",
							{ className: "models-grid" },
							models.map(([id, val]) =>
								h(
									"div",
									{ className: "mrow", key: id, title: id + " · сброс " + resetIn(val.resetTime) },
									h("span", null, id),
									h("b", { style: { color: toneOf(pctOf(val.fraction)) } }, pctOf(val.fraction) + "%")
								)
							)
						)
					: null
			);
		}

		/* ---------------------------------------------------------------- RouteView */

		function RouteView({ egress, busy, onMode, onToggle, onPatch, onNotify }) {
			const state = egress.state;
			const mode = (state && state.mode) || "dns";
			const info = (state && state.modeInfo) || { label: mode, detail: "", ready: false };
			const config = (state && state.config) || {};
			const providers = config.providers || {};
			const chain = (state && state.chain) || [];
			const stats = (state && state.stats) || null;
			const health = (state && state.health) || {};
			const watchdog = (state && state.watchdog) || null;
			const vpn = (state && state.vpn) || null;

			const channels = ((state && state.channels) || []).filter(
				(name) => name !== "proxy" && name !== "direct" && name !== "custom"
			);

			const [tab, setTab] = React.useState(null);
			React.useEffect(() => {
				setTab((prev) => (prev === "proxy" && mode !== "proxy" ? prev : mode));
			}, [mode]);
			const pick = (next) => {
				if (next === "proxy") {
					setTab("proxy");
					return;
				}
				setTab(next);
				onMode(next);
			};

			const [dnsDraft, setDnsDraft] = React.useState("");
			const [proxy, setProxy] = React.useState("");
			const [fallback, setFallback] = React.useState("");
			const [proxyCheck, setProxyCheck] = React.useState(null);
			const [bench, setBench] = React.useState(null);
			const [benching, setBenching] = React.useState(false);

			React.useEffect(() => {
				if (!dnsDraft && providers.custom && providers.custom.dns) setDnsDraft(providers.custom.dns.join(", "));
			}, [providers.custom]);
			React.useEffect(() => {
				const saved = config.proxy && !config.proxy.includes("•") ? config.proxy : "";
				if (!proxy && saved) setProxy(saved);
			}, [config.proxy]);
			React.useEffect(() => {
				if (!fallback && config.fallbackProxy) setFallback(config.fallbackProxy);
			}, [config.fallbackProxy]);

			const visibleMode = tab || mode;
			const pendingProxy = visibleMode === "proxy" && mode !== "proxy";
			const dotColor = !egress.online ? "var(--bad)" : info.ready ? "var(--good)" : "var(--warn)";
			const detail = !egress.online
				? "egress shim не отвечает (порт 8789)"
				: pendingProxy
					? "впиши адрес прокси и нажми «включить»"
					: mode === "proxy"
						? config.proxy || "адрес прокси не задан"
						: mode === "vpn"
							? vpn && vpn.connected
								? (vpn.name || "VPN поднят") + (vpn.kind ? " · " + vpn.kind : "")
								: "активный VPN-туннель не найден"
							: mode === "direct"
								? "прямой выход без релеев"
								: chain.join(" › ");

			const saveCustomDns = () => {
				const ips = dnsDraft
					.split(/[\s,]+/)
					.map((s) => s.trim())
					.filter(Boolean);
				if (!ips.length) return;
				onPatch(
					{
						providers: { custom: { dns: ips, seeds: ["cloudaicompanion.googleapis.com"] } },
						route: "custom",
						mode: "dns"
					},
					"свой DNS сохранён: " + ips.join(", ")
				);
			};

			const parsed = readProxy(proxy);
			const parsedFallback = fallback.trim() ? readProxy(fallback) : null;

			const runProxyCheck = async () => {
				if (!parsed.ok) return;
				setProxyCheck({ state: "running" });
				try {
					const res = await fetch(EGRESS + "/check?proxy=" + encodeURIComponent(parsed.href), {
						signal: AbortSignal.timeout(15000)
					});
					const json = await res.json();
					setProxyCheck(
						json.ok
							? { state: "ok", text: "туннель открылся за " + json.ms + " мс" }
							: { state: "bad", text: json.error || "не отвечает" }
					);
				} catch (err) {
					setProxyCheck({ state: "bad", text: err.message || "проверка не удалась" });
				}
			};

			const runBench = async () => {
				setBenching(true);
				try {
					const res = await getJson(EGRESS + "/bench?rounds=2", { signal: AbortSignal.timeout(25000) });
					if (res.ok && res.json && res.json.rows) setBench(res.json.rows);
					else onNotify("не удалось замерить каналы", "bad");
				} catch {
					onNotify("egress shim не отвечает", "bad");
				}
				setBenching(false);
			};

			const runWatchdog = async () => {
				try {
					const res = await getJson(EGRESS + "/watchdog", { signal: AbortSignal.timeout(15000) });
					if (res.ok) {
						onNotify("сторож: активный канал " + (res.json.route || "—"), "ok");
						egress.reload();
					} else {
						onNotify("ошибка проверки сторожа", "bad");
					}
				} catch {
					onNotify("egress shim не отвечает", "bad");
				}
			};

			const head = channels[0] || chain[0] || "";
			const activeRoute = config.route && config.route !== "direct" ? config.route : "";

			return h(
				"div",
				{ className: "view", key: "route" },
				h(Segmented, { value: visibleMode, onChange: pick }),
				h(
					"div",
					{ className: "state" },
					h("span", { className: "dot", style: { background: dotColor } }),
					h("em", { title: detail }, detail)
				),
				h(
					"div",
					{ className: "relay" },
					h(
						"div",
						{ className: "txt" },
						h("b", null, "Relay-маршрутизация"),
						h("span", null, info.label + " · " + (stats ? stats.proxied + " ok · " + stats.failed + " fail" : "нет статистики"))
					),
					h(
						"button",
						{
							className: "switch" + (mode === "direct" ? "" : " on"),
							role: "switch",
							"aria-checked": mode !== "direct",
							onClick: onToggle
						},
						h("i")
					)
				),
				visibleMode === "dns"
					? h(
							"div",
							{ className: "sub" },
							h("div", { className: "sub-h" }, h("span", { className: "subhead" }, "Smart-DNS каналы")),
							h(
								"div",
								{ className: "chips" },
								channels.map((name) => {
									const ms = health[name] && health[name].lastMs;
									return h(
										"button",
										{
											key: name,
											className: "chip-btn" + (activeRoute === name ? " on" : ""),
											onClick: () => onPatch({ mode: "dns", route: name }, "маршрут: " + name),
											title: ((providers[name] && providers[name].dns) || []).join(", ")
										},
										name,
										ms ? h("small", null, ms + "ms") : null
									);
								}),
								providers.custom
									? h(
											"button",
											{
												className: "chip-btn" + (activeRoute === "custom" ? " on" : ""),
												onClick: () => onPatch({ mode: "dns", route: "custom" }, "маршрут: свой DNS"),
												title: (providers.custom.dns || []).join(", ")
											},
											"свой",
											health.custom && health.custom.lastMs ? h("small", null, health.custom.lastMs + "ms") : null
										)
									: null
							),
							h("input", {
								className: "input",
								placeholder: "свой DNS: 1.2.3.4, 5.6.7.8",
								value: dnsDraft,
								onChange: (e) => setDnsDraft(e.target.value),
								onKeyDown: (e) => {
									if (e.key === "Enter") saveCustomDns();
								}
							}),
							h(
								"div",
								{ className: "btn-row" },
								h("button", { className: "btn primary", disabled: busy || !dnsDraft.trim(), onClick: saveCustomDns }, "сохранить свой DNS"),
								providers.custom
									? h(
											"button",
											{
												className: "btn",
												disabled: busy,
												onClick: () => {
													setDnsDraft("");
													onPatch({ route: head, providers: { custom: null } }, "свой DNS убран");
												}
											},
											"убрать"
										)
									: null
							)
						)
					: null,
				visibleMode === "proxy"
					? h(
							"div",
							{ className: "sub" },
							h("div", { className: "subhead" }, "выход через прокси"),
							h("input", {
								className: "input" + (proxy.trim() && !parsed.ok ? " bad" : ""),
								placeholder: "http://user:pass@host:port, socks5://host:port или host:port",
								value: proxy,
								spellCheck: false,
								onChange: (e) => {
									setProxy(e.target.value);
									setProxyCheck(null);
								},
								onKeyDown: (e) => {
									if (e.key === "Enter" && parsed.ok) onPatch({ mode: "proxy", proxy: parsed.href }, "прокси включён: " + parsed.label);
								}
							}),
							h(
								"div",
								{ className: "parsed " + (proxy.trim() ? (parsed.ok ? "ok" : "bad") : "") },
								proxy.trim() ? (parsed.ok ? "понял как: " + parsed.label : "ошибка: " + parsed.error) : "вставь адрес прокси — схема http/socks5 подставится сама"
							),
							h("input", {
								className: "input" + (parsedFallback && !parsedFallback.ok ? " bad" : ""),
								placeholder: "запасной прокси (необязательно)",
								value: fallback,
								spellCheck: false,
								onChange: (e) => {
									setFallback(e.target.value);
									setProxyCheck(null);
								}
							}),
							proxyCheck
								? h(
										"div",
										{ className: "parsed " + (proxyCheck.state === "ok" ? "ok" : proxyCheck.state === "bad" ? "bad" : "") },
										proxyCheck.state === "running" ? "проверяю туннель…" : proxyCheck.text
									)
								: null,
							h(
								"div",
								{ className: "btn-row" },
								h("button", { className: "btn", disabled: busy || !parsed.ok || proxyCheck?.state === "running", onClick: runProxyCheck }, "проверить"),
								h(
									"button",
									{
										className: "btn primary",
										disabled: busy || !parsed.ok,
										onClick: () => {
											const p = { mode: "proxy", proxy: parsed.href };
											if (parsedFallback && parsedFallback.ok) p.fallbackProxy = parsedFallback.href;
											onPatch(p, "прокси включён: " + parsed.label);
										}
									},
									"включить"
								),
								config.proxy || config.fallbackProxy
									? h(
											"button",
											{
												className: "btn",
												disabled: busy,
												onClick: () => {
													setProxy("");
													setFallback("");
													setProxyCheck(null);
													onPatch({ proxy: "", fallbackProxy: "", mode: "dns" }, "прокси убран");
												}
											},
											"убрать"
										)
									: null
							)
						)
					: null,
				visibleMode === "vpn"
					? h(
							"div",
							{ className: "sub" },
							h("div", { className: "subhead" }, "системный VPN"),
							h("div", { className: "hint" }, vpn && vpn.connected ? "Обнаружен активный интерфейс: " + (vpn.name || vpn.kind || "VPN") : "Трафик идёт напрямую через системную таблицу маршрутизации. Интерфейсы: " + ((vpn && vpn.interfaces && vpn.interfaces.join(", ")) || "—"))
						)
					: null,
				h(
					"div",
					{ className: "sub" },
					h(
						"div",
						{ className: "sub-h" },
						h("span", { className: "subhead" }, "Диагностика каналов"),
						watchdog && watchdog.lastProbeAt ? h("span", { className: "hint" }, "сторож: " + agoOf(Date.parse(watchdog.lastProbeAt))) : null
					),
					h(
						"div",
						{ className: "btn-row" },
						h("button", { className: "btn", disabled: benching || !egress.online, onClick: runBench }, benching ? "замеряю…" : "замерить каналы"),
						h("button", { className: "btn", disabled: !egress.online, onClick: runWatchdog }, "проверить сторожа")
					),
					bench
						? h(
								"div",
								{ className: "bench-list" },
								bench.map((row) =>
									h(
										"div",
										{ className: "bench-row", key: row.channel },
										h("b", null, row.channel),
										h("span", { style: { color: row.medianMs != null ? "var(--good)" : "var(--bad)" } }, row.medianMs != null ? row.medianMs + " мс" : row.error || "ошибка")
									)
								)
							)
						: null
				)
			);
		}

		/* ---------------------------------------------------------------- SettingsView */

		function SettingsView({ data, egress, error, searchBusy, guardBusy, thresholdText, setThresholdText, onSaveSearch, onSaveRotation, onCommitThreshold }) {
			const rotation = (data && data.rotation) || { enabled: true, threshold: 0.05 };
			const searchCfg = (data && data.search) || {
				model: null,
				defaultModel: "gemini-3.5-flash-lite",
				effectiveModel: "gemini-3.5-flash-lite",
				availableOnActive: true,
				models: [
					"gemini-3.5-flash-lite",
					"gemini-2.5-flash-lite",
					"gemini-3.1-flash-lite",
					"gemini-2.5-flash",
					"gemini-3-flash",
					"gemini-3.8-flash-tiered",
					"gemini-4-hydrogen-sonar"
				]
			};
			const searchModels = searchCfg.models || [];
			const oddSearchCount = searchModels.length % 2 === 1;
			const unavailableOnActive = Boolean(searchCfg.model && searchCfg.availableOnActive === false);

			return h(
				"div",
				{ className: "view", key: "settings" },
				h(
					"div",
					{ className: "sub" },
					h("div", { className: "sub-h" }, h("span", { className: "subhead" }, "web-search модель"), h("span", { className: "hint" }, searchCfg.model ? "вручную" : "авто")),
					h(
						"div",
						{ className: "models-pick" },
						h(
							"button",
							{
								className: "chip-btn wide" + (!searchCfg.model ? " on" : ""),
								disabled: searchBusy,
								onClick: () => onSaveSearch("auto")
							},
							"auto (" + searchModelLabel(searchCfg.defaultModel || "gemini-3.5-flash-lite") + ")"
						),
						searchModels.map((id, idx) => {
							const spanWide =
								oddSearchCount &&
								(id === "gemini-4-hydrogen-sonar" || (!searchModels.includes("gemini-4-hydrogen-sonar") && idx === searchModels.length - 1));
							return h(
								"button",
								{
									key: id,
									className: "chip-btn" + (spanWide ? " wide" : "") + (searchCfg.model === id ? " on" : ""),
									disabled: searchBusy,
									onClick: () => onSaveSearch(id),
									title: id
								},
								searchModelLabel(id)
							);
						})
					),
					h(
						"div",
						{ className: "hint" },
						"Сейчас для Google Search grounding используется: " +
							(searchCfg.effectiveModel || searchCfg.defaultModel) +
							(unavailableOnActive ? " (нет на активном аккаунте)" : "")
					)
				),
				h(
					"div",
					{ className: "guard" + (rotation.enabled ? "" : " off") },
					h(
						"div",
						{ className: "txt" },
						h("b", null, "сторож 5h"),
						h(
							"span",
							null,
							rotation.enabled
								? "уводить запросы на другой аккаунт, когда пятичасовое окно ниже порога"
								: "выключен — аккаунты идут по порядку, пин всегда первый"
						)
					),
					h(
						"label",
						{ className: "num", title: "порог 5h окна, %" },
						h("input", {
							type: "text",
							inputMode: "numeric",
							value: thresholdText !== null ? thresholdText : String(Math.round(rotation.threshold * 100)),
							onChange: (e) => setThresholdText(e.target.value.replace(/[^0-9.,]/g, "")),
							onBlur: onCommitThreshold,
							onKeyDown: (e) => {
								if (e.key === "Enter") e.currentTarget.blur();
							},
							disabled: !rotation.enabled || guardBusy
						}),
						h("span", null, "%")
					),
					h(
						"button",
						{
							className: "switch" + (rotation.enabled ? " on" : ""),
							onClick: () => onSaveRotation({ enabled: !rotation.enabled }),
							disabled: guardBusy
						},
						h("i")
					)
				),
				h(
					"div",
					{ className: "sub" },
					h("div", { className: "subhead" }, "состояние сервисов"),
					h(
						"div",
						{ className: "bench-list" },
						h("div", { className: "bench-row" }, h("b", null, "Bridge · 127.0.0.1:8787"), h("span", { style: { color: error ? "var(--bad)" : "var(--good)" } }, error ? "недоступен" : "работает")),
						h("div", { className: "bench-row" }, h("b", null, "Egress · 127.0.0.1:8789"), h("span", { style: { color: egress.online ? "var(--good)" : "var(--bad)" } }, egress.online ? "работает" : "недоступен")),
						h("div", { className: "bench-row" }, h("b", null, "Закреплённый аккаунт"), h("span", null, (() => { const pid = data && data.pinned; if (!pid) return "авто"; const acc = (data.accounts || []).find((a) => a.id === pid); return (acc && acc.email) || pid; })()))
					)
				)
			);
		}

		/* ---------------------------------------------------------------- main widget */

		function AgQuotaWidget() {
			const [open, setOpen] = React.useState(() => {
				try {
					return localStorage.getItem(OPEN_KEY) === "1";
				} catch {
					return false;
				}
			});
			const [activeTab, setActiveTab] = React.useState(() => {
				try {
					const t = localStorage.getItem(TAB_KEY);
					return t === "accounts" || t === "route" || t === "settings" ? t : "accounts";
				} catch {
					return "accounts";
				}
			});
			const [busy, setBusy] = React.useState(false);
			const [toast, setToast] = React.useState(null); // { text, tone: 'ok'|'bad'|'info' }
			const toastTimerRef = React.useRef(null);
			React.useEffect(() => () => {
				if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
			}, []);
			const notify = React.useCallback((text, tone = "info") => {
				if (!text) {
					setToast(null);
					return;
				}
				setToast({ text, tone });
				if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
				toastTimerRef.current = setTimeout(() => setToast(null), 5000);
			}, []);

			const { data, error, loading, load } = useLimits(open);
			const egress = useEgress();

			// Refresh limits automatically when user returns from Google OAuth tab
			const pendingLoginRef = React.useRef(false);
			React.useEffect(() => {
				const onFocus = () => {
					if (pendingLoginRef.current) {
						pendingLoginRef.current = false;
						load(true);
					}
				};
				window.addEventListener("focus", onFocus);
				return () => window.removeEventListener("focus", onFocus);
			}, [load]);

			const accounts = (data && data.accounts) || [];
			const pinnedId = data && data.pinned;
			const primary = accounts.find((a) => a.id === pinnedId || a.pinned) || accounts[0];
			const weekly = primary ? weeklyOf(primary) : null;
			const fiveH = primary ? fiveHourOf(primary) : null;
			const worst = primary ? worstOf(primary) : null;
			const health = error ? "var(--bad)" : worst === null ? "var(--muted)" : toneOf(worst);

			const [closing, setClosing] = React.useState(false);
			const eState = egress.state;
			const routeMode = (eState && eState.mode) || null;
			const routeReady = Boolean(eState && eState.modeInfo && eState.modeInfo.ready);
			const routeLabel = !egress.online ? "OFF" : routeMode ? routeMode.toUpperCase() : "…";
			const routeTone = !egress.online ? "var(--bad)" : routeMode === "direct" ? "var(--muted)" : routeReady ? "var(--good)" : "var(--warn)";
			const routeTitle = !egress.online ? "egress shim не запущен" : "маршрут: " + ((eState && eState.modeInfo && eState.modeInfo.label) || routeMode || "—");

			const selectTab = (id) => {
				setActiveTab(id);
				try {
					localStorage.setItem(TAB_KEY, id);
				} catch {}
			};

			const toggle = () => {
				const persist = (v) => {
					try {
						localStorage.setItem(OPEN_KEY, v);
					} catch {}
				};
				if (!open) {
					setOpen(true);
					persist("1");
					return;
				}
				setClosing(true);
				setTimeout(() => {
					setClosing(false);
					setOpen(false);
					persist("0");
				}, 150);
			};

			const patchEgress = async (body, label) => {
				setBusy(true);
				try {
					const res = await getJson(EGRESS + "/", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(12000)
					});
					if (!res.ok) notify((res.json && res.json.error) || "отклонено", "bad");
					else {
						egress.setState(res.json);
						if (label) notify(label, "ok");
					}
				} catch {
					notify("egress shim недоступен", "bad");
				}
				setBusy(false);
				egress.reload();
			};

			const setMode = (mode) => {
				if (mode !== "direct") {
					try {
						localStorage.setItem(MODE_KEY, mode);
					} catch {}
				}
				patchEgress({ mode }, "режим: " + mode.toUpperCase());
			};

			const toggleRelay = () => {
				const current = (egress.state && egress.state.mode) || "dns";
				if (current !== "direct") return patchEgress({ mode: "direct" }, "relay выключен (Direct)");
				let restore = "dns";
				try {
					restore = localStorage.getItem(MODE_KEY) || "dns";
				} catch {}
				return patchEgress({ mode: restore }, "relay включён (" + restore.toUpperCase() + ")");
			};

			const testRoute = async () => {
				setBusy(true);
				notify("отправляю тестовый запрос модели…", "info");
				try {
					const res = await getJson(BRIDGE + "/accounts/test-route", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.timeout(50000)
					});
					if (res.ok && res.json && res.json.ok) {
						notify("маршрут работает · " + (res.json.ms / 1000).toFixed(1) + " с", "ok");
					} else {
						const msg = (res.json && (res.json.error?.message || res.json.error)) || "HTTP " + res.status;
						notify(/location is not supported/i.test(String(msg)) ? "регион заблокирован с этого маршрута" : explainError(msg) || String(msg), "bad");
					}
				} catch {
					notify("мост не отвечает", "bad");
				}
				setBusy(false);
				egress.reload();
			};

			const switchAccount = async (id) => {
				try {
					const res = await fetch(BRIDGE + "/accounts/switch", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id }),
						signal: AbortSignal.timeout(15000)
					});
					const json = await res.json().catch(() => ({}));
					if (json && json.ok) notify(id ? "закреплён: " + (json.order && json.order[0] ? json.order[0] : id) : "включён авто-выбор аккаунта", "ok");
					else notify("мост не принял переключение", "bad");
				} catch {
					notify("мост не отвечает", "bad");
				}
				load(true);
			};

			const toggleEnabled = async (id, enabled) => {
				try {
					const res = await fetch(BRIDGE + "/accounts/enabled", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id, enabled }),
						signal: AbortSignal.timeout(15000)
					});
					if (res.ok) notify(enabled ? "аккаунт включён" : "аккаунт отключён", "ok");
					else notify("не удалось изменить статус аккаунта", "bad");
				} catch {
					notify("мост не отвечает", "bad");
				}
				load(true);
			};

			const removeAccount = async (id) => {
				try {
					const res = await fetch(BRIDGE + "/accounts/remove", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id }),
						signal: AbortSignal.timeout(15000)
					});
					const json = await res.json().catch(() => ({}));
					if (res.ok) notify("аккаунт удалён", "ok");
					else notify(explainError(json.error && json.error.message ? json.error.message : "не удалось удалить"), "bad");
				} catch {
					notify("мост не отвечает", "bad");
				}
				load(true);
			};

			const [checking, setChecking] = React.useState(null);
			const checkAccount = async (id) => {
				setChecking(id);
				try {
					const res = await fetch(BRIDGE + "/accounts/check", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id }),
						signal: AbortSignal.timeout(35000)
					});
					const json = await res.json().catch(() => ({}));
					if (json && json.ok) notify("ответ аккаунта: " + (json.ms / 1000).toFixed(1) + " с", "ok");
					else notify("проверка не удалась: " + explainError(json.error || ""), "bad");
				} catch {
					notify("мост не отвечает", "bad");
				}
				setChecking(null);
				load(true);
			};

			const addAccount = async () => {
				try {
					const res = await getJson(BRIDGE + "/accounts/login", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.timeout(15000)
					});
					if (res.ok && res.json && res.json.url) {
						pendingLoginRef.current = true;
						window.open(res.json.url, "_blank", "noopener");
						notify("открыто окно входа Google — после входа список обновится сам", "info");
					} else {
						notify((res.json && (res.json.error?.message || res.json.error)) || "не удалось начать вход OAuth", "bad");
					}
				} catch {
					notify("мост не отвечает", "bad");
				}
			};

			const rotation = (data && data.rotation) || { enabled: true, threshold: 0.05 };
			const [thresholdText, setThresholdText] = React.useState(null);
			const [guardBusy, setGuardBusy] = React.useState(false);
			const saveRotation = async (patch) => {
				setGuardBusy(true);
				try {
					const res = await fetch(BRIDGE + "/accounts/rotation", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch),
						signal: AbortSignal.timeout(15000)
					});
					const json = await res.json().catch(() => ({}));
					if (json && json.ok) notify(json.rotation.enabled ? "сторож 5h включён (" + Math.round(json.rotation.threshold * 100) + "%)" : "сторож 5h выключен", "ok");
					else notify("мост не принял настройку", "bad");
				} catch {
					notify("мост не отвечает", "bad");
				}
				setThresholdText(null);
				setGuardBusy(false);
				load(true);
			};
			const commitThreshold = () => {
				if (thresholdText === null) return;
				const pct = Number(thresholdText.replace(",", "."));
				if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
					setThresholdText(null);
					return;
				}
				saveRotation({ threshold: pct / 100 });
			};

			const [searchBusy, setSearchBusy] = React.useState(false);
			const saveSearchModel = async (model) => {
				setSearchBusy(true);
				try {
					const res = await fetch(BRIDGE + "/search/model", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ model: model === "auto" ? null : model }),
						signal: AbortSignal.timeout(15000)
					});
					const json = await res.json().catch(() => ({}));
					if (res.ok && json && json.ok) notify("web-search: " + (json.model || "auto (" + json.effectiveModel + ")"), "ok");
					else notify("мост не принял модель поиска", "bad");
				} catch {
					notify("мост не отвечает", "bad");
				}
				setSearchBusy(false);
				load(true);
			};

			// Keep #dsh-relay-link offset synced locally
			const rootRef = React.useRef(null);
			React.useEffect(() => {
				const style = document.createElement("style");
				style.id = "agq-relay-offset";
				style.textContent = "#dsh-relay-link{right:calc(16px + var(--agq-w, 132px) + 10px) !important}";
				document.head.appendChild(style);
				const node = rootRef.current;
				const push = () => {
					if (node) document.documentElement.style.setProperty("--agq-w", Math.round(node.offsetWidth) + "px");
				};
				push();
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(push) : null;
				if (observer && node) observer.observe(node);
				window.addEventListener("resize", push);
				return () => {
					observer?.disconnect();
					window.removeEventListener("resize", push);
					style.remove();
				};
			}, []);

			const tabIndex = activeTab === "accounts" ? 0 : activeTab === "route" ? 1 : 2;
			const activeRouteLabel = !egress.online
				? "Egress выкл"
				: routeMode === "dns"
					? "DNS · " + ((eState && eState.route) || "auto")
					: (eState && eState.modeInfo && eState.modeInfo.label) || "—";
			const activeRouteStats = !egress.online
				? "порт 8789 не отвечает"
				: eState && eState.stats
					? eState.stats.proxied + " ok · " + eState.stats.failed + " fail"
					: "ожидание";

			return h(
				"div",
				{ ref: rootRef, className: "agq", style: { position: "fixed", right: 14, bottom: 14, zIndex: 60, display: "flex", flexDirection: "column", alignItems: "flex-end" } },
				open
					? h(
							"div",
							{ className: "panel" + (closing ? " closing" : "") },
							h(
								"div",
								{ className: "panel-in" },
								h(
									"div",
									{ className: "head" },
									h("span", { className: "mark" }, "A"),
									h(
										"div",
										{ className: "head-t" },
										h("h1", null, "Antigravity"),
										h(
											"small",
											null,
											accounts.length + " акк." + (primary && primary.tierName ? " · " + primary.tierName : "") + (data && data.updatedAt ? " · " + agoOf(data.updatedAt) : "")
										)
									),
									h(
										"button",
										{
											className: "icon" + (loading ? " is-busy" : ""),
											onClick: () => load(true),
											disabled: loading,
											title: "обновить квоты",
											"aria-label": "обновить"
										},
										h(
											"svg",
											{ viewBox: "0 0 16 16", width: 13, height: 13, "aria-hidden": "true" },
											h("path", { d: "M12.9 8a4.9 4.9 0 1 1-1.5-3.5", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
											h("path", { d: "M13.2 2.9v2.8H10.4", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
										)
									),
									h("button", { className: "icon", onClick: toggle, title: "закрыть", "aria-label": "закрыть" }, "×")
								),
								h(
									"div",
									{ className: "summary" },
									h(
										"button",
										{ className: "sum-card", onClick: () => selectTab("accounts") },
										h("div", { className: "sum-top" }, h("span", { className: "dot", style: { background: health } }), h("span", null, pinnedId ? "Закреплён" : "Активный")),
										h("div", { className: "sum-main" }, primary ? (primary.email || primary.id).replace(/@.*$/, "") : error ? "мост выкл" : "нет"),
										h("div", { className: "sum-sub" }, fiveH !== null || weekly ? "5ч " + (fiveH ?? "—") + "% · нед " + (weekly ? pctOf(weekly.remaining) : "—") + "%" : "квоты не загружены")
									),
									h(
										"button",
										{ className: "sum-card", onClick: () => selectTab("route") },
										h("div", { className: "sum-top" }, h("span", { className: "dot", style: { background: routeTone } }), h("span", null, "Маршрут")),
										h("div", { className: "sum-main" }, activeRouteLabel),
										h("div", { className: "sum-sub" }, activeRouteStats)
									)
								),
								h(
									"div",
									{ className: "tabs", role: "tablist" },
									h("span", { className: "tab-pill", style: { left: "calc(3px + " + tabIndex + " * ((100% - 6px) / 3))" } }),
									h("button", { role: "tab", "aria-selected": activeTab === "accounts", onClick: () => selectTab("accounts") }, "Аккаунты", h("sup", null, accounts.length)),
									h("button", { role: "tab", "aria-selected": activeTab === "route", onClick: () => selectTab("route") }, h("span", { className: "tdot", style: { background: routeTone } }), "Маршрут"),
									h("button", { role: "tab", "aria-selected": activeTab === "settings", onClick: () => selectTab("settings") }, "Настройки")
								),
								h(
									"div",
									{ className: "scroll" },
									activeTab === "accounts"
										? h(
												"div",
												{ className: "view", key: "accounts" },
												h(
													"div",
													{ className: "bar-info" },
													h("span", null, "Ротация: ", h("b", null, rotation.enabled ? "авто (" + Math.round(rotation.threshold * 100) + "%)" : "по порядку")),
													pinnedId ? h("button", { className: "pill-btn", onClick: () => switchAccount(null) }, "сбросить пин") : h("span", null, "пин: авто")
												),
												accounts.length
													? accounts.map((account) =>
															h(AccountCard, {
																key: account.id,
																account,
																pinned: account.id === pinnedId || account.pinned,
																onSwitch: switchAccount,
																onToggleEnabled: toggleEnabled,
																onCheck: checkAccount,
																onRemove: removeAccount,
																onNotify: notify,
																checking: checking === account.id
															})
														)
													: h("div", { className: "empty" }, error ? "мост недоступен (127.0.0.1:8787)" : "нет аккаунтов")
											)
										: activeTab === "route"
											? h(RouteView, { egress, busy, onMode: setMode, onToggle: toggleRelay, onPatch: patchEgress, onNotify: notify })
											: h(SettingsView, {
													data,
													egress,
													error,
													searchBusy,
													guardBusy,
													thresholdText,
													setThresholdText,
													onSaveSearch: saveSearchModel,
													onSaveRotation: saveRotation,
													onCommitThreshold: commitThreshold
												})
								),
								toast
									? h(
											"div",
											{ className: "toast-bar " + toast.tone },
											h("span", null, toast.text),
											h("button", { onClick: () => setToast(null), "aria-label": "скрыть" }, "×")
										)
									: null,
								h(
									"div",
									{ className: "foot" },
									h("button", { className: "btn primary", onClick: addAccount }, "+ аккаунт"),
									h("button", { className: "btn", onClick: testRoute, disabled: busy, title: "проверить маршрут запросом к модели" }, busy ? "проверяю…" : "тест маршрута")
								)
							)
						)
					: null,
				h(
					"div",
					{ className: "pill", onClick: toggle, title: error ? error : "Antigravity quota" },
					h(Ring, { pct: weekly ? pctOf(weekly.remaining) : worst ?? 0, size: 26, bare: true }),
					h(
						"span",
						{ className: "txt" },
						h("b", null, error ? "off" : weekly ? pctOf(weekly.remaining) + "%" : worst === null ? "—" : worst + "%"),
						h(
							"span",
							{ className: "cap" },
							h("i", { className: "st", style: { background: error ? "var(--bad)" : weekly ? toneOf(pctOf(weekly.remaining)) : health } }),
							error ? "мост не отвечает" : weekly && weekly.resetAt ? "сброс " + shortLeft(weekly.resetAt) : "Gemini bridge"
						)
					),
					h(
						"span",
						{ className: "route", title: routeTitle },
						h("i", { className: "st", style: { background: routeTone } }),
						routeLabel
					)
				)
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "ag-limits", order: 900 }, AgQuotaWidget)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
