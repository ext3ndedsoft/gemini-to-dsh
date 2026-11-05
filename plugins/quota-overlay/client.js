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
		const EGRESS_MS = 8000;
		const OPEN_KEY = "ag-limits:open";
		const MODE_KEY = "ag-limits:mode";

		/* ---------------------------------------------------------------- styles */

		const CSS = `
.agq{--bg:#0b0b10;--card:rgba(20,20,28,.92);--line:rgba(255,255,255,.08);
	--line-strong:rgba(255,255,255,.14);--text:#ececf1;--muted:#8b8b99;
	--a:#8b5cf6;--b:#22d3ee;--good:#34d399;--warn:#fbbf24;--bad:#f87171;
	font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
.agq *{box-sizing:border-box}
@keyframes agq-panel-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@keyframes agq-panel-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(6px) scale(.99)}}
@keyframes agq-rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes agq-fade{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@keyframes agq-dash{from{stroke-dashoffset:var(--full)}to{stroke-dashoffset:var(--off)}}
@keyframes agq-pulse{0%{box-shadow:0 0 0 0 rgba(139,92,246,.35)}100%{box-shadow:0 0 0 10px rgba(139,92,246,0)}}
@media (prefers-reduced-motion:reduce){
	.agq *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
}
.agq button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.agq .pill{display:flex;align-items:center;gap:7px;padding:4px 9px 4px 5px;border-radius:999px;
	background:linear-gradient(180deg,rgba(30,30,42,.96),rgba(16,16,22,.96));
	border:1px solid var(--line-strong);box-shadow:0 10px 30px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
	transition:transform .16s ease,box-shadow .16s ease}
.agq .pill:hover{transform:translateY(-1px);box-shadow:0 14px 36px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.09)}
.agq .pill:active{transform:scale(.97)}
.agq .pill{transition:transform .16s ease,box-shadow .16s ease}
.agq .pill{gap:8px;padding:5px 11px 5px 5px}
.agq .pill b{display:block;font-size:15px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.agq .pill .cap{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--muted);letter-spacing:.01em;line-height:1;margin-top:3px;white-space:nowrap}
.agq .pill .st{width:4px;height:4px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor}
.agq .panel{display:flex;overflow:hidden;animation:agq-panel-in .24s cubic-bezier(.2,.9,.25,1) both;transform-origin:bottom right}
.agq .panel.closing{animation:agq-panel-out .16s ease-in forwards}
.agq .panel{width:348px;max-width:calc(100vw - 28px);max-height:min(74vh,640px);
	margin-bottom:10px;border-radius:18px;padding:2px;
	background:linear-gradient(160deg,rgba(139,92,246,.35),rgba(34,211,238,.18) 42%,transparent 70%);
	box-shadow:0 26px 70px rgba(0,0,0,.65)}
.agq .panel-in{display:flex;flex-direction:column;min-height:0;flex:1;max-height:calc(min(74vh,640px) - 4px);border-radius:16px;padding:14px 14px 12px;background:
	radial-gradient(120% 90% at 100% 0%,rgba(139,92,246,.10),transparent 55%),
	linear-gradient(180deg,rgba(19,19,27,.99),rgba(12,12,17,.99))}
.agq .scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;margin:0 -2px;padding:0 2px 2px;
	-webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 16px),transparent);
	mask-image:linear-gradient(180deg,#000 calc(100% - 16px),transparent)}
.agq .scroll::-webkit-scrollbar{width:6px}
.agq .scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:99px}
.agq .head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.agq .mark{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-size:11px;font-weight:700;
	background:linear-gradient(135deg,var(--a),var(--b));color:#08080c;box-shadow:0 4px 14px rgba(139,92,246,.45)}
.agq .head h1{font-size:12.5px;font-weight:600;letter-spacing:.02em;margin:0}
.agq .chip{font-size:9.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
	border:1px solid var(--line);border-radius:99px;padding:2px 7px}
.agq .icon{margin-left:auto;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;padding:0;
	border:1px solid var(--line);color:var(--muted);transition:.15s}
.agq .icon:hover{color:var(--text);border-color:var(--line-strong);background:rgba(255,255,255,.04)}
/* Only the glyph turns. Spinning the button itself rotated its border and padding too, which
   reads as a wobbly square rather than a refresh. */
.agq .icon svg{display:block;transition:transform .2s ease}
.agq .icon.is-busy svg{animation:agq-spin .9s linear infinite}
.agq .icon.is-busy{color:var(--b);border-color:rgba(124,156,255,.35)}
.agq .icon[disabled]{opacity:.6;cursor:default}
.agq .icon:active{transform:scale(.94)}
@keyframes agq-spin{to{transform:rotate(360deg)}}
.agq .seg{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:3px;padding:3px;border-radius:12px;
	background:rgba(255,255,255,.04);border:1px solid var(--line)}
.agq .seg .thumb{position:absolute;top:3px;bottom:3px;width:calc((100% - 6px) / 4);border-radius:9px;
	background:linear-gradient(135deg,#8b5cf6,#22d3ee);box-shadow:0 6px 18px rgba(139,92,246,.45),inset 0 1px 0 rgba(255,255,255,.25);
	transition:left .26s cubic-bezier(.3,1.1,.4,1);pointer-events:none}
.agq .seg button{position:relative;z-index:1}
.agq .seg button{padding:7px 0;border-radius:9px;font-size:11px;font-weight:500;color:var(--muted);
	transition:.15s;letter-spacing:.01em}
.agq .seg button:hover{color:var(--text);background:rgba(255,255,255,.05)}
.agq .seg button.on{color:#0a0a10;font-weight:600}
.agq .state{display:flex;align-items:center;gap:7px;margin:9px 2px 0;font-size:11px;color:var(--muted)}
.agq .dot{width:6px;height:6px;border-radius:99px;flex:0 0 auto}
.agq .state em{font-style:normal;color:var(--text);opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
	animation:agq-fade .2s ease both}
.agq .relay{display:flex;align-items:center;gap:10px;margin-top:10px;padding:9px 11px;border-radius:12px;
	background:rgba(255,255,255,.03);border:1px solid var(--line)}
.agq .relay .txt{flex:1;min-width:0}
.agq .relay .txt b{display:block;font-size:11.5px;font-weight:600}
.agq .relay .txt span{font-size:10.5px;color:var(--muted)}
.agq .switch{width:42px;height:23px;border-radius:99px;position:relative;flex:0 0 auto;
	background:rgba(255,255,255,.10);border:1px solid var(--line-strong);transition:.18s}
.agq .switch i{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:99px;background:#6b6b78;
	transition:.18s cubic-bezier(.3,.8,.4,1)}
.agq .switch.on{background:linear-gradient(135deg,rgba(139,92,246,.55),rgba(34,211,238,.45));border-color:rgba(167,139,250,.55)}
.agq .switch.on i{left:21px;background:#f4f4ff;box-shadow:0 0 10px rgba(167,139,250,.9)}
.agq .sub{margin-top:9px;padding:9px 10px 10px;border-radius:12px;border:1px solid var(--line);
	background:rgba(255,255,255,.025);animation:agq-rise .24s cubic-bezier(.2,.9,.25,1) both}
.agq .sub .subhead{font-size:9px;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.agq .sub .input{margin-top:0;margin-bottom:6px}
.agq .sub .foot{margin-top:4px}
.agq .chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.agq .chip-btn{font-size:10.5px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);
	color:var(--muted);transition:border-color .15s,color .15s,transform .12s,background .15s}
.agq .chip-btn:hover{color:var(--text);border-color:var(--line-strong);background:rgba(255,255,255,.04)}
.agq .chip-btn:active{transform:scale(.97)}
.agq .chip-btn.on{color:#0a0a10;font-weight:600;border-color:transparent;
	background:linear-gradient(135deg,#8b5cf6,#22d3ee);box-shadow:0 4px 14px rgba(139,92,246,.35)}
.agq .hint{font-size:9.5px;color:var(--muted);margin-top:6px;line-height:1.4}
.agq .parsed{font-size:9.5px;color:var(--muted);margin:5px 2px 0;line-height:1.35;letter-spacing:.01em}
.agq .parsed.ok{color:#7fe3b0}
.agq .parsed.bad{color:#ff9a9a}
.agq .input.bad{border-color:rgba(255,120,120,.55);box-shadow:0 0 0 1px rgba(255,120,120,.18) inset}
.agq .sect{display:flex;align-items:center;gap:8px;margin:14px 2px 8px;font-size:9.5px;
	letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.agq .sect:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.agq .card{border:1px solid var(--line);border-radius:13px;padding:10px 11px;margin-bottom:8px;
	background:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,.008));
	animation:agq-rise .3s cubic-bezier(.2,.9,.25,1) both;transition:border-color .18s,transform .18s,box-shadow .18s}
.agq .card:hover{border-color:rgba(255,255,255,.16);transform:translateY(-1px);
	box-shadow:0 8px 24px rgba(0,0,0,.35)}
.agq .card .lat{display:flex;align-items:center;gap:6px;margin-top:7px;font-size:10.5px;color:var(--muted)}
.agq .card .lat b{font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}
.agq .card .lat b.none{color:var(--muted);font-weight:500}
.agq .card .lat .when{margin-right:auto;opacity:.8}
.agq .card .lat .mini{opacity:.75}
.agq .card .lat .mini:hover{opacity:1}
.agq .card .mail{display:flex;align-items:center;gap:5px;min-width:0}
.agq .card .mail b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agq .card .del{margin-left:1px;width:16px;height:16px;border-radius:5px;display:grid;place-items:center;padding:0;font-size:9.5px;line-height:1;color:var(--muted);opacity:.55;background:transparent;border:1px solid transparent;cursor:pointer;transition:color .15s,border-color .15s,background .15s,opacity .15s}
.agq .card .del svg{display:block}
.agq .card .del:hover{color:var(--bad);border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08)}
.agq .card .del.ask{width:auto;padding:0 7px;font-size:9.5px;letter-spacing:.04em;color:#ffd7d7;border-color:rgba(255,107,107,.5);background:rgba(255,107,107,.14)}
.agq .card .lat .req{opacity:.55;font-variant-numeric:tabular-nums}
.agq .card .here{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--b);opacity:.85}
.agq .card .top{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.agq .who{flex:1;min-width:0}
.agq .who b{display:block;font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agq .who span{font-size:10px;color:var(--muted)}
.agq .mini{font-size:9.5px;color:var(--muted);border:1px solid var(--line);border-radius:7px;padding:2px 6px;
	transition:.15s}
.agq .mini:hover{color:var(--text);border-color:var(--line-strong)}
.agq .grp{display:flex;align-items:center;gap:10px;padding:6px 0}
.agq .grp+.grp{border-top:1px solid rgba(255,255,255,.055)}
.agq .grp .meta{flex:1;min-width:0}
.agq .grp .meta b{display:block;font-size:11.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agq .grp .meta span{display:block;font-size:9.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.agq .grp .meta span.badge{display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:2px 7px;border-radius:6px;
	font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);
	background:rgba(255,255,255,.05);border:1px solid var(--line)}
.agq .badge i{width:5px;height:5px;border-radius:99px;background:currentColor;opacity:.8}
.agq .bar{height:5px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:5px}
.agq .bar i{display:block;height:100%;border-radius:99px;transition:width .5s cubic-bezier(.3,.8,.4,1)}
.agq .ring{position:relative;width:46px;height:46px;flex:0 0 auto}
.agq .ring svg{transform:rotate(-90deg)}
.agq .ring .arc{animation:agq-dash .7s cubic-bezier(.3,.9,.3,1)}
.agq .ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:10px;font-weight:600;
	letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.agq .rows{margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.06)}
.agq .row{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--muted);padding:2px 0}
.agq .row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);opacity:.72}
.agq .row .pct{font-variant-numeric:tabular-nums}
.agq .empty{font-size:10.5px;color:var(--muted);padding:2px 0}
.agq .err{font-size:10.5px;color:var(--bad);padding:2px 0;word-break:break-word}
.agq .foot{display:flex;gap:6px;margin-top:10px;flex:0 0 auto;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}
.agq .btn{flex:1;border:1px solid var(--line-strong);border-radius:9px;padding:7px 8px;font-size:11px;
	color:var(--text);background:rgba(255,255,255,.03);transition:.15s}
.agq .btn:hover{background:rgba(255,255,255,.07);transform:translateY(-1px)}
.agq .btn:active{transform:scale(.985)}
.agq .btn{transition:.15s,transform .12s}
.agq .btn:disabled{opacity:.45;cursor:default}
.agq .btn.wide{flex:2}
.agq .input{width:100%;margin-top:7px;background:rgba(0,0,0,.35);border:1px solid var(--line-strong);
	border-radius:9px;color:var(--text);font:inherit;font-size:11px;padding:7px 9px;outline:none}
.agq .input:focus{border-color:rgba(167,139,250,.6);box-shadow:0 0 0 3px rgba(139,92,246,.14)}
.agq .note{font-size:10px;color:var(--muted);margin-top:7px;word-break:break-word}
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

		const KEEP_MODEL = (id) => /^claude-/.test(id) || /^gemini-3\.8-flash/.test(id);

		function resetIn(iso) {
			if (!iso) return "";
			const at = Date.parse(iso);
			if (!Number.isFinite(at)) return "";
			const minutes = Math.round((at - Date.now()) / 60000);
			if (minutes <= 0) return "now";
			if (minutes < 60) return "in " + minutes + "m";
			const hours = Math.floor(minutes / 60);
			if (hours < 48) return "in " + hours + "h" + (minutes % 60 ? " " + (minutes % 60) + "m" : "");
			return "in " + Math.round(hours / 24) + "d";
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

		function weeklyOf(account) {
			const groups = (account && account.groups) || [];
			const weekly = groups.flatMap((group) => (group.weekly || []).map((bucket) => ({ ...bucket, group: group.name })));
			if (!weekly.length) return null;
			return weekly.reduce((worst, bucket) => (pctOf(bucket.remaining) < pctOf(worst.remaining) ? bucket : worst), weekly[0]);
		}

		async function getJson(url, options) {
			const res = await fetch(url, { cache: "no-store", ...options });
			const json = await res.json().catch(() => null);
			return { ok: res.ok, status: res.status, json };
		}

		/* ---------------------------------------------------------------- hooks */

		function useLimits() {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(false);

			const load = React.useCallback(async (force) => {
				setLoading(true);
				try {
					const res = await getJson(BRIDGE + "/limits" + (force ? "?force=1" : ""));
					if (!res.ok) throw new Error("bridge " + res.status);
					setData(res.json);
					setError(null);
				} catch (err) {
					setError(String((err && err.message) || err));
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				let alive = true;
				load(false);
				const timer = setInterval(() => {
					if (alive && typeof document !== "undefined" && document.visibilityState !== "hidden") load(false);
				}, QUOTA_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [load]);

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
				// The shim pushes its whole state on change. Subscribing means the panel does not
				// ask on a timer — when nothing happens, nothing is sent, and when a mode is
				// switched the answer arrives in the same breath instead of on the next beat.
				let source = null;
				try {
					source = new EventSource(EGRESS + "/events");
					source.onmessage = (event) => {
						try {
							setState(JSON.parse(event.data));
							setOnline(true);
						} catch {
							/* a frame cut in half heals on the next one */
						}
					};
				} catch {
					/* no EventSource: the slow poll below still keeps the panel honest */
				}
				const timer = setInterval(load, 60000);
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

		function Ring({ pct, size = 46, bare = false, thin = false }) {
			const box = size;
			const stroke = thin ? 2 : 3;
			const radius = box / 2 - stroke / 2 - 1.5;
			const center = box / 2;
			const circumference = 2 * Math.PI * radius;
			const filled = (clamp(pct) / 100) * circumference;
			const color = toneOf(pct);
			return h(
				"div",
				{ className: "ring", style: { width: box, height: box } },
				h(
					"svg",
					{ width: box, height: box, viewBox: "0 0 " + box + " " + box },
					h("circle", { cx: center, cy: center, r: radius, fill: "none", stroke: "rgba(255,255,255,.09)", strokeWidth: stroke }),
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
						className: "arc",
						style: {
							transition: "stroke-dashoffset .5s cubic-bezier(.3,.8,.4,1)",
							"--full": circumference,
							"--off": circumference - filled
						}
					})
				),
				bare ? null : h("b", null, pct + "%")
			);
		}

		function Bar({ pct }) {
			return h("div", { className: "bar" }, h("i", { style: { width: clamp(pct) + "%", background: toneOf(pct) } }));
		}

		function Segmented({ value, onChange }) {
			const options = [
				{ id: "dns", label: "DNS" },
				{ id: "proxy", label: "Proxy" },
				{ id: "vpn", label: "VPN" },
				{ id: "direct", label: "Direct" }
			];
			const index = Math.max(0, options.findIndex((option) => option.id === value));
			return h(
				"div",
				{ className: "seg", role: "tablist" },
				h("span", {
					className: "thumb",
					style: { left: "calc(3px + " + index + " * ((100% - 6px) / 4))" }
				}),
				options.map((option) =>
					h(
						"button",
						{
							key: option.id,
							role: "tab",
							"aria-selected": value === option.id,
							className: value === option.id ? "on" : "",
							onClick: () => onChange(option.id)
						},
						option.label
					)
				)
			);
		}

		/* ---------------------------------------------------------------- blocks */

		function DnsPanel({ channels, active, chain, providers, draft, setDraft, busy, onPatch }) {
			const head = chain[0] || channels[0] || '';
			const current = active && active !== 'direct' ? active : '';

			const saveCustom = () => {
				const ips = draft
					.split(/[\s,]+/)
					.map((item) => item.trim())
					.filter(Boolean);
				if (!ips.length) return;
				onPatch(
					{
						providers: { custom: { dns: ips, seeds: ['cloudaicompanion.googleapis.com'] } },
						route: 'custom',
						mode: 'dns'
					},
					'свой DNS сохранён: ' + ips.join(', ')
				);
			};

			return h(
				'div',
				{ className: 'sub' },
				h('div', { className: 'subhead' }, 'выход DNS'),
				h(
					'div',
					{ className: 'chips' },
					h(
						'button',
						{
							className: 'chip-btn' + (current === head ? ' on' : ''),
							onClick: () => onPatch({ mode: 'dns', route: head }, 'маршрут: ' + head),
							title: chain.join(' > ')
						},
						'наша цепочка'
					),
					channels.map((name) =>
						h(
							'button',
							{
								key: name,
								className: 'chip-btn' + (current === name ? ' on' : ''),
								onClick: () => onPatch({ mode: 'dns', route: name }, 'маршрут: ' + name),
								title: ((providers[name] && providers[name].dns) || []).join(', ')
							},
							name
						)
					),
					providers.custom
						? h(
								'button',
								{
									className: 'chip-btn' + (current === 'custom' ? ' on' : ''),
									onClick: () => onPatch({ mode: 'dns', route: 'custom' }, 'маршрут: свой DNS'),
									title: (providers.custom.dns || []).join(', ')
								},
								'свой'
							)
						: null
				),
				h('input', {
					className: 'input',
					placeholder: 'свой DNS: 1.2.3.4, 5.6.7.8',
					value: draft,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown: (event) => {
						if (event.key === 'Enter') saveCustom();
					}
				}),
				h(
					'div',
					{ className: 'foot' },
					h('button', { className: 'btn wide', disabled: busy || !draft.trim(), onClick: saveCustom }, 'сохранить свой DNS'),
					providers.custom
						? h(
								'button',
								{
									className: 'btn',
									disabled: busy,
									onClick: () => {
										setDraft('');
										onPatch({ route: head, providers: { custom: null } }, 'свой DNS убран');
									}
								},
								'убрать'
							)
						: null
				),
				h('div', { className: 'hint' }, 'адреса пишутся в ~/.dsh/ag-egress.json и переживают перезапуск')
			);
		}

		// One field, several accepted shapes. A person pasting a proxy has it in whatever
		// form the seller gave them: a full URL with credentials, a socks5 link, or just
		// host:port. All three mean the same thing to the shim, so the panel normalises
		// instead of demanding one form.
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

		function ProxyPanel({ proxy, fallback, setProxy, setFallback, configured, busy, onPatch }) {
			const [check, setCheck] = React.useState(null);
			const parsed = readProxy(proxy);
			const parsedFallback = fallback.trim() ? readProxy(fallback) : null;

			const runCheck = async () => {
				if (!parsed.ok) return;
				setCheck({ state: "running" });
				try {
					const response = await fetch(EGRESS + "/check?proxy=" + encodeURIComponent(parsed.href), {
						signal: AbortSignal.timeout(15000)
					});
					const result = await response.json();
					setCheck(
						result.ok
							? { state: "ok", text: "туннель открылся за " + result.ms + " мс" }
							: { state: "bad", text: result.error || "не отвечает" }
					);
				} catch (error) {
					setCheck({ state: "bad", text: error.message || "проверка не удалась" });
				}
			};

			const save = () => {
				if (!parsed.ok) return;
				const patch = { mode: "proxy", proxy: parsed.href };
				if (parsedFallback && parsedFallback.ok) patch.fallbackProxy = parsedFallback.href;
				onPatch(patch, "прокси включён: " + parsed.label);
			};

			return h(
				"div",
				{ className: "sub" },
				h("div", { className: "subhead" }, "выход через прокси"),
				h("input", {
					className: "input" + (proxy.trim() && !parsed.ok ? " bad" : ""),
					placeholder: "http://логин:пароль@host:port, socks5://host:port или просто host:port",
					value: proxy,
					spellCheck: false,
					onChange: (event) => {
						setProxy(event.target.value);
						setCheck(null);
					},
					onKeyDown: (event) => {
						if (event.key === "Enter" && parsed.ok) save();
					}
				}),
				h(
					"div",
					{ className: "parsed" + (proxy.trim() ? (parsed.ok ? " ok" : " bad") : "") },
					proxy.trim() ? (parsed.ok ? "понял как: " + parsed.label : "не понял: " + parsed.error) : "вставь ссылку на прокси — схему можно не писать"
				),
				h("input", {
					className: "input" + (parsedFallback && !parsedFallback.ok ? " bad" : ""),
					placeholder: "запасной прокси — необязательно",
					value: fallback,
					spellCheck: false,
					onChange: (event) => {
						setFallback(event.target.value);
						setCheck(null);
					}
				}),
				check
					? h(
							"div",
							{ className: "parsed " + (check.state === "ok" ? "ok" : check.state === "bad" ? "bad" : "") },
							check.state === "running" ? "проверяю туннель…" : check.text
						)
					: null,
				h(
					"div",
					{ className: "foot" },
					h(
						"button",
						{ className: "btn", disabled: busy || !parsed.ok || check?.state === "running", onClick: runCheck },
						"проверить"
					),
					h("button", { className: "btn wide", disabled: busy || !parsed.ok, onClick: save }, "включить"),
					configured
						? h(
								"button",
								{
									className: "btn",
									disabled: busy,
									onClick: () => {
										setProxy("");
										setFallback("");
										setCheck(null);
										onPatch({ proxy: "", fallbackProxy: "", mode: "dns" }, "прокси убран");
									}
								},
								"убрать"
							)
						: null
				),
				h(
					"div",
					{ className: "hint" },
					configured
						? "сохранённый адрес скрыт — пустое поле и сохранение оставят его как есть"
						: "адрес пишется в ~/.dsh/ag-egress.json; ключ проверяется только при сохранении, «проверить» ничего не меняет"
				)
			);
		}

		function Transport({ egress, busy, note, onMode, onToggle, onPatch }) {
			const state = egress.state;
			const mode = (state && state.mode) || "dns";
			const info = (state && state.modeInfo) || { label: mode, detail: "", ready: false };
			const config = (state && state.config) || {};
			const providers = config.providers || {};
			const chain = (state && state.chain) || [];
			const stats = (state && state.stats) || null;
			const vpn = (state && state.vpn) || null;

			const channels = ((state && state.channels) || []).filter(
				(name) => name !== "proxy" && name !== "direct" && name !== "custom"
			);

			// The visible tab is local: picking Proxy must not try to switch the transport
			// before an address exists, because that is a request the shim refuses — and a
			// refusal in the note instead of a panel is why this looked broken.
			const [tab, setTab] = React.useState(null);
			React.useEffect(() => {
				setTab((previous) => (previous === "proxy" && mode !== "proxy" ? previous : mode));
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
			React.useEffect(() => {
				if (!dnsDraft && providers.custom && providers.custom.dns) setDnsDraft(providers.custom.dns.join(", "));
			}, [providers.custom]);
			React.useEffect(() => {
				// The shim answers with the proxy masked, and a masked value must never end up
				// back in the field: saving it would replace a working address with bullets.
				const saved = config.proxy && !config.proxy.includes("•") ? config.proxy : "";
				if (!proxy && saved) setProxy(saved);
			}, [config.proxy]);
			React.useEffect(() => {
				if (!fallback && config.fallbackProxy) setFallback(config.fallbackProxy);
			}, [config.fallbackProxy]);

			const pendingProxy = tab === "proxy" && mode !== "proxy";
			const dotColor = !egress.online ? "var(--bad)" : info.ready ? "var(--good)" : "var(--warn)";
			const detail = !egress.online
				? "egress shim is not running"
				: pendingProxy
					? "прокси не включён — впиши адрес и сохрани"
					: mode === "proxy"
						? config.proxy || "proxy url is not set"
						: mode === "vpn"
							? vpn && vpn.connected
								? (vpn.name || "tunnel is up") + (vpn.kind ? " · " + vpn.kind : "")
								: "no VPN adapter is up"
							: mode === "direct"
								? "no relay — traffic leaves as is"
								: chain.join(" › ");

			return h(
				"div",
				null,
				h(Segmented, { value: tab || mode, onChange: pick }),
				h(
					"div",
					{ className: "state" },
					h("span", { className: "dot", style: { background: dotColor, boxShadow: "0 0 8px " + dotColor } }),
					h("em", { key: detail }, detail)
				),
				(tab || mode) === "dns"
					? h(DnsPanel, {
							channels,
							active: config.route,
							chain,
							providers,
							draft: dnsDraft,
							setDraft: setDnsDraft,
							busy,
							onPatch
						})
					: null,
				(tab || mode) === "proxy"
					? h(ProxyPanel, {
							proxy,
							fallback,
							setProxy,
							setFallback,
							configured: Boolean(config.proxy || config.fallbackProxy),
							busy,
							onPatch
						})
					: null,
				h(
					"div",
					{ className: "relay" },
					h(
						"div",
						{ className: "txt" },
						h("b", null, "Relay"),
						h("span", null, info.label + " · " + (stats ? stats.proxied + " ok · " + stats.failed + " fail" : "no stats"))
					),
					h(
						"button",
						{
							className: "switch" + (mode === "direct" ? "" : " on"),
							role: "switch",
							"aria-checked": mode !== "direct",
							"aria-label": "relay",
							onClick: onToggle
						},
						h("i")
					)
				),
				note ? h("div", { className: "note" }, note) : null
			);
		}

		function GroupRow({ group }) {
			const weekly = (group.weekly || [])[0];
			const five = (group.fiveHour || [])[0];
			const pct = weekly ? pctOf(weekly.remaining) : five ? pctOf(five.remaining) : 0;
			return h(
				"div",
				{ className: "grp" },
				h(Ring, { pct }),
				h(
					"div",
					{ className: "meta" },
					h("b", { title: group.description || group.name }, group.name),
					h("span", null, weekly ? "weekly resets " + resetIn(weekly.resetAt) : five ? "5h resets " + resetIn(five.resetAt) : "no window"),
					five
						? h("span", { className: "badge", style: { color: toneOf(pctOf(five.remaining)) } }, h("i"), "5h " + pctOf(five.remaining) + "%")
						: null,
					!weekly && five ? h(Bar, { pct: pctOf(five.remaining) }) : null
				)
			);
		}

		// The bridge and the platform below it speak in exceptions: "The operation was aborted
		// due to timeout" is true and useless in a card. Known failures get a sentence a person
		// can act on; anything unrecognised is still shown, just without the stack-speak.
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

		// "4 minutes ago" is the part that makes a number trustworthy: a figure from
		// an hour ago describes an hour ago.
		function agoOf(at) {
			if (!at) return "";
			const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
			if (sec < 45) return "только что";
			const min = Math.round(sec / 60);
			if (min < 60) return min + " мин назад";
			const hours = Math.round(min / 60);
			return hours + " ч назад";
		}

		function latencyLine(account, checking, onCheck) {
			const lat = account.latency;
			return h(
				"div",
				{ className: "lat" },
				h("span", null, "ответ"),
				lat ? h("b", null, (lat.ms / 1000).toFixed(1) + " с") : h("b", { className: "none" }, "—"),
				h("span", { className: "when" }, lat ? agoOf(lat.at) : "нет замера"),
				account.requests ? h("span", { className: "req" }, account.requests + " запр.") : null,
				h(
					"button",
					{
						className: "mini",
						onClick: () => onCheck(account.id),
						disabled: checking,
						title: "проверить этот аккаунт маленьким запросом"
					},
					checking ? "…" : "проверить"
				)
			);
		}

		function AccountCard({ account, pinned, onSwitch, onCheck, onRemove, checking, index = 0 }) {
			// Deleting a login is not undoable, so it takes two clicks: the glyph turns
			// into the question, and the question defuses itself after a few seconds.
			const [confirming, setConfirming] = React.useState(false);
			const [removing, setRemoving] = React.useState(false);
			const askRemove = () => {
				if (account.native) {
					setNote("аккаунт сессии удалить нельзя — это твой вход");
					return;
				}
				if (!confirming) {
					setConfirming(true);
					setTimeout(() => setConfirming(false), 4000);
					return;
				}
				setRemoving(true);
				setConfirming(false);
				onRemove(account.id);
			};
			const groups = account.groups || [];
			const models = Object.entries(account.models || {})
				.filter(([id]) => KEEP_MODEL(id))
				.sort((left, right) => left[1].fraction - right[1].fraction);
			const worst = worstOf(account);

			return h(
				"div",
				{ className: "card", style: { animationDelay: index * 45 + "ms" } },
				h(
					"div",
					{ className: "top" },
					h("span", { className: "dot", style: { background: account.ok ? toneOf(worst ?? 100) : "var(--bad)" } }),
					h(
						"div",
						{ className: "who" },
						h(
							"span",
							{ className: "mail" },
							h("b", { title: account.email || account.id }, account.email || account.id),
							h(
								"button",
								{
									className: "del" + (confirming ? " ask" : ""),
									onClick: askRemove,
									disabled: removing,
									title: account.native ? "аккаунт сессии удалить нельзя" : "удалить аккаунт",
									"aria-label": "удалить аккаунт"
								},
								removing
									? "…"
									: confirming
										? "удалить?"
										: h(
												"svg",
												{ viewBox: "0 0 10 10", width: 8, height: 8, "aria-hidden": "true" },
												h("path", {
													d: "M1.6 1.6 8.4 8.4M8.4 1.6 1.6 8.4",
													fill: "none",
													stroke: "currentColor",
													"stroke-width": 1.5,
													"stroke-linecap": "round"
												})
											)
							)
						),
						h("span", null, [account.tierName, account.native ? "session" : null, account.pinned ? "pinned" : null].filter(Boolean).join(" · ") || "account")
					),
					pinned
						? h("span", { className: "here" }, "этот")
						: h(
								"button",
								{
									className: "mini",
									onClick: () => onSwitch(account.id),
									title: "перевести следующие запросы на этот аккаунт"
								},
								"переключить"
							)
				),
				latencyLine(account, checking, onCheck),
				!account.ok
					? h("div", { className: "err" }, explainError(account.error) || "недоступен")
					: groups.length
						? h("div", null, groups.map((group, index) => h(GroupRow, { key: group.name + index, group })))
						: h("div", { className: "empty" }, "weekly quota unavailable"),
				account.ok && models.length
					? h(
							"div",
							{ className: "rows" },
							models.slice(0, 3).map(([id, value]) =>
								h(
									"div",
									{ className: "row", key: id },
									h("span", { className: "nm", title: id }, id),
									h("span", { className: "pct" }, pctOf(value.fraction) + "%"),
									h("span", { className: "nm", style: { flex: "0 0 auto", opacity: 0.5 } }, resetIn(value.resetTime))
								)
							)
						)
					: null
			);
		}

		/* ---------------------------------------------------------------- widget */

		function AgQuotaWidget() {
			const [open, setOpen] = React.useState(() => {
				try {
					return localStorage.getItem(OPEN_KEY) === "1";
				} catch {
					return false;
				}
			});
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState("");
			const { data, error, loading, load } = useLimits();
			const egress = useEgress();

			const accounts = (data && data.accounts) || [];
			const primary = accounts.find((account) => account.pinned) || accounts[0];
			const weekly = primary ? weeklyOf(primary) : null;
			const worst = primary ? worstOf(primary) : null;
			const health = error ? "var(--bad)" : worst === null ? "var(--muted)" : toneOf(worst);

			const [closing, setClosing] = React.useState(false);

			// Closing plays out before unmounting: a panel that vanishes on click reads as a
			// glitch, one that steps back reads as an answer.
			const toggle = () => {
				const persist = (value) => {
					try {
						localStorage.setItem(OPEN_KEY, value);
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

			const patch = async (body, label) => {
				setBusy(true);
				setNote("");
				try {
					const res = await getJson(EGRESS + "/", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(12000)
					});
					if (!res.ok) setNote((res.json && res.json.error) || "rejected");
					else {
						egress.setState(res.json);
						setNote(label || "");
					}
				} catch {
					setNote("egress shim unreachable");
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
				patch({ mode });
			};

			const toggleRelay = () => {
				const current = (egress.state && egress.state.mode) || "dns";
				if (current !== "direct") return patch({ mode: "direct" });
				let restore = "dns";
				try {
					restore = localStorage.getItem(MODE_KEY) || "dns";
				} catch {}
				return patch({ mode: restore });
			};

			const test = async () => {
				setBusy(true);
				setNote("asking the model…");
				try {
					const res = await getJson(BRIDGE + "/v1/chat/completions", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: "gemini-3.8-flash",
							messages: [{ role: "user", content: "ping" }],
							max_tokens: 8,
							stream: false
						}),
						signal: AbortSignal.timeout(120000)
					});
					if (res.ok) setNote("route works — the model answered");
					else if (/location is not supported/i.test(JSON.stringify(res.json || {}))) setNote("geoblocked from this egress");
					else setNote(((res.json || {}).error || {}).message || "HTTP " + res.status);
				} catch {
					setNote("мост не отвечает");
				}
				setBusy(false);
				egress.reload();
			};

			// Switching is a decision, not a preference: pin, drop the cooldowns that
			// account collected, and let the bridge answer with the order it will use.
			const switchAccount = async (id) => {
				try {
					const res = await fetch(BRIDGE + "/accounts/switch", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id })
					});
					const json = await res.json().catch(() => ({}));
					if (json && json.ok) setNote("переключено: " + (json.order && json.order[0] ? json.order[0] : id));
					else setNote("мост не принял переключение");
				} catch {
					setNote("мост не отвечает");
				}
				load(true);
			};

			const removeAccount = async (id) => {
				try {
					const res = await fetch(BRIDGE + "/accounts/remove", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id })
					});
					const json = await res.json().catch(() => ({}));
					if (res.ok) setNote("аккаунт удалён");
					else setNote(explainError(json.error && json.error.message ? json.error.message : "не удалось удалить") );
				} catch {
					setNote("мост не отвечает");
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
						body: JSON.stringify({ id })
					});
					const json = await res.json().catch(() => ({}));
					if (json && json.ok) setNote("замер: " + (json.ms / 1000).toFixed(1) + " с");
					else setNote("замер не вышел: " + explainError(json.error || ""));
				} catch {
					setNote("мост не отвечает");
				}
				setChecking(null);
				load(true);
			};

			const addAccount = async () => {
				try {
					const res = await getJson(BRIDGE + "/accounts/login", { method: "POST" });
					if (res.json && res.json.url) window.open(res.json.url, "_blank", "noopener");
				} catch {}
			};

			return h(
				"div",
				{ className: "agq", style: { position: "fixed", right: 14, bottom: 14, zIndex: 60, display: "flex", flexDirection: "column", alignItems: "flex-end" } },
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
									h("h1", null, "Antigravity"),
									primary && primary.tierName ? h("span", { className: "chip" }, primary.tierName) : null,
									h(
										"button",
										{
											className: "icon" + (loading ? " is-busy" : ""),
											onClick: () => load(true),
											disabled: loading,
											title: "обновить",
											"aria-label": "обновить"
										},
										h(
											"svg",
											{ viewBox: "0 0 16 16", width: 13, height: 13, "aria-hidden": "true" },
											h("path", {
												d: "M12.9 8a4.9 4.9 0 1 1-1.5-3.5",
												fill: "none",
												stroke: "currentColor",
												"stroke-width": 1.5,
												"stroke-linecap": "round"
											}),
											h("path", {
												d: "M13.2 2.9v2.8H10.4",
												fill: "none",
												stroke: "currentColor",
												"stroke-width": 1.5,
												"stroke-linecap": "round",
												"stroke-linejoin": "round"
											})
										)
									)
								),
								h(
								"div",
								{ className: "scroll" },
h(Transport, {
									egress,
									busy,
									note,
									onMode: setMode,
									onToggle: toggleRelay,
									onPatch: patch
								}),
								h("div", { className: "sect" }, "accounts"),
								accounts.length
									? accounts.map((account, index) =>
											h(AccountCard, {
												key: account.id,
												index,
												account,
												pinned: account.id === (data && data.pinned),
												onSwitch: switchAccount,
							onCheck: checkAccount,
							onRemove: removeAccount,
							checking: checking === account.id
											})
										)
									: h("div", { className: "empty" }, error ? "bridge unreachable" : "no accounts"),
							),
								h(
									"div",
									{ className: "foot" },
									h("button", { className: "btn wide", onClick: addAccount }, "+ аккаунт"),
									h("button", { className: "btn", onClick: test, disabled: busy }, busy ? "…" : "маршрут"),
									h("button", { className: "btn", onClick: toggle }, "скрыть")
								)
							)
						)
					: null,
				h(
					"div",
					{ className: "pill", onClick: toggle, title: error ? error : "Antigravity quota" },
					// Collapsed is one glance: how much is left, and whether the bridge is there. The
					// ring carries the same number, the caption carries the state.
					h(Ring, { pct: weekly ? pctOf(weekly.remaining) : worst ?? 0, size: 26, bare: true, thin: true }),
					h(
						"span",
						null,
						h("b", null, error ? "off" : weekly ? pctOf(weekly.remaining) + "%" : worst === null ? "—" : worst + "%"),
						h(
							"span",
							{ className: "cap" },
							h("i", {
								className: "st",
								style: {
									background: error ? "var(--bad)" : weekly ? "var(--good)" : "var(--warn)",
									color: error ? "var(--bad)" : weekly ? "var(--good)" : "var(--warn)"
								}
							}),
							"Gemini bridge"
						)
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