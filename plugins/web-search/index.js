// Web search for DSH: keyed providers in front, DuckDuckGo behind them.
//
// Registers into the same `ctx.web` seam as the bundled DeepSeek provider, so the
// `web_search` tool, its maxResults cap and its error envelope stay untouched.
//
// Order of preference:
//   1. any keyed API configured in ~/.dsh/search.json (serper, tavily, brave,
//      google-cse, exa) — JSON, fast, no scraping
//   2. DuckDuckGo HTML — keyless, but it throttles unknown IPs hard, so it is
//      cached, single-flighted, paced and cooled down after a challenge
//
// Why the pacing exists: measured on this machine, DuckDuckGo answers one or two
// anonymous queries and then serves its 202 "anomaly" page for minutes however
// politely you ask — node fetch and curl both get the same verdict, so it is the
// IP, not the TLS fingerprint. Everything below exists to make that limit stop
// mattering: cached repeats cost nothing, only one live query flies at a time, and
// after a challenge the provider stays quiet instead of burning the window again.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

// Config file: DSH_SEARCH_CONFIG wins, then the per-user default under the home dir.
const CONFIG_HINT = process.env.DSH_SEARCH_CONFIG ? "$DSH_SEARCH_CONFIG" : "~/.dsh/search.json";
const CONFIG_FILE =
  (process.env.DSH_SEARCH_CONFIG ?? "").trim() || path.join(os.homedir(), ".dsh", "search.json");
const CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_TTL_MS = 60 * 1000;
const CACHE_MAX = 300;
const MIN_LIVE_INTERVAL_MS = 4000;
const BURST_TOKENS = Number(process.env.DSH_SEARCH_BURST) || 2;
const TOKEN_INTERVAL_MS = Number(process.env.DSH_SEARCH_INTERVAL_MS) || 8000;
const MAX_TOKEN_WAIT_MS = 1500;
const PROXY_BURST_TOKENS = Number(process.env.DSH_SEARCH_PROXY_BURST) || 3;
const PROXY_TOKEN_INTERVAL_MS = Number(process.env.DSH_SEARCH_PROXY_INTERVAL_MS) || 2500;
const CHALLENGE_COOLDOWN_MS = 90 * 1000;
const ATTEMPT_TIMEOUT_MS = 8000;
const WEB_BUDGET_MS = 4500;
const WEB_BUDGET_PROXIED_MS = 10000;
const MAX_SOURCES = 20;
const PROVIDER_ID = "web-search";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"
];

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "'" };

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

function toText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG wraps every hit as //duckduckgo.com/l/?uddg=<encoded destination>. */
function unwrapUrl(href) {
  const value = decodeEntities(href);
  const match = value.match(/[?&]uddg=([^&]+)/);
  if (match !== null) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return value.startsWith("//") ? `https:${value}` : value;
}

const TRACKING = /^(utm_|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$|ref_src$|igshid$)/i;
const SEARCH_HOSTS = /(^|\.)(duckduckgo|mojeek|bing|google|yandex|searx|startpage|ecosia|brave)\.[a-z.]{2,}$/;

function canonicalUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (SEARCH_HOSTS.test(host)) return null;
  for (const key of [...parsed.searchParams.keys()]) if (TRACKING.test(key)) parsed.searchParams.delete(key);
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const search = parsed.searchParams.toString();
  return `${parsed.protocol}//${host.replace(/^www\./, "")}${path}${search ? `?${search}` : ""}`;
}

/** Drop noise, dedupe by canonical url, keep the engine's ranking. */
export function tidySources(list, limit = MAX_SOURCES) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (out.length >= limit) break;
    const url = canonicalUrl(item.url ?? "");
    if (!url || seen.has(url)) continue;
    const title = toText(item.title ?? "");
    const snippet = toText(item.snippet ?? "");
    if (!title && !snippet) continue;
    seen.add(url);
    out.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return out;
}

function providerError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = "WEB_PROVIDER_ERROR";
  return error;
}

/* ------------------------------------------------------------------ config */

const KEYED = ["serper", "tavily", "brave", "google-cse", "exa"];

function readConfig() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    /* no file: env only */
  }
  const providers = { ...(parsed.providers ?? {}) };
  const env = (name) => (process.env[name] ?? "").trim();
  providers.serper ??= { key: env("SERPER_API_KEY") };
  providers.tavily ??= { key: env("TAVILY_API_KEY") };
  providers.brave ??= { key: env("BRAVE_API_KEY") };
  providers.exa ??= { key: env("EXA_API_KEY") };
  providers.scraperapi ??= { key: env("SCRAPERAPI_KEY") };
  providers["google-cse"] ??= { key: env("GOOGLE_CSE_KEY"), cx: env("GOOGLE_CSE_CX") };
  // `transport.proxy` is a plain HTTP proxy the scraping requests are bounced
  // through — Cloudflare WARP in proxy mode here. It stays scoped to DuckDuckGo
  // fetches: nothing else in this process, and nothing outside it, is rerouted.
  const transport = { proxy: String(parsed.transport?.proxy ?? env("DSH_SEARCH_PROXY")).trim() };
  return { providers, order: Array.isArray(parsed.order) ? parsed.order : [], transport };
}

function configured(providers, id) {
  const entry = providers[id];
  if (!entry?.key) return false;
  if (id === "google-cse") return Boolean(entry.cx);
  return true;
}

/* --------------------------------------------------------------- providers */

const adapters = {
  async serper(query, max, entry, signal) {
    const res = await fetch(`${entry.baseUrl ?? "https://google.serper.dev"}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": entry.key },
      body: JSON.stringify({ q: query, num: Math.min(max, 20) }),
      signal
    });
    if (!res.ok) throw new Error(`serper HTTP ${res.status}`);
    const json = await res.json();
    return (json.organic ?? []).map((item) => ({ url: item.link, title: item.title, snippet: item.snippet }));
  },

  async tavily(query, max, entry, signal) {
    const res = await fetch(`${entry.baseUrl ?? "https://api.tavily.com"}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${entry.key}` },
      body: JSON.stringify({ query, max_results: Math.min(max, 20), search_depth: "basic" }),
      signal
    });
    if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
    const json = await res.json();
    return (json.results ?? []).map((item) => ({ url: item.url, title: item.title, snippet: item.content }));
  },

  async brave(query, max, entry, signal) {
    const url = new URL(`${entry.baseUrl ?? "https://api.search.brave.com"}/res/v1/web/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(max, 20)));
    const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": entry.key }, signal });
    if (!res.ok) throw new Error(`brave HTTP ${res.status}`);
    const json = await res.json();
    return ((json.web ?? {}).results ?? []).map((item) => ({ url: item.url, title: item.title, snippet: item.description }));
  },

  "google-cse": async (query, max, entry, signal) => {
    const url = new URL(`${entry.baseUrl ?? "https://www.googleapis.com"}/customsearch/v1`);
    url.searchParams.set("key", entry.key);
    url.searchParams.set("cx", entry.cx);
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(Math.min(max, 10)));
    const res = await fetch(url, { headers: { accept: "application/json" }, signal });
    if (!res.ok) throw new Error(`google-cse HTTP ${res.status}`);
    const json = await res.json();
    return (json.items ?? []).map((item) => ({ url: item.link, title: item.title, snippet: item.snippet }));
  },

  async exa(query, max, entry, signal) {
    const res = await fetch(`${entry.baseUrl ?? "https://api.exa.ai"}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": entry.key },
      body: JSON.stringify({ query, numResults: Math.min(max, 20), contents: { text: { maxCharacters: 600 } } }),
      signal
    });
    if (!res.ok) throw new Error(`exa HTTP ${res.status}`);
    const json = await res.json();
    return (json.results ?? []).map((item) => ({ url: item.url, title: item.title, snippet: item.text }));
  },

  // Real Google results through ScraperAPI's structured endpoint. Costs 25 credits
  // and about six seconds, so it is the last web resort, not the first.
  async "google-serp"(query, max, entry, signal) {
    const url = `https://api.scraperapi.com/structured/google/search?api_key=${encodeURIComponent(entry.key)}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { accept: "application/json" }, signal });
    if (!res.ok) throw new Error(`google-serp HTTP ${res.status}`);
    const json = await res.json();
    return (json.organic_results ?? []).map((item) => ({ url: item.link, title: item.title, snippet: item.snippet }));
  }
};

/* --------------------------------------------------------------- duckduckgo */

const ddg = { lastLiveAt: 0, blockedUntil: 0, blockedAt: null };

// DuckDuckGo tolerates a couple of quick anonymous queries and then challenges, so
// the pacer is a small bucket rather than a flat delay: the first two searches are
// instant, later ones wait for a token instead of walking into a block.
const bucket = { tokens: BURST_TOKENS, at: Date.now() };

function takeToken(interval = TOKEN_INTERVAL_MS, burst = BURST_TOKENS) {
  const now = Date.now();
  const refilled = Math.floor((now - bucket.at) / interval);
  if (refilled > 0) {
    bucket.tokens = Math.min(burst, bucket.tokens + refilled);
    bucket.at += refilled * interval;
  }
  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return 0;
  }
  return interval - (now - bucket.at);
}

const isChallenge = (html, status) => status === 202 || /anomaly-modal|anomaly\.js|challenge-form/i.test(html);

/** Map a DDG HTML results page to the seam's normalized source list. */
export function parseDuckDuckGo(html, limit = MAX_SOURCES) {
  const sources = [];
  for (const chunk of html.split(/<div class="result(?: |")/).slice(1)) {
    if (sources.length >= limit) break;
    if (chunk.startsWith("result--ad")) continue;
    const linkTag = chunk.match(/<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const href = linkTag === null ? null : linkTag[0].match(/href="([^"]*)"/);
    if (linkTag === null || href === null) continue;
    const snippetTag = chunk.match(/<a\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    sources.push({
      url: unwrapUrl(href[1]),
      title: toText(linkTag[1]),
      snippet: snippetTag === null ? "" : toText(snippetTag[1])
    });
  }
  return sources;
}

/** The no-JS lite endpoint: <a class='result-link'> plus <td class='result-snippet'>. */
export function parseDuckDuckGoLite(html, limit = MAX_SOURCES) {
  const links = [...html.matchAll(/<a\b([^>]*class='result-link'[^>]*)>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g)].map((match) => toText(match[1]));
  const sources = [];
  for (const [index, match] of links.entries()) {
    if (sources.length >= limit) break;
    const href = match[1].match(/href="([^"]*)"/);
    if (href === null) continue;
    sources.push({
      url: unwrapUrl(href[1]),
      title: toText(match[2]),
      snippet: snippets[index] ?? ""
    });
  }
  return sources;
}

/**
 * GET through an HTTP proxy via CONNECT. Node's fetch has no proxy option, and
 * NODE_USE_ENV_PROXY would reroute every request the DSH process makes, so the
 * tunnel is built by hand: TCP to the proxy, CONNECT, TLS to the target, then a
 * plain HTTP/1.1 request over that socket.
 */
function fetchViaProxy(target, proxy, { signal, timeout = ATTEMPT_TIMEOUT_MS, headers = {} } = {}) {
  const url = new URL(target);
  const px = new URL(proxy);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return new Promise((resolve, reject) => {
    let socket = null;
    let timer = null;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const fail = (error) => done(reject, error instanceof Error ? error : new Error(String(error)));
    const onAbort = () => {
      socket?.destroy();
      fail(new Error("aborted"));
    };
    if (signal?.aborted === true) {
      fail(new Error("aborted"));
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      socket?.destroy();
      fail(new Error("proxy timeout"));
    }, timeout);
    timer.unref?.();

    socket = net.connect({ host: px.hostname, port: Number(px.port || 80) });
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n\r\n`);
      let head = "";
      const onHead = (chunk) => {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.removeListener("data", onHead);
        const status = Number((head.split(" ")[1] || "0").trim());
        if (status !== 200) {
          fail(new Error(`proxy CONNECT refused (${status})`));
          return;
        }
        const tunnel = url.protocol === "https:" ? tls.connect({ socket, servername: url.hostname }) : socket;
        tunnel.once("error", fail);
        const req = http.request(
          {
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: { host: url.hostname, ...headers },
            agent: false,
            createConnection: () => tunnel
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => done(resolve, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", fail);
          }
        );
        req.on("error", fail);
        req.end();
      };
      socket.on("data", onHead);
    });
  });
}

function pageHeaders() {
  return {
    "user-agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9"
  };
}

function parsePage(engine, html, status, max) {
  if (isChallenge(html, status)) {
    const error = providerError(`DuckDuckGo throttled this IP (HTTP ${status})`);
    error.throttled = true;
    throw error;
  }
  const parse = engine === "lite" ? parseDuckDuckGoLite : parseDuckDuckGo;
  const sources = parse(html, max);
  if (sources.length === 0) {
    const error = providerError("DuckDuckGo returned a page with no parseable results");
    error.throttled = true;
    throw error;
  }
  return sources;
}

async function fetchEngine(engine, query, signal, max) {
  const page = engine === "lite" ? "https://lite.duckduckgo.com/lite/" : "https://html.duckduckgo.com/html/";
  const target = `${page}?q=${encodeURIComponent(query)}`;
  const { providers, transport } = readConfig();

  // 1. The proxy tunnel (Cloudflare WARP): free and unmetered, but DuckDuckGo
  //    occasionally challenges its pool, so a throttled answer falls through to
  //    the paid transport for this one query instead of failing the search.
  let tunnelError = null;
  if (transport.proxy) {
    try {
      const res = await fetchViaProxy(target, transport.proxy, { signal, timeout: ATTEMPT_TIMEOUT_MS, headers: pageHeaders() });
      return parsePage(engine, res.body, res.status, max);
    } catch (error) {
      tunnelError = error;
      if (signal?.aborted === true) throw error;
    }
  }

  // 2. ScraperAPI: requests leave from their pool, so DuckDuckGo's IP ban never
  //    applies — one credit per search, no pacing, no cooldown.
  const key = providers.scraperapi?.key;
  if (key) {
    const url = `https://api.scraperapi.com?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(target)}`;
    const res = await fetch(url, { redirect: "follow", headers: pageHeaders(), signal });
    return parsePage(engine, await res.text(), res.status, max);
  }

  // 3. Straight out: only works from an IP DuckDuckGo has not banned.
  if (tunnelError) throw tunnelError;
  const res = await fetch(target, { redirect: "follow", headers: pageHeaders(), signal });
  return parsePage(engine, await res.text(), res.status, max);
}

async function duckDuckGo(query, max, signal) {
  const { providers, transport } = readConfig();
  const viaTunnel = Boolean(transport.proxy);
  const proxied = Boolean(providers.scraperapi?.key);
  if (!proxied) {
    if (Date.now() < ddg.blockedUntil) {
      throw providerError(
        `DuckDuckGo is cooling down after a challenge (${Math.ceil((ddg.blockedUntil - Date.now()) / 1000)}s left). ` +
          `Add a search key in ${CONFIG_HINT} for instant results.`
      );
    }
  }
  // Through the tunnel the IP is not ours, so pacing only needs to stay polite to
  // DuckDuckGo's pool — a couple of seconds apart, not the eight-second crawl the
  // bare-IP path needs.
  if (!proxied || viaTunnel) {
    const wait = viaTunnel ? takeToken(PROXY_TOKEN_INTERVAL_MS, PROXY_BURST_TOKENS) : takeToken();
    if (wait > MAX_TOKEN_WAIT_MS && !viaTunnel) {
      // Better to answer now from the free sources and let the live query land in the
      // cache afterwards than to make the model sit through the pacer.
      const deferred = providerError(`DuckDuckGo pacing: next slot in ${Math.ceil(wait / 1000)}s`);
      deferred.deferred = true;
      throw deferred;
    }
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, ATTEMPT_TIMEOUT_MS)));
  }
  ddg.lastLiveAt = Date.now();

  const stop = new AbortController();
  const outer = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  const attempt = (engine) => fetchEngine(engine, query, AbortSignal.any([outer, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]), max);

  // Start the richer page; if it is slow (>1.2s) or fails, the lite page covers it.
  let lite = null;
  const startLite = () => {
    lite ??= attempt("lite");
    lite.catch(() => {});
    return lite;
  };
  const hedge = new Promise((resolve, reject) => {
    const timer = setTimeout(() => startLite().then(resolve, reject), 1200);
    timer.unref?.();
  });

  try {
    return await Promise.race([attempt("html"), hedge]);
  } catch (error) {
    if (lite !== null) {
      try {
        return await lite;
      } catch {
        /* fall through to the reporting below */
      }
    }
    if (error?.throttled === true || error?.name === "TimeoutError") {
      // A challenge through the tunnel is the pool's problem, not this IP's:
      // no cooldown, the next query just pays a credit instead.
      if (!viaTunnel) ddg.blockedUntil = Date.now() + CHALLENGE_COOLDOWN_MS;
      ddg.blockedAt = new Date().toISOString();
      throw providerError(
        `DuckDuckGo blocked this IP (${error.message}). Paused for ${CHALLENGE_COOLDOWN_MS / 1000}s — ` +
          `a key in ${CONFIG_HINT} avoids this entirely.`
      );
    }
    throw error instanceof Error ? error : providerError(`DuckDuckGo search failed: ${String(error)}`);
  } finally {
    stop.abort();
  }
}

/* ------------------------------------------------------------ extra sources */

// Ported from the Antigravity `dynamic-research` skill: it leaned on Wikipedia,
// Hacker News and DuckDuckGo's instant answers, and that is what kept it useful
// even when the scraped endpoint was throttled. Same idea here, but each source is
// allowed to fail on its own and the whole thing still gets cached and deduped.

const DEVISH = /github|repo|commit|api|library|framework|sdk|rust|golang|c\+\+|python|javascript|typescript|docker|kubernetes|linux|kernel|protocol|compiler|database|sql|c2|exploit|reverse|packet|hook|driver|cli|npm|pip|crate/i;

function isCyrillic(text) {
  return /[а-яё]/i.test(text);
}

async function wikipedia(query, max, signal) {
  const lang = isCyrillic(query) ? "ru" : "en";
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(Math.min(max, 3)),
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exsentences: "3",
    inprop: "url",
    redirects: "1"
  }).toString();
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "dsh-web-search/1.0" }, signal });
  if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);
  const json = await res.json();
  const pages = Object.values(json.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages.slice(0, Math.min(max, 3)).map((page) => ({
    url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
    title: `Wikipedia: ${page.title}`,
    snippet: page.extract ?? ""
  }));
}

async function hackerNews(query, max, signal) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(max, 4)}&tags=story`;
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "dsh-web-search/1.0" }, signal });
  if (!res.ok) throw new Error(`hn HTTP ${res.status}`);
  const json = await res.json();
  return (json.hits ?? [])
    .filter((hit) => hit.url || hit.story_text)
    .map((hit) => ({
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      title: `HN: ${hit.title ?? hit.story_title ?? "(untitled)"}`,
      snippet: `${hit.points ?? 0} points · ${hit.created_at?.slice(0, 10) ?? "?"} · ${hit.num_comments ?? 0} comments`
    }));
}

async function instantAnswer(query, signal) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`instant HTTP ${res.status}`);
  const json = await res.json();
  const out = [];
  if (json.AbstractText) {
    out.push({
      url: json.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      title: `DuckDuckGo: ${json.Heading || query}`,
      snippet: json.AbstractText
    });
  }
  for (const topic of (json.RelatedTopics ?? []).slice(0, 3)) {
    const first = topic.FirstURL ? topic : (topic.Topics ?? [])[0];
    if (first?.FirstURL && first.Text) out.push({ url: first.FirstURL, title: "DuckDuckGo", snippet: first.Text });
  }
  return out;
}

/** Everything that does not depend on a key, run in parallel and allowed to fail. */
export async function gatherSources(query, max, signal) {
  const tasks = [];
  if (!isLiveData(query)) {
    tasks.push(wikipedia(query, max, signal), instantAnswer(query, signal));
  }
  if (DEVISH.test(query)) tasks.push(hackerNews(query, max, signal));
  const settled = await Promise.allSettled(tasks);
  const extras = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  // An encyclopedic hit that shares no meaningful word with the query is noise the
  // model would otherwise trust; keep only what actually overlaps.
  return query.trim().length === 0 ? extras : extras.filter((item) => overlaps(query, item));
}

// Prices, weather, releases, "what is it right now": encyclopedic sources answer
// these with history instead of the number, which is worse than answering nothing.
const LIVE_DATA =
  /(как|котировка|цена|стоимость|погода|сегодня|сейчас|расписание|сколько стоит|пробки|price|stock price|weather|exchange rate|today|right now|latest version|release date)/i;

const isLiveData = (query) => LIVE_DATA.test(query);

const STOPWORDS = new Set(["the", "and", "for", "with", "what", "how", "is", "are", "of", "to", "in", "on", "vs", "как", "что", "для", "или", "это", "при", "без"]);

function tokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9+#]+/i)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function overlaps(query, item) {
  const wanted = tokens(query);
  if (wanted.length === 0) return true; // nothing to compare against; keep it
  const haystack = tokens(`${item.title ?? ""} ${(item.snippet ?? "").slice(0, 300)}`);
  let matches = 0;
  for (const token of wanted) {
    if (haystack.some((word) => word.startsWith(token) || token.startsWith(word))) matches += 1;
  }
  // One shared word is not enough: "swift actors" must not surface an actor named
  // Swift. Fallback sources have to earn their slot.
  return matches >= Math.min(2, wanted.length);
}

/* ------------------------------------------------------------- entry point */

const cache = new Map();
const inFlight = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key); // refresh recency
  cache.set(key, hit);
  return hit.sources;
}

function cacheSet(key, sources, ttl = CACHE_TTL_MS) {
  cache.set(key, { sources, expires: Date.now() + ttl });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Run the live query in the background once the pacer allows it, so the next ask is cached. */
const warming = new Set();
function warm(key, query, max) {
  if (warming.has(key)) return;
  warming.add(key);
  void (async () => {
    try {
      const sources = tidySources(await duckDuckGo(query, max), max);
      if (sources.length > 0) cacheSet(key, tidySources([...sources, ...(cacheGet(key) ?? [])], max));
    } catch {
      /* the next real search will try again */
    } finally {
      warming.delete(key);
    }
  })();
}

function chain(providers, order) {
  const list = order.length ? order : KEYED;
  // ScraperAPI doubles as the transport for DuckDuckGo, so it is not a route of its
  // own; its Google endpoint is, and it goes last because of the price.
  const keyed = [...list.filter((id) => adapters[id] && id !== "google-serp" && configured(providers, id)), "duckduckgo"];
  if (configured(providers, "scraperapi")) keyed.push("google-serp");
  return keyed;
}

/** Exposed for tests and for the status line the CLI prints. */
export function searchPlan() {
  const { providers, order } = readConfig();
  return chain(providers, order);
}

export function cacheStats() {
  return { entries: cache.size, cooldownLeft: Math.max(0, ddg.blockedUntil - Date.now()) };
}

export const name = "web-search";
export const inject = ["web"];

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    // Nothing local can make this unusable: DuckDuckGo needs no key.
    available: () => true,
    async search(request, signal) {
      const query = String(request.query ?? "").trim();
      if (!query) throw providerError("Empty search query");
      const max = Math.min(Number(request.maxResults) || 10, MAX_SOURCES);
      const key = `${query.toLowerCase()}|${max}`;

      const cached = cacheGet(key);
      if (cached !== null) return { sources: cached, truncated: false };
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;

      const run = (async () => {
        const { providers, order, transport } = readConfig();
        const failures = [];

        // The key-free sources run alongside the web layer, not after it: when
        // DuckDuckGo is throttled the tool still answers with Wikipedia and instant
        // answers instead of failing outright.
        const extras = gatherSources(query, max, signal).catch(() => []);

        // A slow web layer must not hold the whole tool hostage: past the budget the
        // attempt is aborted and whatever the free sources found is returned.
        const stop = new AbortController();
        const budget = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
        let deferred = false;
        const webAttempt = (async () => {
          for (const id of chain(providers, order)) {
            try {
              const entry = id === "google-serp" ? providers.scraperapi : providers[id];
              const call = id === "duckduckgo" ? duckDuckGo(query, max, budget) : adapters[id](query, max, entry, budget);
              const sources = tidySources(await call, max);
              if (sources.length > 0) return sources;
              failures.push(`${id}: gave nothing usable`);
            } catch (error) {
              if (signal?.aborted === true) throw error;
              if (error?.deferred === true) {
                deferred = true;
                break;
              }
              failures.push(`${id}: ${error.message}`);
            }
          }
          return [];
        })();
        const slow = Boolean(providers.scraperapi?.key) || Boolean(transport.proxy);
        const timer = setTimeout(() => stop.abort(), slow ? WEB_BUDGET_PROXIED_MS : WEB_BUDGET_MS);
        timer.unref?.();
        const web = await webAttempt.catch(() => []);
        clearTimeout(timer);

        const merged = tidySources([...web, ...(await extras)], max);
        if (merged.length === 0) {
          const reason = failures.length > 0 ? failures.join(" | ") : deferred ? "duckduckgo: paced, nothing else matched" : "no provider returned usable sources";
          throw providerError(`search failed — ${reason}`);
        }
        // A webless answer is a stand-in, not the real thing: keep it briefly so a
        // retry after the cooldown can still upgrade it.
        cacheSet(key, merged, web.length > 0 ? CACHE_TTL_MS : FALLBACK_TTL_MS);
        if (deferred && web.length === 0) warm(key, query, max);
        return { sources: merged, truncated: false };
      })();

      inFlight.set(key, run);
      try {
        return await run;
      } finally {
        inFlight.delete(key);
      }
    }
  });
}