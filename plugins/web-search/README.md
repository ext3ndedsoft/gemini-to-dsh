# dsh-plugin-web-search

Web search for DSH. Registers into the same `ctx.web` seam as the bundled provider, so
the `web_search` tool, its result cap and its error envelope stay untouched.

## Provider order
1. Keyed API, in order: `serper`, `tavily`, `brave`, `google-cse`, `exa` (an `order`
   array in the config file replaces this list entirely).
2. DuckDuckGo HTML, racing its lite page when the first one is slow.
3. `scraperapi`'s Google endpoint — last, because it costs a credit per search.

ScraperAPI has a second role: when a `scraperapi` key is present it is also the
transport DuckDuckGo goes through, which sidesteps the throttle instead of pacing it.

## Cache and pacing
DuckDuckGo throttles anonymous IPs, so live answers are cached (10 min success, 60 s
fallback), single-flighted, paced by a token bucket (`DSH_SEARCH_BURST`,
`DSH_SEARCH_INTERVAL_MS`), and paused for 90 s after a challenge. If the next live slot
is more than 1.5 s away, the provider answers from free sources instead of waiting.

## Config
`$DSH_SEARCH_CONFIG`, else `~/.dsh/search.json`:

    {
      "providers": { "brave": { "key": "..." } },
      "transport": { "proxy": "http://127.0.0.1:40000" }
    }

Keys may also come from `SERPER_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`,
`EXA_API_KEY`, `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`, `SCRAPERAPI_KEY`; the proxy from
`DSH_SEARCH_PROXY` (scoped to DuckDuckGo fetches).

## Profile
    - insert:
        - id: web-search
          name: "./plugins/web-search/index.js"

## Tests
    node test.mjs            # parsers, ranking, keyed adapter, cache, one live query
    node test.mjs --offline  # skip the live DuckDuckGo query