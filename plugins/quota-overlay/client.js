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
.agq button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.agq .pill{display:flex;align-items:center;gap:9px;padding:7px 12px 7px 9px;border-radius:999px;
	background:linear-gradient(180deg,rgba(30,30,42,.96),rgba(16,16,22,.96));
	border:1px solid var(--line-strong);box-shadow:0 10px 30px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
	transition:transform .16s ease,box-shadow .16s ease}
.agq .pill:hover{transform:translateY(-1px);box-shadow:0 14px 36px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.09)}
.agq .pill b{display:block;font-size:12px;font-weight:600;letter-spacing:.01em;font-variant-numeric:tabular-nums;line-height:1.15}
.agq .pill span.sub{display:block;font-size:9px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.agq .panel{width:348px;max-width:calc(100vw - 28px);max-height:min(74vh,640px);overflow:auto;overscroll-behavior:contain;
	margin-bottom:10px;border-radius:18px;padding:2px;
	background:linear-gradient(160deg,rgba(139,92,246,.35),rgba(34,211,238,.18) 42%,transparent 70%);
	box-shadow:0 26px 70px rgba(0,0,0,.65)}
.agq .panel-in{border-radius:16px;padding:14px 14px 12px;background:
	radial-gradient(120% 90% at 100% 0%,rgba(139,92,246,.10),transparent 55%),
	linear-gradient(180deg,rgba(19,19,27,.99),rgba(12,12,17,.99))}
.agq .panel-in::-webkit-scrollbar{width:6px}
.agq .panel-in::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:99px}
.agq .head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.agq .mark{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-size:11px;font-weight:700;
	background:linear-gradient(135deg,var(--a),var(--b));color:#08080c;box-shadow:0 4px 14px rgba(139,92,246,.45)}
.agq .head h1{font-size:12.5px;font-weight:600;letter-spacing:.02em;margin:0}
.agq .chip{font-size:9.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
	border:1px solid var(--line);border-radius:99px;padding:2px 7px}
.agq .icon{margin-left:auto;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;
	border:1px solid var(--line);color:var(--muted);transition:.15s}
.agq .icon:hover{color:var(--text);border-color:var(--line-strong);background:rgba(255,255,255,.04)}
.agq .icon.busy{animation:agq-spin 1s linear infinite;color:var(--b)}
@keyframes agq-spin{to{transform:rotate(360deg)}}
.agq .seg{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;padding:3px;border-radius:12px;
	background:rgba(255,255,255,.04);border:1px solid var(--line)}
.agq .seg button{padding:7px 0;border-radius:9px;font-size:11px;font-weight:500;color:var(--muted);
	transition:.15s;letter-spacing:.01em}
.agq .seg button:hover{color:var(--text);background:rgba(255,255,255,.05)}
.agq .seg button.on{color:#0a0a10;font-weight:600;
	background:linear-gradient(135deg,#8b5cf6,#22d3ee);box-shadow:0 6px 18px rgba(139,92,246,.45),inset 0 1px 0 rgba(255,255,255,.25)}
.agq .state{display:flex;align-items:center;gap:7px;margin:9px 2px 0;font-size:11px;color:var(--muted)}
.agq .dot{width:6px;height:6px;border-radius:99px;flex:0 0 auto}
.agq .state em{font-style:normal;color:var(--text);opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.agq .sect{display:flex;align-items:center;gap:8px;margin:14px 2px 8px;font-size:9.5px;
	letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.agq .sect:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.agq .card{border:1px solid var(--line);border-radius:13px;padding:10px 11px;margin-bottom:8px;
	background:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,.008))}
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
.agq .ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:10px;font-weight:600;
	letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.agq .rows{margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.06)}
.agq .row{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--muted);padding:2px 0}
.agq .row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);opacity:.72}
.agq .row .pct{font-variant-numeric:tabular-nums}
.agq .empty{font-size:10.5px;color:var(--muted);padding:2px 0}
.agq .err{font-size:10.5px;color:var(--bad);padding:2px 0;word-break:break-word}
.agq .foot{display:flex;gap:6px;margin-top:10px;position:sticky;bottom:-12px;padding:10px 0 12px;
	background:linear-gradient(180deg,rgba(12,12,17,0),rgba(12,12,17,.92) 40%,rgba(12,12,17,.99))}
.agq .btn{flex:1;border:1px solid var(--line-strong);border-radius:9px;padding:7px 8px;font-size:11px;
	color:var(--text);background:rgba(255,255,255,.03);transition:.15s}
.agq .btn:hover{background:rgba(255,255,255,.07)}
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
				const timer = setInterval(load, 15000);
				return () => clearInterval(timer);
			}, [load]);

			return { state, online, reload: load, setState };
		}

		/* ---------------------------------------------------------------- atoms */

		function Ring({ pct, size = 46, bare = false }) {
			const box = size;
			const radius = box / 2 - 4.5;
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
					h("circle", { cx: center, cy: center, r: radius, fill: "none", stroke: "rgba(255,255,255,.09)", strokeWidth: 3 }),
					h("circle", {
						cx: center,
						cy: center,
						r: radius,
						fill: "none",
						stroke: color,
						strokeWidth: 3,
						strokeLinecap: "round",
						strokeDasharray: circumference,
						strokeDashoffset: circumference - filled,
						style: { transition: "stroke-dashoffset .5s cubic-bezier(.3,.8,.4,1)" }
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
			return h(
				"div",
				{ className: "seg", role: "tablist" },
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

		function Transport({ egress, onMode, onToggle, onProxy, onTest, busy, note }) {
			const state = egress.state;
			const mode = (state && state.mode) || "dns";
			const info = (state && state.modeInfo) || { label: mode, detail: "", ready: false };
			const vpn = (state && state.vpn) || null;
			const stats = (state && state.stats) || null;
			const proxyValue = (state && state.config && state.config.proxy) || "";

			const [draft, setDraft] = React.useState("");
			React.useEffect(() => {
				if (proxyValue) setDraft("");
			}, [proxyValue]);

			const dotColor = !egress.online ? "var(--bad)" : info.ready ? "var(--good)" : "var(--warn)";
			const detail = !egress.online
				? "egress shim is not running"
				: mode === "proxy"
					? proxyValue || "proxy url is not set"
					: mode === "vpn"
						? vpn && vpn.connected
							? (vpn.name || "tunnel is up") + (vpn.kind ? " · " + vpn.kind : "")
							: "no VPN adapter is up"
						: mode === "direct"
							? "no relay — traffic leaves as is"
							: (state && state.chain ? state.chain.join(" › ") : "");

			return h(
				"div",
				null,
				h(Segmented, { value: mode, onChange: onMode }),
				h("div", { className: "state" }, h("span", { className: "dot", style: { background: dotColor, boxShadow: "0 0 8px " + dotColor } }), h("em", null, detail)),
				h(
					"div",
					{ className: "relay" },
					h(
						"div",
						{ className: "txt" },
						h("b", null, "Relay"),
						h("span", null, info.label + " · " + (stats ? stats.proxied + " ok · " + stats.failed + " fail" : "no stats"))
					),
					h("button", {
						className: "switch" + (mode === "direct" ? "" : " on"),
						role: "switch",
						"aria-checked": mode !== "direct",
						"aria-label": "relay",
						onClick: onToggle
					}, h("i"))
				),
				mode === "proxy"
					? h(
							"div",
							null,
							h("input", {
								className: "input",
								placeholder: proxyValue || "socks5://127.0.0.1:1080",
								value: draft,
								onChange: (event) => setDraft(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && draft.trim()) onProxy(draft.trim());
								}
							}),
							h(
								"div",
								{ className: "foot" },
								h("button", { className: "btn wide", disabled: busy || !draft.trim(), onClick: () => draft.trim() && onProxy(draft.trim()) }, "save proxy"),
								h("button", { className: "btn", disabled: busy, onClick: () => onProxy("") }, "clear")
							)
						)
					: null,
				note || stats
					? h("div", { className: "note" }, note || (stats.lastError ? "last error: " + stats.lastError : "last: " + (stats.lastHost || "—")))
					: null
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

		function AccountCard({ account, pinned, onPin }) {
			const groups = account.groups || [];
			const models = Object.entries(account.models || {})
				.filter(([id]) => KEEP_MODEL(id))
				.sort((left, right) => left[1].fraction - right[1].fraction);
			const worst = worstOf(account);

			return h(
				"div",
				{ className: "card" },
				h(
					"div",
					{ className: "top" },
					h("span", { className: "dot", style: { background: account.ok ? toneOf(worst ?? 100) : "var(--bad)" } }),
					h(
						"div",
						{ className: "who" },
						h("b", { title: account.email || account.id }, account.email || account.id),
						h("span", null, [account.tierName, account.native ? "session" : null, account.pinned ? "pinned" : null].filter(Boolean).join(" · ") || "account")
					),
					pinned
						? null
						: h("button", { className: "mini", onClick: () => onPin(account.id), title: "serve this account first" }, "pin")
				),
				!account.ok
					? h("div", { className: "err" }, account.error || "unavailable")
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

			const toggle = () =>
				setOpen((value) => {
					try {
						localStorage.setItem(OPEN_KEY, value ? "0" : "1");
					} catch {}
					return !value;
				});

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

			const saveProxy = (url) => patch(url ? { proxy: url, mode: "proxy" } : { proxy: "" });

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
					setNote("bridge unreachable");
				}
				setBusy(false);
				egress.reload();
			};

			const pin = async (id) => {
				try {
					await fetch(BRIDGE + "/accounts/pin", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id })
					});
				} catch {}
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
							{ className: "panel" },
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
										{ className: "icon" + (loading ? " busy" : ""), onClick: () => load(true), disabled: loading, title: "refresh" },
										"⟳"
									)
								),
								h(Transport, {
									egress,
									busy,
									note,
									onMode: setMode,
									onToggle: toggleRelay,
									onProxy: saveProxy,
									onTest: test
								}),
								h("div", { className: "sect" }, "accounts"),
								accounts.length
									? accounts.map((account) =>
											h(AccountCard, {
												key: account.id,
												account,
												pinned: account.id === (data && data.pinned),
												onPin: pin
											})
										)
									: h("div", { className: "empty" }, error ? "bridge unreachable" : "no accounts"),
								h(
									"div",
									{ className: "foot" },
									h("button", { className: "btn wide", onClick: addAccount }, "add account"),
									h("button", { className: "btn", onClick: test, disabled: busy }, busy ? "…" : "test route"),
									h("button", { className: "btn", onClick: toggle }, "hide")
								)
							)
						)
					: null,
				h(
					"div",
					{ className: "pill", onClick: toggle, title: error ? error : "Antigravity quota" },
					h(Ring, { pct: weekly ? pctOf(weekly.remaining) : worst ?? 0, size: 34, bare: true }),
					h(
						"span",
						null,
						h("b", null, error ? "offline" : weekly ? pctOf(weekly.remaining) + "%" : worst === null ? "—" : worst + "%"),
						h("span", { className: "sub" }, error ? "no bridge" : weekly ? "weekly" : "5h")
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