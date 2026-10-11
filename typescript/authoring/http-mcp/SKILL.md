---
name: http-mcp
description: Build a read's faster HTTP version, which may ship alone: find where the page gets its data, request it the same way, parse it and test it until it passes. Read right after the first Playwright example passes.
---

# The HTTP version of a read

`src/tool-http.mjs` answers the same contract as `src/tool.mjs` without driving the page, so runs
are faster. Most sites that render server-side, or call a JSON API from the page, port, bot-protected
ones included: requests ride the browser's own cookies, TLS fingerprint and proxy. The HTTP version
is tested as its Playwright version is, by what the tool is now: a read signed out on several
inputs, a signed-in read once against its example, and a write once, by replaying its act session
offline (Test it, below). A read whose HTTP version passes and whose example ran on it may ship
`http` alone, even when its Playwright version is incomplete or fails a case (What publishes and
runs, below).

## Request rules (check every request)

- `url`: absolute `https://`, or a site path starting with `/`; no `#fragment`, no
  user:password.
- `method` in capitals. GET and HEAD carry no `body`, not even `""`.
- `headers`: string values with plain names. Never copy HTTP/2 pseudo-headers (`:authority`,
  `:path`), `cookie` or `content-length` from a capture.
- Leave out `maxResponseBytes` unless you need a lower limit than the 8 MiB default; a limit
  alone is enough.
- Import only `effect`, `pomerado/runtime` (or `../../runtime/index.js`) and your own files
  under `src/`. Parse pages with `readEmbeddedJson`, `embeddedJson` and `parseHtml` from
  `pomerado/runtime`; no other package exists. They read state blocks, JSON attributes, state a
  script assigns and markup, so never hand-write a regex parser for any of them.
  `src/tool.mjs` and `src/tool-http.mjs` may share a parser module there.
- A request refused before sending fails `request_refused` (code `invalid_request` or
  `unsupported_capability`, dispatch `not_sent`), and its message says "refused by the request
  check, nothing was sent" with the rule it broke and how to fix it. Nothing reached the site:
  fix it and run again; it never counts against you.

## 1. Find where the data comes from (about a minute)

Right after the first Playwright example passes, find the request that holds the example's
data. Try these in order and stop at the first that holds every output field for the example's
input:

1. **The page's own document.** `readText` the page your example ended on, such as its results
   or detail page, in a `*-http.mjs` probe (`explore/document-http.mjs`), or its saved copy when
   `captures/routes.json` names an `exampleDocument`. Look for the example's
   IDs and values in embedded state: `<script id=…>` state blocks, `<script
   type="application/json">`, `<script type="application/ld+json">`, JSON in an attribute, and
   state a script assigns (`window.__STATE__ = {...}`, `self.__DATA = JSON.parse("...")`).
   Check that the state is filled for this input. An empty search state or a null price means
   the page fills it later from a request: go on to 2.
2. **The page's own data request.** Search `captures/routes.json` and the saved bodies for one of
   the example's IDs (Reading the captures, below). The response that holds it is the request to
   make, GET first. A search provider on another domain counts when the page itself calls it:
   read its public client key from the page's config at run time (URLs, below).
3. **A POST query the page sends.** Send the same body shape and persisted query ID, and the
   page's non-credential headers (names in the route's `requestHeaders`, values in its
   `network.ndjson` line). Read CSRF values and keys from the page, a cookie or an earlier
   response at run time (Tokens, below). Use `requires: ["page-environment"]` when the page's own
   fetch sends it.
4. **Rule it out** only for a signal under "When it can't port", after trying 1. Pass
   `httpVersion: { outcome: "ruled_out", signal, requestId, note }` to `finish_build`.

Prefer embedded JSON to markup, and one request to several. Temporal proximity to a click is a
lead, not proof that a request made the data.

**Location, store and dates.** Set them the way the page's own request does: a URL parameter, a
cookie the page's location call sets, or the same POST. Read the applied value back from the
answer. If the tool must apply a location or store and the HTTP version can't, don't use HTTP:
rule it out with `location_not_applicable`. Results that differ from the example only because
they used another location are a failed test, not a difference to note.

## When it can't port

- **`per_request_hash_or_page_id`:** a persisted query hash or `doc_id` that changes between
  captured calls or was refused without its text (`PersistedQueryNotFound`), or an ID page script
  makes at request time that no saved response holds. A hash the page sends unchanged is a
  constant you can send. A random value such as a request UUID, the caller's input, a value from
  the page URL and a script constant don't count, and a body capture didn't save is unknown, not
  proof.
- **`bot_wall_on_page_fetch`:** a vendor challenge on both curl and the page's fetch. A challenge
  on curl alone is a reason to try the page's fetch, not to stop.
- **`unobtainable_session_token`:** a header value no cookie, page or response the HTTP version
  can request holds, such as a bearer the page keeps in local storage after sign-in. Capture
  masks tokens the site's JSON responses issue, so a masked credential field in a response the
  HTTP version can request is a source.
- **`streaming_response`:** the data arrives only as server-sent events or a socket.
- **`location_not_applicable`:** above.
- **`site_refused_on_both_transports`:** a 401, 403 or 419 on curl and on the page's fetch that
  the captures can't explain.

`requestId` is the capture route the signal rests on, and `note` says what showed it. Don't write
or run a stub to make the point. If a `src/tool-http.mjs` you wrote and tested meets one of these
signals, delete it and give `httpVersion`: every file in `src/` publishes, and a failed HTTP
version never ships. A route this tool's HTTP version already ran successfully
ports: in maintenance, repair it (below).

## 2. Write it

Start from `references/http-version.ts`. Write `src/tool-http.mjs` in the object form, never as a
Kernel script: `defineHttpOperation({ ...contract, run: (input, http) => Effect.gen(...) })`, or
`defineOperation({ ...contract, run: (input) => Effect.gen(function* () { const http = yield*
SiteHttp; ... }) })`. Reuse the Playwright version's contract, so both versions share it:
`import tool from "./tool.mjs"` and pass `name: tool.name, input: tool.input, output:
tool.output`. The two-argument `defineOperation(contract, async (context) => ...)` is a Kernel
script: it has no `SiteHttp`, and the host refuses it in a `*-http.mjs` file before it runs.

- `readJson(http, request, schema)` answers the decoded value.
- `readText(http, request)` answers `{ text, response }`: `const { text } = yield*
  readText(http, request)`.
- `readEmbeddedJson(http, request, select, schema)` reads a page and decodes one embedded state
  block. `select` is `{ id }` for a `<script id=…>` block, `{ type: "ld+json" }` or
  `{ type: "json" }` for every script of that type, `{ attribute }` for JSON in an attribute, or
  `{ assignment: "__STATE__" }` for the object or array a script assigns to that global, or the
  string it passes to `JSON.parse` (the last assignment that parses, as when the page runs).
  When a live curl answer lacks the block, it asks once more over the page's fetch, then fails
  `parsing` naming the block and the page's title.
  `embeddedJson(text, select)` reads a block from text you already have.
- `parseHtml(text)` gives an inert tree for a page without a state block: `select(css)`,
  `selectOne(css)`, and on each node `text()`, `attr(name)` and `html()`. It runs no script and
  makes no request.

Check the answer is for this input: echoed query, sort, filters and location, and the record's
own ID against the one requested. Those checks are the HTTP version's read-back of each input.
When the site refuses a caller's value (an unknown place, a past date, an option it doesn't
offer), fail with `new operationErrors.InvalidInput(message, { field, available })` (from
`pomerado/runtime`), quoting the site's words, naming the tool's input field and listing every
choice the site offers. Fail loudly on any other shape you didn't expect.

Preserve semantics: method, query and body roles, redirects, account, ordering and response
meaning.

## Reading the captures

`captures/routes.json` (`reference/captures.md` in the workspace has the details) is one JSON
document laid out as a header, then one route per line in time order: one per recorded exchange
across exploration, tests, the example or act session and HTTP relay runs, labelled with the
execution that first recorded it. The host rewrites it after every capture publication. The header
has `version: 2`, `complete`, `routeCount` and counts by label, resource type, status class and
site versus other sites. `complete` is false while the sessions in `deferredSessions` wait for a
later publication. Each route holds names, states and references, never a value: its order, time
and duration, label, session and request ID, channel, method, origin, path, `query` and
`requestHeaders` names, status, content type, resource type, owner, document scope and frame. Its
`requestBody` and `responseBody` are `{state, reason, path, bytes, sourceBytes}`, with no inline
text. `capture` names the session's `network.ndjson`, and `record: {offset, length}` points at the
exchange's line there, which holds its exact URL and header values. Search the index with `rg` or
`jq` in an offline command, then read a body file or record with `read_source` and an offset and
limit; `retain_capture` a body you need that wasn't saved. Only GET, HEAD and OPTIONS are safe to
replay without working out what they change.

## URLs

A site-relative URL such as `/api/search?q=...` resolves against the site origin, live and
in replay. `http.siteOrigin` is that origin, and each response's `requestUrl` is the
absolute URL requested, so build other URLs from them, never from a sponsored link, a
canonical tag or other page text, and never write the site's hostname as a literal (the core
skill). A request may go to a sibling host on the site's registrable domain, such as
`api.shop.example` or `data.shop.example` for `www.shop.example`, which many sites serve their
data from. A host on another
registrable domain is a third party: call it only with an https read that matches a call
the captures show the site's own page script making for this data, with the same origin and
endpoint, and send only the caller's input and the values the page itself sends there,
never a secret handle, a credential, or account data the page does not send there.

## Transport

Files named `*-http.mjs` run with the host HTTP relay as `SiteHttp`: `src/tool-http.mjs`,
and probes such as `explore/cart-http.mjs`. There are two backends, and the code picks per
request:

- **Kernel browser curl**, the default. It sends the browser's cookie jar, TLS fingerprint
  and proxy, and a Set-Cookie response updates that jar. It ignores CORS and runs no page
  JavaScript. A live test starts with cleared cookies, so before curl's first request the
  host gives the jar the cookies its own first load of the site set, as a run's entry page
  load does; the first time, it loads the site origin in the page to get them. A jar that
  already holds site cookies, such as a restored sign-in or your flow in progress, stays
  as it is. The execution's `http.relay.preparation` says what the host did.
- **The page's own fetch**, chosen with `requires: ["page-environment"]` (or
  `"service-worker"`). It runs in the site's page with `credentials: "include"`, CORS and
  browser cookie rules; the host loads the site origin in the page first when the page
  is on another origin. Use it for a request that needs
  page JavaScript context or the page origin, and for a bot challenge curl can't pass.

A host's relay may repeat a request once through the page's fetch after curl fails or meets a
challenge, and the execution records which transport answered. Don't rely on it: a request that
needs the page declares `page-environment`, which goes to the page's fetch at run time too. The Kernel script,
`src/tool.mjs`, does its site HTTP inside a call with `page.evaluate(() => fetch(...))`,
never `page.request` or a Node-side fetch. Native HTTP without a browser is parked.

## Bot challenges

<!-- pomerado:section http-mcp.challenges:start
`readJson` and `readText` from `runtime/index.js` check each answer for a bot-protection
challenge page in place of the site's answer: after one on a safe read, they send the request
once more over the page's fetch, then check the status and content, and fail with what came
back. `requestPastChallenge` does the retry alone, and `isBotChallenge` tells you whether the
host found a challenge in a response. The host recognizes challenge pages; a host that
recognizes none reads every answer as the site's, so a site's own 403 or 429 is its answer.
For a challenge it misses, send the request with `requires: ["page-environment"]` yourself.
Because the retry is in your code, runs do the same. If the page's fetch is challenged too, rule
the HTTP version out with `bot_wall_on_page_fetch`; the Playwright version then publishes alone.
pomerado:section http-mcp.challenges:end -->

The relay refuses nothing it carries. The host records every request, and Guardian's
publication review sees each one that sent a credential (the password, a one-time code)
to another site and judges your source for it: never send a credential to another site.
There is no route allowlist, so any route may be requested.

## Tokens

After each live execution the host writes `captures/session-tokens.json`. It holds this
attempt's live cookies and the credential headers the page's own requests and relayed
requests sent and received, such as authorization, CSRF and Set-Cookie, with their values. The view is transient:
it is never stored, uploaded or published, and passwords and one-time codes are
withheld. Use it to learn which tokens the site issues and where they come from, then
write code that obtains each one at run time. Read a CSRF value from the page, a cookie
or an earlier response and forward it. Never paste a value into source; publication
refuses literal tokens.

## Test it

- **Read:** `execute` purpose `test`, target `liveBrowser`, entrypoint `src/tool-http.mjs`, from
  the same starting state as the example, compared with the example: the host counts this as the
  HTTP version's live test. Then test it as the Playwright version is tested. A read signed out
  runs its cases as a batch on it too, with `live_tests` entrypoint `src/tool-http.mjs`, in
  parallel; each version keeps its own results, and the review judges the HTTP version from its
  own (testing skill). A signed-in read checks it once, against the example: the caller's input
  (omit `testInput`), compared with the example's output. Either way, after a failure fix it and
  test again until it passes. A live test starts like the example: the site origin page, with the
  session saved right after sign-in for a signed-in read, or with exploration cookies and storage
  cleared for an anonymous one, so it cannot pass on state exploration left. The host records the
  result as the HTTP version's live evidence: transport, duration and output schemas.
  - Refused before sending (`request_refused`), a module that fails to load, or a review denial:
    nothing reached the site. Fix it and test again.
  - The site answered and your code failed (`parsing`, `output_contract`, an identity check): read
    the answer it got and fix the parser against it offline, then test again. The failure quotes
    the answer's start; `result.cause.http.body.path` names the whole saved answer when the host
    keeps it, and `retain_capture` saves a body you need. Keep and read failed bodies; never guess
    at a fix.
  - `transport`: the relay, proxy or provider failed, not your request. Test again; if it repeats,
    ask for a browser recovery for new egress.
  - A challenge, a block page, or a 401/403/419/429 on curl: send that request with
    `requires: ["page-environment"]`. `readText` retries over the page's fetch by itself only for
    a challenge the host recognizes, never for a status or a block page it doesn't.
    A wall on one execution method is a reason to try another, not to stop. Stop only for a
    signal under "When it can't port".
  - Compare with the example: same records, IDs, fields and units. Differences in order, ranking,
    time or personalisation are notes for coverage, not a reason to delete a version that answers
    the input. A field the example has and yours lacks is a bug to fix. A location, store, filter
    or other input that wasn't applied fails the test; if the HTTP version can't apply it, don't
    use HTTP (`location_not_applicable`).
- **Read why it failed:** a failed execution's `result.cause.class` says where the failure
  came from. `transport`: the relay, proxy or provider could not complete the request, so the
  site's answer never came back; `cause.http` has the request, `transport`, `durationMs`, the
  host's screened `detail` and, when the page's fetch replaced a failed curl attempt,
  `curlFailure`. That is not evidence your request is wrong. `destination_status`: the site
  answered with `cause.http.status`. `parsing`: an answer did not parse or decode.
  `output_contract`: your output missed its schema. `request_refused`: the host refused the
  request unsent, such as `unsupported_capability`. `cancelled`: the execution was interrupted, or its
  own deadline ran out before the request finished (`deadline_exceeded` without `transport`);
  a relay timeout on the transport is `transport`. `parsing` with `code: "invalid_response"`
  means the provider's envelope did not decode, not the site's body. `destination_status`
  with `code: "response_too_large"` and a 2xx status means the site answered normally with a
  body over the limit: fetch less (a narrower page or API call), or drop a `maxResponseBytes`
  you set below the 8 MiB default; don't treat it as an error page.
  `readText` and `readJson` classify the site's answers; an error you throw yourself has no
  cause unless it keeps the `HttpFailure` as its `cause`.
- **Write:** the real write is the act session, which runs the Playwright version; the
  host refuses an act step or residual whose entrypoint is `*-http.mjs`. Write the HTTP
  version from the session's state-changing requests and captures, and never run a
  second write to compare. Check it once, against the session: replay it offline with target
  `savedHTTP`, selecting the session's capture (`capture.json`) or its response bodies as
  `fixtureRefs`, and `SiteHttp` replays the recorded exchanges. Fix and replay again until it
  passes; design no other tests. A passing replay is the only evidence a write's HTTP version
  can have.
- Replay also helps a read: iterate on parsing without touching the site.
- A test counts only for the `src/tool-http.mjs` it ran, and its schemas must match the
  published ones: a read's example, or a write's composed script, whose declared write
  confirmation the HTTP version must match too. After you edit the file, test it again before `finish_build`.

Fail loudly on an unexpected status or shape. Never return an empty result for a
response you didn't understand, and never repeat a login or a write after a parse
failure.

## What publishes and runs

The host decides from its own records, never from your claims:

- A read whose HTTP version passed a live test with the schemas it publishes runs `http`
  first, with the Kernel script as its fallback. After a run falls back (on its entry
  page with the cookies and site storage the run started with), maintenance repairs the HTTP
  version.
- A read whose example itself ran `src/tool-http.mjs` publishes `http` alone. That is a normal
  way to finish a read, not a fallback: once the HTTP version passes its tests (Test it, above),
  run the example on it and publish, even while the Playwright version is incomplete or fails a
  case, and stop fixing a Playwright version you will not ship. Keep `src/tool.mjs` loading, since
  the HTTP version imports its contract. A version that does not ship is neither recorded nor
  judged; the HTTP version still reads each input back from the answer.
- Try the HTTP version while you build, before the final example, so the example still runs
  last, after every edit, and finish_build's ask is only a backstop.
- For a read without a passing HTTP test of the current file, finish_build asks once:
  `http_implementation_untested` to try one, or `http_implementation_stale` when the file
  changed since its passing test. Answer it by testing until the HTTP version passes, or, when
  it can't port, by calling finish_build again with `httpVersion` naming the signal; the
  Playwright script then publishes alone. A refused publication does not skip that ask, so a
  later finish_build still asks about a stale or untested file if it has not asked yet. Ship an
  HTTP version only after it passes a live test, never an untested or failed one beside the
  Playwright script.
- A write's HTTP version is stored, and is `http` first only after a passing recorded
  replay. Runs use it only when the operator turns on write promotion, which is off by
  default. An HTTP write failure goes straight to maintenance, never to a Playwright
  retry.

In maintenance of a read whose HTTP version served runs, repair `src/tool-http.mjs` with the rest
of the tool and test it live again, whatever broke. A repair of any read may also finish with
`http` alone, as a build may, including one whose tool shipped only its Playwright version: when
the HTTP version passes its tests and the repair's example ran on it, publish that, and leave a
Playwright version that still fails unrepaired. The repair still keeps the tool's inputs and
every output it returns. Failure code `HttpImplementationFailed` means the HTTP version failed in
a run; its Playwright fallback may already have answered the caller.
Read the original attempt's HTTP answer (its relay capture, or the saved head and tail the
observations name) before you change it. Drop it only for a signal under "When it can't port",
named in `httpVersion`. A site refusal of the caller's value is `InvalidInput`, never a reason to
drop it. A bot challenge is a reason to try the page's fetch; a read published with no Playwright
version also gets one as its fallback. For a write, never run it live: replay the original
attempt's capture offline (target `savedHTTP`).
Failure code `HttpSignInTemplateFailed` means the run's explicit direct sign-in request failed.
Read its original failure evidence and repair that request without sending unchanged credentials again. The host won't send
the unchanged `src/website-auth-http.json`; correct it against the login page (see the auth
skill) and `authenticate` again.

## The SiteHttp contract

`http.siteOrigin` is the job's site origin. `request({ url, method, headers?, body?,
requires?, timeoutMs?, maxResponseBytes? })` accepts text request bodies and returns
finite response `body` bytes, status, multi-value header arrays, `transport`, `requestUrl`
(the absolute URL requested) and explicit gaps. A 401, 403 or 429 remains a response for
site code to interpret. Curl responses expose no final URL or redirect chain; the page's
fetch gives `finalUrl`, and its visible headers exclude Set-Cookie even though the browser
updates its cookie jar. Streaming and binary
uploads are not supported. The default timeout is 60 seconds through the finite body,
bounded by the execution deadline. Response bodies use an 8 MiB ceiling; `maxResponseBytes`
alone sets a lower one. Larger bodies fail as `response_too_large` without a partial body. Cancellation cannot prove an in-flight website effect was undone.

Do not assume an API-looking URL returns JSON when opened with `page.goto`: document
navigation can negotiate HTML. For a demonstrated JSON endpoint, send
`Accept: application/json`, then check status and Content-Type before decoding.
Unexpected HTML may be a login, challenge, error or alternate representation. See
`references/kernel-page-fetch.ts` for a Kernel script's in-page fetch and parsing. Binary and SSE/WebSocket
decoding need a supported framing contract; infinite streams are not completed bodies.

Design operation families around useful resources and stable IDs, with accurate Effect
schemas, input/output descriptions, dynamic choice resolvers and scoped pagination.
Related operations share connection and login scope. Public definitions contain business
schemas and behaviour; source, captures and credentials stay private. An MCP OAuth token
authorizes Pomerado, not the website login.
