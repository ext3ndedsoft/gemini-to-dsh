# Quota: five hours and a week

Google meters Cloud Code on two windows at once. The five-hour window is what the client
notices first — it is the one that answers `429` in the middle of a session. The weekly window is
the one that ends the week early, and until recently it was invisible from the outside.

## Where the numbers come from

`GET /limits` on the bridge merges two sources.

**Per model, five-hour window.** `POST /v1internal:fetchAvailableModels` returns every model the
account can use, each with a `quotaInfo`:

```json
"quotaInfo": { "remainingFraction": 0.9898, "resetTime": "2026-11-05T12:23:07Z" }
```

That is one number and one reset time per model. There is no weekly window anywhere in it.

**Per group, both windows.** `POST /v1internal:retrieveUserQuotaSummary` returns buckets grouped
the way the Antigravity app groups them:

```json
{
  "groups": [{
    "displayName": "Gemini Models",
    "description": "Models within this group: Gemini Flash, Gemini Pro",
    "buckets": [
      { "bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.71,
        "resetTime": "2026-11-12T07:23:07Z", "displayName": "Weekly Limit Remaining" },
      { "bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.99,
        "resetTime": "2026-11-05T12:23:07Z", "displayName": "Five Hour Limit Remaining" }
    ]
  }, {
    "displayName": "Claude and GPT models",
    "buckets": [{ "bucketId": "3p-weekly", "window": "weekly", "...": "..." }]
  }]
}
```

The catch is the identity. Google gates the groups on the client that asks: the `hub` identity of
the app's language server gets every group, the plain CLI identity gets a reduced answer. So the
request carries

```
User-Agent: antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64)
```

with the version floored at `2.26.0` (`AG_HUB_VERSION`) — older hubs do not receive the newer
groups. The lookup walks `daily-cloudcode-pa`, then `cloudcode-pa`, then the sandbox host; a `403`
on a request that carried a project is retried once without it, exactly as the desktop app does;
a `401` ends the lookup immediately, because another host will reject the same credential.

## Which account gets the request

The bridge does not keep a "current account" cursor. Every request asks for the accounts in
order and takes the first that is not cooling down:

1. **Pinned first** — unless its five-hour window is nearly empty, see below.
2. **Then by five-hour remaining**, worst bucket across the account's groups, descending.
   The five-hour window is the one that ends a session, so it orders the list; the per-model
   number only breaks ties, and stands in when no group data has been fetched yet.
3. **Cooling accounts last**, ordered by how long until they are usable again.

The pin means *prefer this one*, not *burn this one to zero*. At five percent or less
(`AG_EXHAUSTED_AT`) the pinned account loses its promotion and the account with more
five-hour headroom is used — and the reason is logged, so a switch that looks mysterious has a
line to point at. Below the floor the scored order stands, so if every account is nearly empty
the one with the most left still wins.

When the upstream answers `429`, the account is marked cooling and the request moves to the
next one in the same call, so a refusal costs a retry instead of a failed turn.

## In the response

`/limits` keeps its shape and adds one field per account:

```json
{
  "email": "someone@example.com",
  "ok": true,
  "models": { "gemini-3.8-flash-tiered": { "fraction": 0.99, "resetTime": "..." } },
  "groups": [{
    "name": "Gemini Models",
    "description": "Models within this group: Gemini Flash, Gemini Pro",
    "buckets": [{ "id": "gemini-weekly", "window": "weekly", "remaining": 0.71, "resetAt": "..." }],
    "weekly":   [{ "id": "gemini-weekly", "remaining": 0.71, "...": "..." }],
    "fiveHour": [{ "id": "gemini-5h", "remaining": 0.99, "...": "..." }]
  }],
  "groupsAt": "2026-11-05T08:40:12.181Z",
  "groupsHost": "daily-cloudcode-pa"
}
```

`weekly` and `fiveHour` are the same buckets split by window — `window` or `bucketId` containing
`week` means weekly. A group with no buckets at all is dropped instead of rendering an empty row.

## When it fails

The summary is enrichment, never a dependency. If the endpoint is down, the identity is rejected,
or the account has no group data, `groups` is `null` and the per-model five-hour numbers still
render. Failures are cached for a minute alongside successes, so a broken account cannot slow the
panel down on every refresh.

## Reading it

Percentages are what is **left**, like the app shows them: `100%` is untouched, `12%` means you
are close to the wall. Two windows fail differently, which is why both are on screen:

- five hours — a short cut-off, then the window slides forward. Waiting works.
- weekly — a long cut-off, and the reset time is days away. Waiting works badly; switch accounts
  or switch models while the week drains.

The reset countdown next to each bar is the moment that specific window refills, not "soon".