// Self-check for the search provider: offline parsers, ranking hygiene, the keyed
// adapter against a local mock, cache and single-flight, and one live DuckDuckGo
// query when the IP is not throttled.
//
//   node test.mjs            # everything
//   node test.mjs --offline  # skip the network part
//
// Exits non-zero on failure.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.tmpdir(), `dsh-search-test-${Date.now()}.json`);
process.env.DSH_SEARCH_CONFIG = CONFIG;

const plugin = await import("./index.js");
const { parseDuckDuckGo, parseDuckDuckGoLite, tidySources, apply } = plugin;

/* ---------------------------------------------------------------- fixtures */

const HTML_FIXTURE = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FNicol%25C3%25A1s_Maduro&amp;rut=abc">NicolГЎs Maduro - Wikipedia</a>
  </h2>
  <a class="result__snippet" href="x">Nicolas <b>Maduro</b> is a Venezuelan politician &amp; former president.</a>
</div>
<div class="result result--ad result--ad--small">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Buy stuff</a></h2>
  <a class="result__snippet" href="x">Advertisement copy.</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1%26c%3D2">Example</a>
  </h2>
</div>`;

const LITE_FIXTURE = `
<tr><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage" class='result-link'>Example page</a>
</td></tr>
<tr><td class='result-snippet'>A <b>snippet</b> from lite &amp; friends.</td></tr>`;

/* ------------------------------------------------------------------ offline */

const html = parseDuckDuckGo(HTML_FIXTURE);
assert.equal(html.length, 2, "ads skipped, redirects unwrapped");
assert.equal(html[0].url, "https://en.wikipedia.org/wiki/Nicol%C3%A1s_Maduro");
assert.equal(html[0].title, "NicolГЎs Maduro - Wikipedia");
assert.equal(html[0].snippet, "Nicolas Maduro is a Venezuelan politician & former president.");
assert.equal(html[1].snippet, "", "missing snippet stays empty");

const lite = parseDuckDuckGoLite(LITE_FIXTURE);
assert.equal(lite.length, 1, "lite parser finds the row");
assert.equal(lite[0].url, "https://example.com/page");
assert.equal(lite[0].snippet, "A snippet from lite & friends.");

const tidied = tidySources([
  { url: "https://example.com/a/?utm_source=x&utm_medium=y", title: "One", snippet: "s" },
  { url: "https://www.example.com/a", title: "One again", snippet: "s" },
  { url: "https://duckduckgo.com/l/?uddg=x", title: "search host", snippet: "s" },
  { url: "https://cloud.google.com/vertex-ai/docs", title: "Vertex AI", snippet: "docs" },
  { url: "https://example.org/b#frag", title: "Two", snippet: "" },
  { url: "ftp://example.org/c", title: "not http", snippet: "s" },
  { url: "https://example.net/d", title: "", snippet: "" }
]);
assert.deepEqual(
  tidied.map((s) => s.url),
  ["https://example.com/a", "https://cloud.google.com/vertex-ai/docs", "https://example.org/b"],
  "tracking dropped, www deduped, search hosts and non-http skipped, cloud.google.com kept"
);

/* ------------------------------------------------------- keyed adapter + cache */

const calls = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        organic: [
          { link: "https://docs.example.com/guide?utm_campaign=x", title: "Guide", snippet: "How it works." },
          { link: "https://example.com/second", title: "Second", snippet: "Another one." }
        ]
      })
    );
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = mock.address().port;

fs.writeFileSync(
  CONFIG,
  JSON.stringify({ providers: { serper: { key: "test-key", baseUrl: `http://127.0.0.1:${port}` } } })
);
assert.deepEqual(plugin.searchPlan(), ["serper", "duckduckgo"], "plan puts the keyed provider first");

let provider;
apply({ web: { registerSearchProvider: (p) => void (provider = p) } });
assert.equal(provider.id, "web-search");
assert.equal(provider.available(), true);

const first = await provider.search({ query: "how to test", maxResults: 5 });
assert.equal(calls.length, 1, "one upstream call");
assert.deepEqual(
  first.sources.slice(0, 2).map((s) => s.url),
  ["https://docs.example.com/guide", "https://example.com/second"],
  "keyed provider results come first and are canonicalised"
);
assert.ok(first.sources.length >= 2, "merged result is not empty");

const second = await provider.search({ query: "HOW TO TEST", maxResults: 5 });
assert.equal(calls.length, 1, "second identical query served from cache");
assert.deepEqual(second.sources, first.sources);

const [a, b] = await Promise.all([
  provider.search({ query: "parallel query", maxResults: 5 }),
  provider.search({ query: "parallel query", maxResults: 5 })
]);
assert.equal(calls.length, 2, "single-flight: the concurrent duplicate did not hit upstream");
assert.deepEqual(a.sources, b.sources);

/* ------------------------------------------------------- antigravity adapter */

const agCalls = [];
const agMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    agCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
    if (req.url === "/v1/search" && agCalls.length === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          object: "search.result",
          content: "Node.js 24.22.3 is the latest LTS release.",
          sources: [
            { url: "https://nodejs.org/en/download?utm_source=ag", title: "Node.js", snippet: "Download v24.22.3." },
            { url: "https://cloud.google.com/nodejs/docs", title: "Google Cloud", snippet: "Node.js runtime." }
          ],
          truncated: false
        })
      );
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bridge down" } }));
  });
});
await new Promise((resolve) => agMock.listen(0, "127.0.0.1", resolve));
const agPort = agMock.address().port;

fs.writeFileSync(
  CONFIG,
  JSON.stringify({
    order: ["antigravity", "serper"],
    providers: {
      antigravity: { baseUrl: `http://127.0.0.1:${agPort}`, key: "ag-secret" },
      serper: { key: "test-key", baseUrl: `http://127.0.0.1:${port}` }
    }
  })
);
assert.deepEqual(plugin.searchPlan(), ["antigravity", "serper", "duckduckgo"], "plan puts antigravity first");

const agRes = await provider.search({ query: "node 24 latest", maxResults: 5 });
assert.equal(agCalls.length, 1);
assert.equal(agCalls[0].auth, "Bearer ag-secret");
assert.equal(agRes.content, "Node.js 24.22.3 is the latest LTS release.");
assert.deepEqual(
  agRes.sources.map((s) => s.url),
  ["https://nodejs.org/en/download", "https://cloud.google.com/nodejs/docs"]
);

const agCached = await provider.search({ query: "NODE 24 LATEST", maxResults: 5 });
assert.equal(agCalls.length, 1, "antigravity grounded summary and sources served from cache");
assert.equal(agCached.content, agRes.content);

const callsBeforeFallback = calls.length;
const agFallback = await provider.search({ query: "fallback after bridge 502", maxResults: 5 });
assert.equal(agCalls.length, 2, "antigravity attempted first");
assert.equal(calls.length, callsBeforeFallback + 1, "fell back to serper when antigravity returned 502");
assert.equal(agFallback.content, undefined);
assert.equal(agFallback.sources[0].url, "https://docs.example.com/guide");

agMock.close();

/* --------------------------------------------------------------- throttled DDG */

fs.writeFileSync(CONFIG, JSON.stringify({ providers: {} }));
assert.deepEqual(plugin.searchPlan(), ["duckduckgo"], "no key leaves DuckDuckGo as the only route");

if (!process.argv.includes("--offline")) {
  const live = await provider.search({ query: "duckduckgo throttling test", maxResults: 5 }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  if (live.ok) {
    assert.ok(live.value.sources.length > 0, "live search returned sources");
    console.log(`live ok — ${live.value.sources.length} sources, first: ${live.value.sources[0].url}`);
  } else {
    assert.match(live.error.message, /throttl|challenge|cooling down|no usable results/i, "failure is reported, not swallowed");
    console.log(`live blocked (expected from this IP) — ${live.error.message.slice(0, 120)}`);
  }
  console.log("cache:", JSON.stringify(plugin.cacheStats()));
}

mock.close();
fs.rmSync(CONFIG, { force: true });
console.log("ok — parsers, ranking, keyed adapter, cache, single-flight");