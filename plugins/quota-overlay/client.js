window.__ModuleLoader__.load({
	id: "dsh-plugin-ag-limits",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		// Endpoints come from the plugin config (`bridgeUrl`, `egressUrl`); the
		// loopback defaults keep a bare install working.
		const DEFAULT_BRIDGE = "http://127.0.0.1:8787";
		const DEFAULT_EGRESS = "http://127.0.0.1:8789";
		let BRIDGE = DEFAULT_BRIDGE;
		let EGRESS = DEFAULT_EGRESS;
		let SECRET = "local-bridge";
		const secret = () => SECRET;
		const REFRESH_MS = 30000;
		const OPEN_KEY = "ag-limits:open";

		const styles = {
			root: {
				position: "fixed",
				right: 14,
				bottom: 14,
				zIndex: 60,
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-end",
				pointerEvents: "auto",
				font: "12px/1.45 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
				color: "#e7e7ea"
			},
			pill: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 11px",
				borderRadius: 999,
				background: "rgba(22,22,28,.92)",
				border: "1px solid rgba(255,255,255,.14)",
				boxShadow: "0 6px 24px rgba(0,0,0,.4)",
				cursor: "pointer",
				userSelect: "none"
			},
			dot: (color) => ({
				width: 7,
				height: 7,
				borderRadius: 999,
				background: color,
				boxShadow: "0 0 8px " + color
			}),
			label: { fontSize: 11, letterSpacing: ".03em", opacity: 0.85, fontVariantNumeric: "tabular-nums" },
			panel: {
				width: 306,
				maxHeight: "60vh",
				overflowY: "auto",
				marginBottom: 8,
				padding: "10px 12px",
				borderRadius: 12,
				background: "rgba(20,20,26,.97)",
				border: "1px solid rgba(255,255,255,.14)",
				boxShadow: "0 14px 44px rgba(0,0,0,.55)"
			},
			head: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				marginBottom: 6
			},
			title: { fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.55 },
			account: { paddingTop: 7, marginTop: 7, borderTop: "1px solid rgba(255,255,255,.08)" },
			mail: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 5 },
			mailText: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 },
			tier: { fontSize: 10, opacity: 0.5, whiteSpace: "nowrap" },
			row: { display: "flex", alignItems: "center", gap: 7, margin: "3px 0" },
			name: {
				flex: "0 0 138px",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontSize: 11,
				opacity: 0.82
			},
			track: { flex: 1, height: 4, borderRadius: 999, background: "rgba(255,255,255,.1)", overflow: "hidden" },
			fill: (color, pct) => ({
				width: Math.max(2, Math.min(100, pct)) + "%",
				height: "100%",
				background: color,
				borderRadius: 999
			}),
			pct: { flex: "0 0 32px", textAlign: "right", fontSize: 11, fontVariantNumeric: "tabular-nums", opacity: 0.85 },
			btn: {
				border: "1px solid rgba(255,255,255,.16)",
				background: "transparent",
				color: "inherit",
				borderRadius: 7,
				padding: "2px 8px",
				fontSize: 11,
				cursor: "pointer",
				lineHeight: 1.5
			},
			foot: { display: "flex", gap: 6, marginTop: 10 },
			error: { color: "#f87171", fontSize: 11, marginTop: 6 },
			empty: { fontSize: 11, opacity: 0.6 }
		};

		const pctOf = (fraction) => Math.round((typeof fraction === "number" ? fraction : 0) * 100);
		const toneOf = (pct) => (pct > 50 ? "#4ade80" : pct > 20 ? "#fbbf24" : "#f87171");

		function resetIn(iso) {
			if (!iso) return "";
			const at = Date.parse(iso);
			if (!Number.isFinite(at)) return "";
			const minutes = Math.round((at - Date.now()) / 60000);
			if (minutes <= 0) return "now";
			if (minutes < 60) return minutes + "m";
			const hours = Math.floor(minutes / 60);
			return hours + "h " + (minutes % 60) + "m";
		}

		function worstOf(account) {
			if (!account || !account.models) return null;
			let worst = null;
			for (const value of Object.values(account.models)) {
				const pct = pctOf(value.fraction);
				if (worst === null || pct < worst) worst = pct;
			}
			return worst;
		}

		function useLimits() {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(false);

			const load = React.useCallback(async (force) => {
				setLoading(true);
				try {
					const res = await fetch(BRIDGE + "/limits" + (force ? "?force=1" : ""), { cache: "no-store" });
					if (!res.ok) throw new Error("bridge " + res.status);
					setData(await res.json());
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
				}, REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [load]);

			return { data, error, loading, load };
		}

		function ModelRow({ id, value }) {
			const pct = pctOf(value.fraction);
			return h(
				"div",
				{ style: styles.row, title: value.resetTime ? "resets in " + resetIn(value.resetTime) : undefined },
				h("span", { style: styles.name }, id),
				h("span", { style: styles.track }, h("span", { style: styles.fill(toneOf(pct), pct) })),
				h("span", { style: styles.pct }, pct + "%")
			);
		}

		function AccountBlock({ account, onPin, pinned }) {
			const models = Object.entries(account.models || {}).sort((a, b) => a[1].fraction - b[1].fraction);
			return h(
				"div",
				{ style: styles.account },
				h(
					"div",
					{ style: styles.mail },
					h("span", { style: styles.dot(account.ok ? toneOf(worstOf(account) ?? 100) : "#f87171") }),
					h("span", { style: styles.mailText }, account.email || account.id),
					account.tierName ? h("span", { style: styles.tier }, account.tierName) : null,
					pinned
						? null
						: h(
								"button",
								{ style: styles.btn, onClick: () => onPin(account.id), title: "serve this account first" },
								"pin"
							)
				),
				account.ok
					? models.length
						? models.map(([id, value]) => h(ModelRow, { key: id, id, value }))
						: h("div", { style: styles.empty }, "no quota reported")
					: h("div", { style: styles.error }, account.error || "unavailable")
			);
		}

		function RoutePanel() {
			const [state, setState] = React.useState(null);
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState("");
			const [note, setNote] = React.useState("");

			const load = async () => {
				try {
					const res = await fetch(EGRESS + "/", { cache: "no-store", signal: AbortSignal.timeout(5000) });
					setState(await res.json());
				} catch {
					setState(null);
				}
			};

			React.useEffect(() => {
				load();
				const timer = setInterval(load, 30000);
				return () => clearInterval(timer);
			}, []);

			const save = async (value) => {
				setBusy("save");
				setNote("");
				try {
					const res = await fetch(EGRESS + "/", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ proxy: value })
					});
					const json = await res.json();
					if (!res.ok) {
						setNote(json.error || "rejected");
					} else {
						setState(json);
						setDraft("");
						setNote(value ? "saved — now test it" : "saved — direct again");
					}
				} catch {
					setNote("egress shim unreachable");
				}
				setBusy("");
			};

			const test = async () => {
				setNote("asking the model…");
				try {
					const res = await fetch(BRIDGE + "/v1/chat/completions", {
						method: "POST",
						headers: { "content-type": "application/json", authorization: "Bearer " + secret() },
						body: JSON.stringify({
							model: "gemini-3.8-flash",
							messages: [{ role: "user", content: "ping" }],
							max_tokens: 8,
							stream: false
						})
					});
					const json = await res.json().catch(() => ({}));
					if (res.ok) setNote("route works — the model answered");
					else if (/location is not supported/i.test(JSON.stringify(json))) setNote("still geoblocked from this egress");
					else setNote((json.error && json.error.message) || "HTTP " + res.status);
				} catch {
					setNote("bridge unreachable");
				}
				setBusy("");
				load();
			};

			const config = (state && state.config) || null;
			const stats = (state && state.stats) || null;
			const route = !config ? "unknown" : config.route || (config.proxy ? "proxy" : "direct");

			return h(
				"div",
				{ style: routeStyles.block },
				h(
					"div",
					{ style: routeStyles.row },
					h("span", { style: routeStyles.label }, "egress"),
					h("span", { style: routeStyles.value, title: route }, route),
					h("button", { style: styles.btn, onClick: test, disabled: busy !== "" }, busy === "test" ? "…" : "test")
				),
				h(
					"div",
					{ style: routeStyles.row },
					h("input", {
						style: routeStyles.input,
						placeholder: "socks5://127.0.0.1:1080 or http://host:port",
						value: draft,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter" && draft.trim()) save(draft.trim());
						}
					}),
					h("button", { style: styles.btn, onClick: () => draft.trim() && save(draft.trim()), disabled: busy !== "" }, "save"),
					h("button", { style: styles.btn, onClick: () => save(""), disabled: busy !== "" }, "off")
				),
				h(
					"div",
					{ style: routeStyles.hint },
					note ||
						(stats
							? `via proxy ${stats.proxied} · direct ${stats.direct} · failed ${stats.failed}${
									stats.lastError ? ` · ${stats.lastError}` : ""
								}`
							: "egress shim not running")
				)
			);
		}

		const routeStyles = {
			block: { borderTop: "1px solid #26262b", marginTop: 8, paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 },
			row: { display: "flex", alignItems: "center", gap: 6 },
			label: { fontSize: 11, color: "#8b8b93", textTransform: "uppercase", letterSpacing: "0.04em" },
			value: { flex: 1, fontSize: 12, color: "#e6e6ea", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			input: {
				flex: 1,
				minWidth: 0,
				background: "#17171a",
				border: "1px solid #2c2c33",
				borderRadius: 6,
				color: "#e6e6ea",
				fontSize: 12,
				padding: "4px 6px"
			},
			hint: { fontSize: 11, color: "#8b8b93", lineHeight: 1.4, wordBreak: "break-word" }
		};

		function AgQuotaWidget() {
			const [open, setOpen] = React.useState(() => {
				try {
					return localStorage.getItem(OPEN_KEY) === "1";
				} catch {
					return false;
				}
			});
			const { data, error, loading, load } = useLimits();

			const accounts = (data && data.accounts) || [];
			const primary = accounts.find((a) => a.pinned) || accounts[0];
			const worst = primary ? worstOf(primary) : null;
			const color = error ? "#f87171" : worst === null ? "#8b8b93" : toneOf(worst);

			const toggle = () =>
				setOpen((value) => {
					try {
						localStorage.setItem(OPEN_KEY, value ? "0" : "1");
					} catch {}
					return !value;
				});

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
					const res = await fetch(BRIDGE + "/accounts/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
					const json = await res.json();
					if (json && json.url) window.open(json.url, "_blank", "noopener");
				} catch {}
			};

			return h(
				"div",
				{ style: styles.root },
				open
					? h(
							"div",
							{ style: styles.panel },
							h(
								"div",
								{ style: styles.head },
								h("span", { style: styles.title }, "Antigravity quota"),
								h(
									"button",
									{ style: styles.btn, onClick: () => load(true), disabled: loading },
									loading ? "…" : "refresh"
								)
							),
							accounts.length
								? accounts.map((account) =>
										h(AccountBlock, {
											key: account.id,
											account,
											pinned: account.id === (data && data.pinned),
											onPin: pin
										})
									)
								: h("div", { style: styles.empty }, error ? "bridge unreachable" : "no accounts"),
							h(
								"div",
								{ style: styles.foot },
								h("button", { style: styles.btn, onClick: addAccount }, "add account"),
								h("button", { style: styles.btn, onClick: toggle }, "hide")
							),
							h(RoutePanel)
						)
					: null,
				h(
					"div",
					{ style: styles.pill, onClick: toggle, title: error ? error : "Antigravity quota" },
					h("span", { style: styles.dot(color) }),
					h(
						"span",
						{ style: styles.label },
						error ? "AG offline" : "AG " + (worst === null ? "—" : worst + "%")
					)
				)
			);
		}

		const inject = ["slots"];

		function apply(ctx, pluginConfig) {
			// `ctx.config` is the web-side shape; the config argument is what a DSH
			// profile patch passes. Either one may be absent.
			let config = pluginConfig || {};
			try {
				if (ctx && ctx.config) config = ctx.config;
			} catch {
				/* ctx.config is optional */
			}
			if (typeof config.bridgeUrl === "string" && config.bridgeUrl) BRIDGE = config.bridgeUrl;
			if (typeof config.egressUrl === "string" && config.egressUrl) EGRESS = config.egressUrl;
			if (typeof config.bridgeSecret === "string" && config.bridgeSecret) SECRET = config.bridgeSecret;
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "ag-limits", order: 900 }, AgQuotaWidget)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});