import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "playwright";
import { Effect, Either, Exit, Schema, Scope } from "effect";
import authEntry from "../../authoring/examples/auth-entry.js";
import chooseAirport from "../../authoring/examples/custom-selection.js";
import setDeparture from "../../authoring/examples/dates-and-dropdowns.js";
import attachDocument, {
  downloadStatement,
  pickTravelDate,
} from "../../authoring/examples/dates-and-files.js";
import dialogPicker from "../../authoring/examples/dialog-picker.js";
import deleteInvoice from "../../authoring/examples/native-dialog.js";
import searchRecords from "../../authoring/examples/kernel-page-fetch.js";
import readHeading from "../../authoring/examples/native-page.js";
import readCatalog, {
  detailFromUrl,
  detailNavigation,
  searchThenRead,
} from "../../authoring/examples/navigation.js";
import searchListings, { readRooms } from "../../authoring/examples/pagination.js";
import selectStatus from "../../authoring/examples/selection.js";
import readInvoiceIds from "../../authoring/examples/variants.js";
import createTask from "../../authoring/examples/write-readback.js";
import placeOrder, { fillStep, placeStep } from "../../authoring/examples/write-session.js";
import { defineOperation } from "../../src/runtime/operation.js";
import {
  admitListCursor,
  randomListCursorKeys,
  sealListOutput,
  type ListCursorScope,
} from "../../src/runtime/list-cursor.js";

import { runExample, failure, localFiles } from "./authoring-fixture.js";

const dialogPickerFixture = async (page: Page, mode: "success" | "ambiguous" | "no_commit") => {
  await page.setContent(
    [
      "<button type='button' id='launcher'>Choose catalog item</button>",
      "<input aria-label='Selected catalog key' value='A' readonly>",
      "<output id='opens'>0</output><output id='commits'>0</output>",
      "<output id='stale-clicks'>0</output><output id='replacements'>0</output>",
      "<output id='early-clicks'>0</output><div id='mount'></div>",
      "<div role='dialog' aria-label='Catalog item picker' hidden>",
      "<input aria-label='Find catalog item'><div role='option' data-key='B'>B</div></div>",
      "<script>",
      "const mode = '" + mode + "';",
      "document.querySelector('[hidden] [role=option]').onclick = () => { document.querySelector('#stale-clicks').textContent++; };",
      "document.querySelector('#launcher').onclick = () => {",
      " document.querySelector('#opens').textContent++;",
      " setTimeout(() => {",
      "  const mount = document.querySelector('#mount');",
      "  mount.innerHTML = \"<div role='dialog' aria-label='Catalog item picker' data-query='old'><input aria-label='Find catalog item'><div role='option' data-key='B'>B</div></div>\";",
      "  const dialog = mount.querySelector('[role=dialog]');",
      "  dialog.onclick = (event) => {",
      "   const item = event.target.closest('[role=option]'); if (!item) return;",
      "   document.querySelector('#commits').textContent++;",
      "   if (dialog.dataset.query !== 'item b') document.querySelector('#early-clicks').textContent++;",
      "   if (mode !== 'no_commit') document.querySelector('[aria-label=\"Selected catalog key\"]').value = item.dataset.key;",
      "  };",
      "  dialog.querySelector('input').oninput = (event) => {",
      "   const current = event.target;",
      "   const replacement = current.cloneNode(); replacement.value = current.value;",
      "   current.replaceWith(replacement);",
      "   document.querySelector('#replacements').textContent++;",
      "   setTimeout(() => {",
      "    dialog.dataset.query = replacement.value;",
      "    dialog.querySelectorAll('[role=option]').forEach((item) => item.remove());",
      "    const count = mode === 'ambiguous' ? 2 : 1;",
      "    for (let i = 0; i < count; i++) {",
      "     const item = document.createElement('div'); item.setAttribute('role', 'option');",
      "     item.dataset.key = 'B'; item.textContent = 'B'; dialog.append(item);",
      "    }",
      "   }, 100);",
      "  };",
      " }, 70);",
      "};",
      "</script>",
    ].join(""),
  );
};

test("current-page example checks the site and reads without navigating, in one call", async ({
  page,
}) => {
  const siteOrigin = "https://invoices.example.test";
  let requests = 0;
  await page.route("**/*", async (route) => {
    requests += 1;
    await route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" });
  });
  await page.goto(`${siteOrigin}/account`);
  const read = await runExample(page, readHeading, {}, { siteOrigin });
  expect(read.result).toEqual(Either.right({ heading: "Invoices" }));
  expect(read.calls).toHaveLength(1);
  // A sibling subdomain is the same site, as after an entry redirect from flights. to invoices.
  const sibling = await runExample(
    page,
    readHeading,
    {},
    { siteOrigin: "https://flights.example.test" },
  );
  expect(sibling.result).toEqual(Either.right({ heading: "Invoices" }));
  // Another registrable domain, and one that is only a suffix of the host's text, are not.
  for (const other of ["https://another.example.invalid", "https://ample.test"]) {
    const read = await runExample(page, readHeading, {}, { siteOrigin: other });
    expect(failure(read.result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  }
  expect(requests).toBe(1);
  expect(page.url()).toBe(`${siteOrigin}/account`);
});

// The page-fetch reference reads the site's JSON through the page's own fetch, and refuses an
// answer that is not a JSON 200, such as a sign-in page served in its place.
test("page-fetch example reads a JSON search through the page and refuses HTML", async ({
  page,
}) => {
  const siteOrigin = "https://records.example.test";
  const searched: string[] = [];
  let signedOut = false;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/search")
      return route.fulfill({ contentType: "text/html", body: "<h1>Records</h1>" });
    searched.push(url.searchParams.get("q") ?? "");
    return signedOut
      ? route.fulfill({ contentType: "text/html", body: "<h1>Sign in</h1>" })
      : route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ items: [{ id: "r-1", name: "Lamp record" }], complete: true }),
        });
  });
  const read = await runExample(page, searchRecords, { query: "lamp" }, { siteOrigin });
  expect(read.result).toEqual(
    Either.right({ items: [{ id: "r-1", name: "Lamp record" }], complete: true }),
  );
  signedOut = true;
  const refused = await runExample(page, searchRecords, { query: "lamp" }, { siteOrigin });
  expect(failure(refused.result)).toMatchObject({ _tag: "OperationFailure" });
  expect(searched).toEqual(["lamp", "lamp"]);
});

// The site is the host's registrable domain, never the last labels of the origin: a multi-label
// public suffix or another tenant's page on a private suffix is another site, and a site with no
// registrable domain is its exact origin alone.
for (const [siteOrigin, pageUrl, reads] of [
  ["https://shop.example.co.uk", "https://www.example.co.uk/account", true],
  ["https://shop.example.co.uk", "https://other.co.uk/account", false],
  ["https://alice.github.io", "https://bob.github.io/account", false],
  ["https://localhost", "https://localhost/account", true],
  ["https://localhost", "https://app.localhost/account", false],
] as const)
  test(`current-page example for ${siteOrigin} ${reads ? "reads" : "refuses"} ${pageUrl}`, async ({
    page,
  }) => {
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" }),
    );
    await page.goto(pageUrl);
    const { result } = await runExample(page, readHeading, {}, { siteOrigin });
    if (reads) expect(result).toEqual(Either.right({ heading: "Invoices" }));
    else expect(failure(result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  });

for (const clears of [true, false]) {
  test(`catalog example ${clears ? "waits past" : "reports"} a verification page without navigating again`, async ({
    page,
  }) => {
    const siteOrigin = "https://catalog.example.invalid";
    let requests = 0;
    await page.route(`${siteOrigin}/**`, async (route) => {
      requests += 1;
      const ready = new URL(route.request().url()).searchParams.has("verified");
      await route.fulfill({
        contentType: "text/html",
        body: ready
          ? "<h1>Catalog</h1>"
          : `<p>Verifying your browser</p>${clears ? '<script>setTimeout(() => location.replace("/catalog?verified=1"), 80)</script>' : ""}`,
      });
    });
    const { result, calls } = await runExample(
      page,
      readCatalog,
      {},
      { siteOrigin, deadlineMs: clears ? 10_000 : 1_500 },
    );
    expect(calls.filter((code) => code.includes("page.goto"))).toHaveLength(1);
    expect(requests).toBe(clears ? 2 : 1);
    if (clears) expect(result).toEqual(Either.right({ heading: "Catalog" }));
    else expect(Either.isLeft(result)).toBe(true);
  });
}

test("catalog example treats a page showing both its heading and the verification text as the verification page", async ({
  page,
}) => {
  const siteOrigin = "https://catalog.example.invalid";
  let requests = 0;
  await page.route(`${siteOrigin}/**`, async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "text/html",
      body: `<h1>Catalog</h1><p>Verifying your browser</p>`,
    });
  });
  const { result } = await runExample(page, readCatalog, {}, { siteOrigin });
  // The verification wait passes at once, since the heading is ready, and the page loads once.
  expect(result).toEqual(Either.right({ heading: "Catalog" }));
  expect(requests).toBe(1);
});

// A records site reached through its own controls: its entry page has a search box, the search lists
// matching records as links, or says none match, and each record opens behind its own
// interstitial. record_7's page belongs to another record, and record_5's link lands on another
// path. record_8's results load late behind a busy region, and a search for record_down fails.
const recordsSite = async (page: Page, origin: string) => {
  const opened: string[] = [];
  const searches: string[] = [];
  const records = ["record_42", "record_420", "record_7", "record_5", "record_8"];
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/favicon.ico") opened.push(url.pathname);
    const html = (body: string) => route.fulfill({ contentType: "text/html", body });
    if (url.pathname === "/")
      return html(`<form role="search" action="/search">
          <input type="search" name="q" aria-label="Record ID"><button>Search</button>
        </form>`);
    if (url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      searches.push(query);
      if (query === "record_down")
        return route.fulfill({
          status: 503,
          contentType: "text/html",
          body: `<div role="alert">Search is unavailable. Try again later.</div>`,
        });
      const found = records.filter((id) => id.includes(query));
      const listed =
        found.map((id) => `<a href="/records/${id}">${id}</a>`).join("") ||
        `<p role="status">No matching records</p>`;
      if (query === "record_8")
        return html(`<section role="region" aria-label="Search results" aria-busy="true"><p>Loading results</p></section>
          <script>setTimeout(() => {
            const results = document.querySelector("section");
            results.innerHTML = ${JSON.stringify(listed)};
            results.setAttribute("aria-busy", "false");
          }, 800)</script>`);
      return html(`<section role="region" aria-label="Search results">${listed}</section>`);
    }
    if (url.pathname === "/records/record_5")
      return html(`<script>location.replace("/records/archived")</script>`);
    if (url.pathname === "/records/record_gone")
      return route.fulfill({ status: 404, contentType: "text/html", body: `<h1>Record not found</h1>` });
    if (url.pathname === "/records/record_blank") return html(`<main><p>Welcome back</p></main>`);
    const shown = url.pathname === "/records/record_7" ? "record_42" : url.pathname.slice(9);
    return html(`<section role="region" aria-label="Continue to record" data-record-id="${shown}">
        <button onclick="this.closest('section').outerHTML = '<section role=region aria-label=\\'Record details\\' data-record-id=${shown}><h1>Quarterly report</h1></section>'">Continue</button>
      </section>`);
  });
  return { opened, searches };
};

test("detail example searches the site for the record, follows its link and checks its identity", async ({
  page,
}) => {
  const origin = "https://records.example.invalid";
  const site = await recordsSite(page, origin);
  const read = async (record_id: string) => {
    const run = await runExample(page, detailNavigation, { record_id }, { siteOrigin: origin });
    // No call builds a URL from the caller's input: the record's page comes from its link.
    for (const code of run.calls) expect(code).not.toContain(`/records/${record_id}`);
    return run.result;
  };
  expect(await read("record_42")).toEqual(
    Either.right({ record_id: "record_42", title: "Quarterly report" }),
  );
  expect(site.searches).toEqual(["record_42"]);
  expect(site.opened).toEqual(["/", "/search", "/records/record_42"]);
  expect(failure(await read("record_7"))).toMatchObject({
    _tag: "OperationFailure",
    message: "identity_mismatch",
  });
  // The final path is checked against the link's own href.
  expect(failure(await read("record_5"))).toMatchObject({
    _tag: "OperationFailure",
    message: "target_mismatch",
  });
  // The site's search says no record matches, so the caller's value is at fault.
  expect(failure(await read("record_9"))).toMatchObject({
    _tag: "InvalidInput",
    message: "The site's search lists no record with this ID",
  });
  // Results still loading, or a search that failed, say nothing about the caller's value.
  expect(await read("record_8")).toEqual(
    Either.right({ record_id: "record_8", title: "Quarterly report" }),
  );
  expect(failure(await read("record_down"))).toMatchObject({
    _tag: "OperationFailure",
    message: "results_unavailable",
  });
  expect(site.searches).toEqual([
    "record_42",
    "record_7",
    "record_5",
    "record_9",
    "record_8",
    "record_down",
  ]);
});

// A details tool whose input is the record's page URL opens that URL as the caller gave it, never
// rebuilt and without the site's search, and still reads the record's identity from the page.
test("detail example opens the caller's record URL unchanged and checks the page's identity", async ({
  page,
}) => {
  const origin = "https://records.example.invalid";
  const site = await recordsSite(page, origin);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const read = async (record_url: string) =>
    (await runExample(page, detailFromUrl, { record_url }, { siteOrigin: origin })).result;
  const link = `${origin}/records/record_42?from=list#top`;
  expect(await read(link)).toEqual(
    Either.right({ record_id: "record_42", title: "Quarterly report" }),
  );
  expect(site.opened).toEqual(["/records/record_42"]);
  expect(requested).toContain(`${origin}/records/record_42?from=list`);
  expect(site.searches).toEqual([]);
  // The page the link opens shows another record.
  expect(failure(await read(`${origin}/records/record_7`))).toMatchObject({
    _tag: "OperationFailure",
    message: "identity_mismatch",
  });
  // A link off the tool's site, or not https, is the caller's error, and nothing opens.
  const before = site.opened.length;
  for (const offSite of [
    "https://records.other.invalid/records/record_42",
    "http://records.example.invalid/records/record_42",
  ])
    expect(failure(await read(offSite))).toMatchObject({ _tag: "InvalidInput" });
  expect(site.opened).toHaveLength(before);
});

test("detail example reports the site's not-found page for a record URL at once", async ({ page }) => {
  const origin = "https://records.example.invalid";
  await recordsSite(page, origin);
  const started = Date.now();
  const { result } = await runExample(
    page,
    detailFromUrl,
    { record_url: `${origin}/records/record_gone` },
    { siteOrigin: origin },
  );
  expect(failure(result)).toMatchObject({ _tag: "InvalidInput", message: "The site has no record at this URL" });
  expect(Date.now() - started).toBeLessThan(3000);
});

test("detail example fails a record URL whose page shows no answer once the page stops progressing", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description: "The example uses the runtime's 8 s no-progress budget, which a test cannot inject.",
  });
  const origin = "https://records.example.invalid";
  await recordsSite(page, origin);
  const started = Date.now();
  const { result } = await runExample(
    page,
    detailFromUrl,
    { record_url: `${origin}/records/record_blank` },
    { siteOrigin: origin },
  );
  expect(failure(result)).toMatchObject({ _tag: "BrowserActionTimeout" });
  expect(String((failure(result) as { message: string }).message)).toMatch(/^outcome_unknown after /u);
  // Well before the 30 s cap.
  expect(Date.now() - started).toBeLessThan(15_000);
});

// A rooms site whose search the build proved reachable by its results URL, /search?q=. Site
// "proved" still answers that URL; "moved" now sends it to the entry page and its search box
// submits to /find?term=; "ignored" answers /search for its last query whatever q says, and its
// search box submits ?query=. Every results page shows its search box holding the query it answers.
const roomsSite = async (page: Page, origin: string, template: "proved" | "moved" | "ignored") => {
  const requests: string[] = [];
  const rooms = [
    ["room-1", "North room"],
    ["room-2", "South room"],
    ["room-3", "East room"],
  ] as const;
  const searchForm = (action: string, name: string, value = "") =>
    `<form role="search" action="${action}"><input type="search" name="${name}" aria-label="Search rooms" value="${value}"></form>`;
  const resultsPage = (action: string, name: string, query: string) => {
    const found = rooms.filter(([, room]) => room.toLowerCase().includes(query.toLowerCase()));
    return `${searchForm(action, name, query)}${
      found.length === 0
        ? `<p role="status">No matching rooms</p>`
        : `<ul aria-label="Rooms">${found.map(([id, room]) => `<li data-room-id="${id}"><span class="name">${room}</span></li>`).join("")}</ul>`
    }`;
  };
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404 });
    requests.push(url.pathname + url.search);
    const html = (body: string) => route.fulfill({ contentType: "text/html", body });
    const [action, name] =
      template === "moved" ? ["/find", "term"] : template === "ignored" ? ["/search", "query"] : ["/search", "q"];
    if (url.pathname === "/") return html(searchForm(action, name));
    if (template === "moved" && url.pathname === "/search")
      return html(`<script>location.replace("/")</script>`);
    if (url.pathname === action)
      return html(
        resultsPage(
          action,
          name,
          template === "ignored" ? url.searchParams.get("query") ?? "north" : url.searchParams.get(name) ?? "",
        ),
      );
    return route.fulfill({ status: 404, body: "Not found" });
  });
  return requests;
};

const roomRows = Either.right({
  rooms: [
    { id: "room-1", name: "North room" },
    { id: "room-2", name: "South room" },
  ],
  more: true,
});

test("search example opens the proved results URL once and reads the rows there", async ({
  page,
}) => {
  const origin = "https://rooms.example.test";
  const requests = await roomsSite(page, origin, "proved");
  const { result } = await runExample(
    page,
    searchThenRead,
    { query: "room", limit: 2 },
    { siteOrigin: origin },
  );
  expect(result).toEqual(roomRows);
  expect(requests).toEqual(["/search?q=room"]);
});

for (const [template, landing] of [
  ["moved", "an entry page"],
  ["ignored", "another query's results"],
] as const)
  test(`search example falls back to the site's search box once when the results URL shows ${landing}`, async ({
    page,
  }) => {
    const origin = "https://rooms.example.test";
    const requests = await roomsSite(page, origin, template);
    const { result } = await runExample(
      page,
      searchThenRead,
      { query: "room", limit: 2 },
      { siteOrigin: origin },
    );
    expect(result).toEqual(roomRows);
    // The results URL once, never a variant of it, then the site's own search once.
    expect(requests.filter((request) => /^\/(?:search|find)\?/.test(request))).toEqual([
      "/search?q=room",
      template === "moved" ? "/find?term=room" : "/search?query=room",
    ]);
  });

// A rooms list that pages by appending: each "Show more" click adds the next two of `total` rooms
// after a short load, their names filling in a moment after the rows appear. With "removed" the
// button goes once every room shows; with "stuck" it stays and adds nothing.
const roomNames = ["North room", "South room", "East room", "West room"];
const appendingRooms = async (page: Page, total: number, ending: "removed" | "stuck", sentinel = false) => {
  await page.setContent(`
    <main><ul aria-label="Rooms"></ul>${sentinel ? '<div class="infinite-loader" style="height: 20px"></div>' : ""}</main>
    <button>Show more</button><output id="clicks">0</output>
    <script>{
      const names = ${JSON.stringify(roomNames.slice(0, total))};
      let shown = 0;
      const list = document.querySelector("ul");
      const button = document.querySelector("button");
      const next = () => {
        list.setAttribute("aria-busy", "true");
        setTimeout(() => {
          const added = names.slice(shown, shown + 2).map((name, index) => {
            const row = document.createElement("li");
            row.dataset.roomId = "room-" + (shown + index + 1);
            row.innerHTML = '<span class="name"></span>';
            list.append(row);
            setTimeout(() => { row.querySelector(".name").textContent = name; }, 80);
            return row;
          });
          shown += added.length;
          list.setAttribute("aria-busy", "false");
          if (shown === names.length && ${JSON.stringify(ending)} === "removed") button.remove();
        }, 120);
      };
      button.onclick = () => { document.querySelector("#clicks").textContent++; next(); };
      next();
    }</script>`);
};
const roomList = (count: number) =>
  roomNames.slice(0, count).map((name, index) => ({ id: `room-${index + 1}`, name }));
// A rooms page as the append example returns it: the list ended, or more with a next position.
const lastRooms = (rooms: readonly { readonly id: string; readonly name: string }[]) => ({
  rooms,
  next_cursor: null,
  next_cursor_expires_at: null,
  has_more: false,
  total_results: null,
  list_changed: false,
});
const moreRooms = (rooms: readonly { readonly id: string; readonly name: string }[]) => ({
  rooms,
  next_cursor: expect.stringMatching(/^pcd1\./u),
  next_cursor_expires_at: null,
  has_more: true,
  total_results: null,
  list_changed: false,
});
// A host that signs cursors, for the append example's later pages.
const roomCursors = (): ListCursorScope => ({
  keys: randomListCursorKeys(),
  operation: "list_rooms",
  now: Date.now(),
});

// A listing site that pages three rows at a time behind a search form, with a Next link. Each
// results page shows its rows at once and fills in their titles a moment later, as a page that
// streams its rows' details does.
const lateTitleListings = async (page: Page, origin: string) => {
  const listings = ["L1", "L2", "L3", "L4", "L5"];
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404 });
    const query = url.searchParams.get("q") ?? "";
    const form = `<form action="/search"><input id="q" name="q" value="${query}"><button id="go">Search</button></form>`;
    if (url.pathname !== "/search") return route.fulfill({ contentType: "text/html", body: form });
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const rows = listings.slice((pageNumber - 1) * 3, pageNumber * 3);
    const more = pageNumber * 3 < listings.length;
    return route.fulfill({
      contentType: "text/html",
      body: `${form}<p id="count">${(pageNumber - 1) * 3 + 1}-${(pageNumber - 1) * 3 + rows.length} of ${listings.length}</p>
<ol id="results">${rows.map((id) => `<li data-id="${id}"><span class="title"></span></li>`).join("")}</ol>
${more ? `<a rel="next" href="/search?q=${encodeURIComponent(query)}&page=${pageNumber + 1}">Next</a>` : ""}
<script>setTimeout(() => {
  for (const row of document.querySelectorAll("#results > li")) row.querySelector(".title").textContent = "Lamp " + row.dataset.id;
}, 300);</script>`,
    });
  });
};

test("paged search example waits for the titles of the rows it returns to fill in", async ({ page }) => {
  const origin = "https://listings.example.test";
  await lateTitleListings(page, origin);
  const { result } = await runExample(
    page,
    searchListings,
    { query: "lamps", limit: 2 },
    { siteOrigin: origin, list: {} },
  );
  expect(result).toEqual(
    Either.right({
      results: [
        { id: "L1", title: "Lamp L1", sponsored: false },
        { id: "L2", title: "Lamp L2", sponsored: false },
      ],
      next_cursor: expect.stringMatching(/^pcd1\./u),
      next_cursor_expires_at: null,
      has_more: true,
      total_results: 5,
      list_changed: false,
    }),
  );
});

test("append example reads each step's filled-in new rows until the control goes", async ({
  page,
}) => {
  await appendingRooms(page, 4, "removed");
  expect((await runExample(page, readRooms, { limit: 10 })).result).toEqual(
    Either.right(lastRooms(roomList(4))),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example ends at the control going beside a loader the page always shows", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description: "The first page's loader counts until it held for the runtime's fixed 8 s no-progress window.",
  });
  await appendingRooms(page, 4, "removed", true);
  expect((await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 30_000 })).result).toEqual(
    Either.right(lastRooms(roomList(4))),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example stops at the limit without another step", async ({ page }) => {
  await appendingRooms(page, 4, "removed");
  expect((await runExample(page, readRooms, { limit: 1 }, { list: {} })).result).toEqual(
    Either.right(moreRooms(roomList(1))),
  );
  await expect(page.locator("#clicks")).toHaveText("0");
});

test("append example's page two replays page one's steps and continues after its last room", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description: "Each page's first read is short of its rows until they held for the helper's fixed two seconds.",
  });
  const scope = roomCursors();
  await appendingRooms(page, 4, "removed");
  const first = await runExample(page, readRooms, { limit: 3 }, { list: {} });
  expect(first.result).toEqual(Either.right(moreRooms(roomList(3))));
  const cursor = (sealListOutput(Either.getOrThrow(first.result), { limit: 3 }, scope).output as {
    readonly next_cursor: string;
  }).next_cursor;
  const admitted = admitListCursor({ limit: 3, cursor }, scope);
  if (!admitted.ok) throw new Error(admitted.message);
  // A fresh run on a fresh page: the list starts again from its first rooms.
  await appendingRooms(page, 4, "removed");
  const second = await runExample(page, readRooms, { limit: 3, cursor }, { list: admitted.list });
  expect(second.result).toEqual(
    Either.right({ ...lastRooms([{ id: "room-4", name: "West room" }]) }),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example keeps a list whose step adds no rows while Show more stays open, never ended", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "A step that adds nothing ends only once the rows held unchanged for the helper's fixed two seconds.",
  });
  await appendingRooms(page, 2, "stuck");
  // has_more stays true with a position that continues: a stalled list is never called ended.
  expect(
    (await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 30_000, list: {} })).result,
  ).toEqual(Either.right(moreRooms(roomList(2))));
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example ends a list that still stalls on the next call instead of returning the same cursor", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Each call's step that adds nothing ends only once the rows held unchanged for the helper's fixed two seconds.",
  });
  const scope = roomCursors();
  await appendingRooms(page, 2, "stuck");
  const first = await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 30_000, list: {} });
  expect(first.result).toEqual(Either.right(moreRooms(roomList(2))));
  const cursor = (sealListOutput(Either.getOrThrow(first.result), { limit: 10 }, scope).output as {
    readonly next_cursor: string;
  }).next_cursor;
  const admitted = admitListCursor({ limit: 10, cursor }, scope);
  if (!admitted.ok) throw new Error(admitted.message);
  await appendingRooms(page, 2, "stuck");
  const second = await runExample(
    page,
    readRooms,
    { limit: 10, cursor },
    { deadlineMs: 30_000, list: admitted.list },
  );
  // No rows and no step further: the list ends honestly as partial, never with the same cursor.
  expect(second.result).toEqual(
    Either.right({
      rooms: [],
      next_cursor: null,
      next_cursor_expires_at: null,
      has_more: true,
      total_results: null,
      list_changed: false,
      next_cursor_unavailable: "no_progress",
    }),
  );
});

// A rooms site whose "Show more" loads the next two rooms after `delayMs`, through the site's API or
// a timer, while a spinner shows below the list and the control is hidden or disabled; once every
// room shows, the control goes.
const slowAppendingRooms = async (
  page: Page,
  delayMs: number,
  via: "request" | "timer" = "request",
  whileLoading: "kept" | "hidden" | "disabled" = "kept",
) => {
  const origin = "https://rooms.example.test";
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/more") {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ contentType: "application/json", body: "{}" }).catch(() => undefined);
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<main>
        <ul aria-label="Rooms"><li data-room-id="room-1"><span class="name">North room</span></li><li data-room-id="room-2"><span class="name">South room</span></li></ul>
        <div id="status"></div><button>Show more</button><output id="clicks">0</output>
      </main>
      <script>
        const button = document.querySelector("button");
        button.onclick = async () => {
          document.querySelector("#clicks").textContent++;
          document.querySelector("#status").innerHTML = '<div class="spinner" style="height: 20px"></div>';
          if (${JSON.stringify(whileLoading)} === "hidden") button.hidden = true;
          if (${JSON.stringify(whileLoading)} === "disabled") button.disabled = true;
          if (${JSON.stringify(via)} === "request") await fetch("/more");
          else await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
          document.querySelector("ul").insertAdjacentHTML("beforeend",
            '<li data-room-id="room-3"><span class="name">East room</span></li><li data-room-id="room-4"><span class="name">West room</span></li>');
          document.querySelector("#status").innerHTML = "";
          button.remove();
        };
      </script>`,
    });
  });
  await page.goto(`${origin}/`);
};

for (const whileLoading of ["hidden", "disabled"] as const)
  test(`append example never calls a control ${whileLoading} while a step loads the end of the list`, async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "slow",
      description: "The step loads for 10 s without a request the wait can see, past the runtime's fixed 8 s window.",
    });
    await slowAppendingRooms(page, 10_000, "timer", whileLoading);
    const { result } = await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 40_000 });
    // Every room, never a short list said to have no more.
    expect(result).toEqual(Either.right(lastRooms(roomList(4))));
  });

test("append example waits for a step whose rooms take longer than the request hold", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description: "The site's API answers after 5 s, past the 4 s a request stays busy when the wait did not start it.",
  });
  await slowAppendingRooms(page, 5000);
  expect((await runExample(page, readRooms, { limit: 10 })).result).toEqual(
    Either.right(lastRooms(roomList(4))),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

// A rooms list with padding that streams each page in: ten rows per load, one every 80 ms.
const streamingRooms = (page: Page, total: number) =>
  page.setContent(`
    <ul aria-label="Rooms" style="padding: 20px"></ul><button>Show more</button><output id="clicks">0</output>
    <script>{
      let shown = 0;
      const list = document.querySelector("ul");
      const next = () => {
        const until = Math.min(shown + 10, ${total});
        for (let at = 1; shown < until; at += 1) {
          const id = (shown += 1);
          setTimeout(() => list.insertAdjacentHTML("beforeend",
            '<li data-room-id="room-' + id + '"><span class="name">Room ' + id + '</span></li>'), at * 80);
        }
      };
      document.querySelector("button").onclick = () => { document.querySelector("#clicks").textContent++; next(); };
      next();
    }</script>`);

test("append example takes its page size from a first page that streamed in, not from its first rows", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description: "A first page shorter than the limit counts only once its rows held for the helper's fixed two seconds.",
  });
  await streamingRooms(page, 40);
  expect((await runExample(page, readRooms, { limit: 30 }, { list: {} })).result).toEqual(
    Either.right(
      moreRooms(
        Array.from({ length: 30 }, (_, index) => ({ id: `room-${index + 1}`, name: `Room ${index + 1}` })),
      ),
    ),
  );
  await expect(page.locator("#clicks")).toHaveText("2");
});

const siteOrigin = "https://members.example.test";
test("auth entry waits for an identifier-first sibling destination after one click", async ({
  page,
}, testInfo) => {
  const loginOrigin = "https://login.example.test";
  let entries = 0;
  let loginPages = 0;
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<nav aria-label="Members"><a href="/member/login">Log in</a></nav>`,
      });
    if (new URL(route.request().url()).origin === siteOrigin) {
      entries++;
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(`${loginOrigin}/member/login`)});</script>`,
      });
    }
    loginPages++;
    await route.fulfill({
      contentType: "text/html",
      body: `<div id="mount"></div><script>requestAnimationFrame(() => requestAnimationFrame(() => { document.querySelector('#mount').innerHTML = '<form aria-label="Member login"><label>Username<input type="text"></label><button>Continue</button></form>'; }));</script>`,
    });
  });
  await page.goto(siteOrigin);
  const { result } = await runExample(page, authEntry, {}, { siteOrigin, deadlineMs: 2000 });
  expect(result).toEqual(
    Either.right({
      origin: loginOrigin,
      pathname: "/member/login",
      controls: [
        { tag: "input", type: "text" },
        { tag: "button", type: "" },
      ],
      coverage: "observed_login_form",
    }),
  );
  expect(entries).toBe(1);
  expect(loginPages).toBe(1);
  await testInfo.attach("navigation-result", {
    body: JSON.stringify({ entries, loginPages, result }),
    contentType: "application/json",
  });
});

test("auth entry follows the observed link and reports controls without values", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    requests.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/"
          ? // The employer link and collapsed duplicates come first in document order.
            `<nav aria-label="Employers"><a href="/employer/login">Log in</a></nav>
             <nav aria-label="Members">
               <ul hidden><li><a href="/member/register">Log in</a></li></ul>
               <a href="/member/register" style="display:block;width:0;height:0;overflow:hidden">Log in</a>
               <a href="/member/login">Log in</a>
             </nav>`
          : `<form aria-label="Member login">
              <label>Username<input type="text" value="private-user"></label>
              <label>Password<input type="password" value="private-password"></label>
              <button type="submit">Sign in</button>
            </form>`,
    });
  });
  await page.goto(siteOrigin);
  const { result, calls } = await runExample(page, authEntry, {}, { siteOrigin });
  expect(result).toEqual(
    Either.right({
      origin: siteOrigin,
      pathname: "/member/login",
      controls: [
        { tag: "input", type: "text" },
        { tag: "input", type: "password" },
        { tag: "button", type: "submit" },
      ],
      coverage: "observed_login_form",
    }),
  );
  expect(calls).toHaveLength(1);
  expect(requests).toEqual([`GET ${siteOrigin}/`, `GET ${siteOrigin}/member/login`]);
  expect(JSON.stringify(result)).not.toContain("private-");
});

// The site's entry redirected to www., a sibling of the authorized origin: still the site.
test("auth entry starts from a sibling subdomain of the site", async ({ page }) => {
  const sibling = "https://www.example.test";
  await page.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/"
          ? '<nav aria-label="Members"><a href="/member/login">Log in</a></nav>'
          : '<form aria-label="Member login"><label>Username<input type="text"></label></form>',
    });
  });
  await page.goto(sibling);
  const { result } = await runExample(page, authEntry, {}, { siteOrigin });
  expect(result).toEqual(
    Either.right({
      origin: sibling,
      pathname: "/member/login",
      controls: [{ tag: "input", type: "text" }],
      coverage: "observed_login_form",
    }),
  );
});

for (const entry of ["absent", "ambiguous", "wrong-path", "other-site"] as const)
  test(`auth entry rejects ${entry} evidence without navigating`, async ({ page }) => {
    const markup = {
      absent: '<nav aria-label="Employers"><a href="/member/login">Log in</a></nav>',
      ambiguous:
        '<nav aria-label="Members"><a href="/member/login">Log in</a><a href="/member/login">Log in</a></nav>',
      "wrong-path": '<nav aria-label="Members"><a href="/member/register">Log in</a></nav>',
      "other-site": '<nav aria-label="Members"><a href="/member/login">Log in</a></nav>',
    };
    let requests = 0;
    await page.route("**/*", async (route) => {
      requests += 1;
      await route.fulfill({ contentType: "text/html", body: markup[entry] });
    });
    const start = entry === "other-site" ? "https://unexpected.example.invalid" : siteOrigin;
    await page.goto(start);
    const { result } = await runExample(page, authEntry, {}, { siteOrigin });
    expect(failure(result)).toMatchObject({ _tag: "OperationFailure" });
    expect(page.url()).toBe(`${start}/`);
    expect(requests).toBe(1);
  });

test("native select example selects a canonical value and reads it back", async ({ page }) => {
  await page.setContent(
    '<label for="status">Invoice status</label><select id="status" onchange="document.querySelector(\'output\').textContent++"><option value="open">Open</option><option value="paid">Paid</option></select><output>0</output>',
  );
  expect((await runExample(page, selectStatus, { status: "paid" })).result).toEqual(
    Either.right({ status: "paid" }),
  );
  await expect(page.locator("output")).toHaveText("1");
});

test("date and dropdown example fills a split date and a custom dropdown by label", async ({
  page,
}) => {
  const months = ["January", "February", "March", "April", "May", "June", "July"];
  await page.setContent(`
    <form role="search" aria-label="Find departures">
      <select name="month" aria-label="Month"><option value="">Month</option>${months.map((month, index) => `<option value="${index}">${month}</option>`).join("")}</select>
      <select name="day" aria-label="Day">${Array.from({ length: 31 }, (_, index) => `<option>${index + 1}</option>`).join("")}</select>
      <input name="year" aria-label="Year">
      <input role="combobox" aria-label="Cabin" readonly aria-expanded="false" aria-controls="cabins" name="cabin">
      <ul role="listbox" id="cabins" hidden><li role="option">Economy</li><li role="option">Business class</li></ul>
    </form>
    <script>
      const cabin = document.querySelector("[aria-label=Cabin]"); const list = document.querySelector("#cabins");
      cabin.onclick = () => { list.hidden = false; cabin.setAttribute("aria-expanded", "true"); };
      list.onclick = (event) => { cabin.value = event.target.textContent; list.hidden = true; cabin.setAttribute("aria-expanded", "false"); };
    </script>`);
  const form = () => page.evaluate(() => Object.fromEntries(new FormData(document.forms[0])));
  expect(
    (await runExample(page, setDeparture, { date: "2027-07-09", cabin: "business" })).result,
  ).toEqual(Either.right({ date: "2027-07-09", cabin: "business" }));
  expect(await form()).toEqual({ month: "6", day: "9", year: "2027", cabin: "Business class" });
  // A month the dropdown does not offer is refused before anything else changes.
  expect(
    failure(
      (await runExample(page, setDeparture, { date: "2027-08-01", cabin: "economy" })).result,
    ),
  ).toMatchObject({ _tag: "OperationFailure", message: "option_missing", dispatch: "not_sent" });
  expect(await form()).toEqual({ month: "6", day: "9", year: "2027", cabin: "Business class" });
});

test("ARIA listbox example waits for this query's delayed options and reads the committed choice", async ({
  page,
}) => {
  await page.setContent(`
    <input role="combobox" aria-label="Airport" aria-expanded="false" aria-controls="choices">
    <output role="status" aria-label="Selected airport" id="selected">A</output><output id="commits">0</output>
    <ul role="listbox" id="unrelated"><li role="option" data-key="B" onclick="throw Error('wrong popup')">Wrong</li></ul>
    <ul role="listbox" id="choices" data-query="old" style="display:none;min-height:20px"><li role="option" data-key="B">Stale B</li></ul>
    <script>
      const control = document.querySelector("input"); const popup = document.querySelector("#choices");
      control.onclick = () => { control.setAttribute("aria-expanded", "true"); popup.style.display = "block"; };
      control.oninput = () => setTimeout(() => {
        popup.innerHTML = '<li role="option" data-key="B">Airport B</li><li role="option" data-key="C">Airport C</li>';
        popup.dataset.query = control.value;
      }, 150);
      popup.onclick = (event) => {
        const key = event.target.dataset.key; if (!key) return;
        document.querySelector("#commits").textContent++;
        popup.setAttribute("data-query-at-commit", popup.dataset.query);
        control.setAttribute("aria-label", "Selected airport " + key);
        document.querySelector("#selected").textContent = key;
      };
    </script>`);
  expect((await runExample(page, chooseAirport, { code: "B", query: "airport b" })).result).toEqual(
    Either.right({ code: "B" }),
  );
  await expect(page.locator("#choices")).toHaveAttribute("data-query-at-commit", "airport b");
  await expect(page.locator("#commits")).toHaveText("1");
});

test("ARIA listbox example reports a choice the status never shows without waiting out a fixed timeout", async ({
  page,
}) => {
  await page.setContent(`
    <input role="combobox" aria-label="Airport" aria-expanded="false" aria-controls="choices">
    <output role="status" aria-label="Selected airport">A</output><output id="commits">0</output>
    <ul role="listbox" id="choices" style="display:none;min-height:20px"></ul>
    <script>
      const control = document.querySelector("input"); const popup = document.querySelector("#choices");
      control.onclick = () => { control.setAttribute("aria-expanded", "true"); popup.style.display = "block"; };
      control.oninput = () => setTimeout(() => {
        popup.innerHTML = '<li role="option" data-key="B">Airport B</li>';
        popup.dataset.query = control.value;
      }, 50);
      popup.onclick = () => { document.querySelector("#commits").textContent++; };
    </script>`);
  const started = Date.now();
  expect(
    failure((await runExample(page, chooseAirport, { code: "B", query: "airport b" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "not_committed", dispatch: "sent" });
  // The status stayed the same for the unchanged window after the click, never a 30 s wait.
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(page.locator("#commits")).toHaveText("1");
});

test("dialog picker waits for fresh choices and commits exactly once", async ({ page }) => {
  await dialogPickerFixture(page, "success");
  const { result, calls } = await runExample(page, dialogPicker, { query: "item b", key: "B" });
  expect(result).toEqual(Either.right({ selected_key: "B" }));
  expect(calls).toHaveLength(1);
  await expect(page.locator("#opens")).toHaveText("1");
  await expect(page.locator("#commits")).toHaveText("1");
  await expect(page.locator("#stale-clicks")).toHaveText("0");
  await expect(page.locator("#early-clicks")).toHaveText("0");
  await expect(page.getByRole("textbox", { name: "Selected catalog key" })).toHaveValue("B");
});

for (const mode of ["ambiguous", "no_commit"] as const)
  test(`dialog picker ${mode} fails without clicking again`, async ({ page }) => {
    await dialogPickerFixture(page, mode);
    const { result } = await runExample(
      page,
      dialogPicker,
      { query: "item b", key: "B" },
      { deadlineMs: 1_500 },
    );
    expect(Either.isLeft(result)).toBe(true);
    await expect(page.locator("#opens")).toHaveText("1");
    await expect(page.locator("#commits")).toHaveText(mode === "no_commit" ? "1" : "0");
    await expect(page.getByRole("textbox", { name: "Selected catalog key" })).toHaveValue("A");
  });

/**
 * The task site the write example was written against: the form posts the task, the site answers
 * `status` with `location`, if any, and the page then opens that location, answered as `detail`
 * says.
 */
const taskSite = async (
  page: Page,
  origin: string,
  answer: { readonly status: number; readonly location?: string },
  detail: (route: Route) => Promise<void>,
) => {
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      submissions += 1;
      await route.fulfill({
        status: answer.status,
        headers: answer.location === undefined ? {} : { location: answer.location },
      });
      return;
    }
    if (request.url() === `${origin}/tasks/new`) {
      await route.fulfill({
        contentType: "text/html",
        body: `<form aria-label="New task" method="post" action="/tasks">
          <label>Title<input name="title"></label><label>Assignee<input name="assignee"></label>
          <button>Create task</button>
        </form><script>
          document.querySelector("form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const response = await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
            location.href = response.headers.get("location");
          });
        </script>`,
      });
      return;
    }
    await detail(route);
  });
  await page.goto(`${origin}/tasks/new`);
  return { submissions: () => submissions };
};

// The create request's 201 and its Location give the output, so the detail page the save opens
// never matters: one showing another task, one that is missing, or one still loading when the run
// ends all leave the same verified write and output.
for (const detail of ["shown", "stale", "missing", "slow"] as const)
  test(`write example takes its output from its own 201, with no page read-back: ${detail}`, async ({
    page,
  }) => {
    const origin = "https://tasks.example.invalid";
    const requested = { title: "Review draft", assignee: "demo-user" };
    let runEnded = () => {};
    const ended = new Promise<void>((resolve) => {
      runEnded = resolve;
    });
    const site = await taskSite(
      page,
      origin,
      { status: 201, location: "/tasks/task-123" },
      async (route) => {
        // A slow detail page answers only after the run has returned.
        if (detail === "slow") await ended;
        const shown =
          detail === "stale"
            ? { id: "old-task", title: "Other task", assignee: "someone-else" }
            : { id: "task-123", ...requested };
        await route
          .fulfill(
            detail === "missing"
              ? { status: 404, contentType: "text/html", body: "<p>Not found</p>" }
              : {
                  contentType: "text/html; charset=utf-8",
                  body: `<section role="region" aria-label="Saved task">
                    <label>Task ID<input readonly value="${shown.id}"></label>
                    <label>Title<input readonly value="${shown.title}"></label>
                    <label>Assignee<input readonly value="${shown.assignee}"></label>
                  </section>`,
                },
          )
          .catch(() => {});
      },
    );
    const { result, calls, effect, ...recorded } = await runExample(page, createTask, requested, {
      siteOrigin: origin,
    });
    runEnded();
    expect(site.submissions()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(createTask.write).toEqual({ confirmation: "readback", commits: ["create-task"] });
    // The 201 with its Location records the write as landed; the one submission entered its
    // commit mark.
    expect({ effect, ...recorded }).toEqual({
      effect: "verified",
      confirmation: "readback",
      commits: [{ name: "create-task", state: "confirmed" }],
    });
    // The output is the id from the Location alone, with no echo of the input.
    expect(result).toEqual(Either.right({ id: "task-123" }));
  });

// Sites often send Location as an absolute URL. One on the response's own origin names the task
// as a path does.
test("write example takes its id from an absolute Location on its own origin", async ({ page }) => {
  const origin = "https://tasks.example.invalid";
  const site = await taskSite(
    page,
    origin,
    { status: 201, location: `${origin}/tasks/task-123` },
    (route) => route.fulfill({ contentType: "text/html", body: "<p>Task saved</p>" }),
  );
  const { result, calls, effect } = await runExample(
    page,
    createTask,
    { title: "Review draft", assignee: "demo-user" },
    { siteOrigin: origin },
  );
  expect(site.submissions()).toBe(1);
  expect(calls).toHaveLength(1);
  expect(effect).toBe("verified");
  expect(result).toEqual(Either.right({ id: "task-123" }));
});

// A create that did not answer 201 with a Location naming the new task on the response's own
// origin confirms nothing: the run fails as sent, without recording the write as landed.
for (const [label, answer] of [
  ["a 200", { status: 200, location: "/tasks/task-123" }],
  ["a 4xx", { status: 422, location: "/tasks/task-123" }],
  ["no Location", { status: 201 }],
  ["a Location naming no task", { status: 201, location: "/tasks/" }],
  ["a Location with a trailing slash", { status: 201, location: "/tasks/123/" }],
  [
    "a Location on another origin",
    { status: 201, location: "https://other.example.invalid/tasks/task-123" },
  ],
] as const)
  test(`write example fails as not_saved on ${label}`, async ({ page }) => {
    const origin = "https://tasks.example.invalid";
    const site = await taskSite(page, origin, answer, (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Tasks</p>" }),
    );
    const { result, calls, effect } = await runExample(
      page,
      createTask,
      { title: "Review draft", assignee: "demo-user" },
      { siteOrigin: origin },
    );
    expect(site.submissions()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(failure(result)).toMatchObject({
      _tag: "OperationFailure",
      message: "not_saved",
      dispatch: "sent",
    });
    expect(effect).not.toBe("verified");
  });

test("write example waits for a delayed submit control and its own receipt before returning", async ({
  page,
}) => {
  test.setTimeout(30_000);
  test.info().annotations.push({
    type: "slow",
    description: "The controlled twelve-second submit delay reproduces the old receipt/write race.",
  });
  const origin = "https://tasks.example.invalid";
  const requested = { title: "Review draft", assignee: "demo-user" };
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body:
        route.request().url() === `${origin}/tasks/new`
          ? `<form aria-label="New task" method="post" action="/tasks">
              <label>Title<input name="title"></label><label>Assignee<input name="assignee"></label>
              <button disabled>Create task</button>
            </form><script>
              setTimeout(() => { document.querySelector("button").disabled = false; }, 12000);
              document.querySelector("form").addEventListener("submit", async (event) => {
                event.preventDefault();
                const response = await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
                location.href = response.headers.get("location");
              });
            </script>`
          : `<section role="region" aria-label="Saved task">
              <label>Task ID<input readonly value="task-123"></label>
              <label>Title<input readonly value="${requested.title}"></label>
              <label>Assignee<input readonly value="${requested.assignee}"></label>
            </section>`,
    });
  });
  await page.goto(`${origin}/tasks/new`);
  const { result, calls } = await runExample(page, createTask, requested, {
    siteOrigin: origin,
    deadlineMs: 25_000,
  });
  expect(result).toEqual(Either.right({ id: "task-123" }));
  expect(submissions).toBe(1);
  expect(calls).toHaveLength(1);
});

// Delayed fields and a submit that enables only after the call ended reproduce a write firing
// after the call expired. A 4 s deadline scales every bound the example derives from
// remainingMs, so the race plays out in about three seconds instead of sixty-five.
test("write example settles a delayed submit before its outer call expires", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "The example's smallest safe call is three seconds, and the submit enables only after it ends.",
  });
  const origin = "https://tasks.example.invalid";
  const requested = { title: "Review draft", assignee: "demo-user" };
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<form aria-label="New task" method="post" action="/tasks">
          <span id="title"></span><span id="assignee"></span><button disabled>Create task</button>
        </form><script>
          setTimeout(() => { document.querySelector("#title").innerHTML = '<label>Title<input name="title"></label>'; }, 50);
          setTimeout(() => { document.querySelector("#assignee").innerHTML = '<label>Assignee<input name="assignee"></label>'; }, 100);
          setTimeout(() => { document.querySelector("button").disabled = false; }, 2800);
          document.querySelector("form").addEventListener("submit", async (event) => {
            event.preventDefault();
            await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
          });
        </script>`,
    });
  });
  await page.goto(`${origin}/tasks/new`);
  const submitEnablesAt = Date.now() + 2_800;
  const { result } = await runExample(page, createTask, requested, {
    siteOrigin: origin,
    deadlineMs: 4_000,
  });
  expect(Either.isLeft(result)).toBe(true);
  expect(submissions).toBe(0);
  // 1.5 s past the moment the submit enables: a click left pending would have posted by now.
  await page.waitForTimeout(Math.max(0, submitEnablesAt + 1_500 - Date.now()));
  expect(submissions).toBe(0);
});

/** The checkout the write-session example was written against: fill, review, place, confirm. */
const checkoutSite = async (page: Page, origin: string, orders: string[]) => {
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/checkout")
      return route.fulfill({
        contentType: "text/html",
        body: `<form aria-label="Checkout" method="get" action="/checkout/review">
          <label>Item<input name="item"></label><label>Quantity<input name="quantity"></label>
          <label><input type="checkbox" name="giftWrap"> Gift wrap</label><button>Continue</button>
        </form>`,
      });
    if (url.pathname === "/checkout/review")
      return route.fulfill({
        contentType: "text/html",
        body: `<form method="post" action="/orders"><input type="hidden" name="item" value="${url.searchParams.get("item") ?? ""}"><button>Place order</button></form>`,
      });
    // The site answers the order's own POST with its confirmation.
    if (url.pathname === "/orders" && request.method() === "POST") {
      orders.push(new URLSearchParams(request.postData() ?? "").get("item") ?? "");
      return route.fulfill({
        contentType: "text/html",
        body: `<p role="status" aria-label="Order confirmation">Order ORD-${1000 + orders.length} is placed.</p>`,
      });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });
};

test("write-session example commits once across its act steps and reads the site's confirmation back", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "lamp", quantity: 2, gift_wrap: false };
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const filled = await runExample(page, fillStep, input, { siteOrigin: origin });
  expect(filled).toMatchObject({
    result: Either.right({ review_shown: true }),
    confirmation: undefined,
  });
  expect(orders).toEqual([]);
  // The next step continues on the review page the first one left.
  const placed = await runExample(page, placeStep, input, { siteOrigin: origin });
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    effect: "verified",
    confirmation: "readback",
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp"]);
  // The composed script runs the same calls from a blank page and declares its confirmation.
  expect(placeOrder.write).toEqual({ confirmation: "readback", commits: ["place-order"] });
  await page.goto("about:blank");
  const composed = await runExample(page, placeOrder, input, { siteOrigin: origin });
  expect(composed).toMatchObject({ confirmation: "readback", effect: "verified" });
  expect(orders).toEqual(["lamp", "lamp"]);
});

/** A write that saves an address, then places an order, each its own marked commit step. */
const markedWrite = (placeOrder: "click" | "refused") =>
  defineOperation(
    {
      name: "place_order",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message", commits: ["save-address", "place-order"] },
    },
    async ({ kernel, sessionId, enteringCommit, verified, errors }) => {
      enteringCommit("save-address");
      await kernel.browsers.playwright.execute(sessionId, { code: 'await page.click("#save");' });
      // A check that refuses the order stops the step before its commit is marked.
      if (placeOrder === "refused")
        throw new errors.OperationFailure("order total changed", { dispatch: "not_sent" });
      enteringCommit("place-order");
      await kernel.browsers.playwright.execute(sessionId, { code: 'await page.click("#place");' });
      verified({ confirmation: "message" });
      return {};
    },
  );

test("a write's commit marks read not_sent until their call runs, then sent, then confirmed", async ({
  page,
}) => {
  await page.setContent(
    "<button id='save' onclick=\"document.querySelector('#saved').textContent++\">Save address</button>" +
      "<button id='place' onclick=\"document.querySelector('#placed').textContent++\">Place order</button>" +
      "<output id='saved'>0</output><output id='placed'>0</output>",
  );
  const refused = await runExample(page, markedWrite("refused"), {});
  expect(failure(refused.result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  expect(refused.commits).toEqual([
    { name: "save-address", state: "sent" },
    { name: "place-order", state: "not_sent" },
  ]);
  await expect(page.locator("#placed")).toHaveText("0");
  const placed = await runExample(page, markedWrite("click"), {});
  expect(placed).toMatchObject({ result: Either.right({}), effect: "verified" });
  expect(placed.commits).toEqual([
    { name: "save-address", state: "confirmed" },
    { name: "place-order", state: "confirmed" },
  ]);
  await expect(page.locator("#placed")).toHaveText("1");
});

test("a commit mark the script never declared is still reported once entered", async ({ page }) => {
  const undeclared = defineOperation(
    {
      name: "confirm_booking",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message" },
    },
    async ({ enteringCommit }) => {
      enteringCommit("confirm-booking");
      return {};
    },
  );
  expect((await runExample(page, undeclared, {})).commits).toEqual([
    { name: "confirm-booking", state: "sent" },
  ]);
});

/** A write that proves its effect, then optionally makes one more browser call. */
const provingWrite = (
  write: { readonly confirmation: "message" | "readback" | "unverifiable" },
  after: "return" | "another_call",
) =>
  defineOperation(
    { name: "proving_write", input: Schema.Struct({}), output: Schema.Struct({}), write },
    async ({ kernel, sessionId, verified }) => {
      verified(write.confirmation === "message" ? { confirmation: "message" } : undefined);
      if (after === "another_call")
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
      return {};
    },
  );

test("verified records the write's proof, a later call reopens it, and unverifiable refuses it", async ({
  page,
}) => {
  expect(
    await runExample(page, provingWrite({ confirmation: "message" }, "return"), {}),
  ).toMatchObject({
    result: Either.right({}),
    effect: "verified",
    confirmation: "message",
  });
  expect(
    await runExample(page, provingWrite({ confirmation: "readback" }, "return"), {}),
  ).toMatchObject({
    effect: "verified",
    confirmation: "readback",
  });
  expect(
    await runExample(page, provingWrite({ confirmation: "readback" }, "another_call"), {}),
  ).toMatchObject({
    result: Either.right({}),
    effect: "may_have_dispatched",
    confirmation: undefined,
  });
  const refused = await runExample(
    page,
    provingWrite({ confirmation: "unverifiable" }, "return"),
    {},
  );
  expect(failure(refused.result)).toMatchObject({
    _tag: "WriteConfirmationRefused",
    recorded: "readback",
  });
  expect(refused.confirmation).toBeUndefined();
});

test("a call after verified turns a confirmed commit mark back to sent", async ({ page }) => {
  const reopened = defineOperation(
    {
      name: "place_order",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message", commits: ["place-order"] },
    },
    async ({ kernel, sessionId, enteringCommit, verified }) => {
      enteringCommit("place-order");
      verified({ confirmation: "message" });
      await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
      return {};
    },
  );
  expect(await runExample(page, reopened, {})).toMatchObject({
    effect: "may_have_dispatched",
    confirmation: undefined,
    commits: [{ name: "place-order", state: "sent" }],
  });
});

const table = (id: string) =>
  `<table aria-label="Invoices"><tbody><tr data-invoice-id="${id}"><td>Old layout</td></tr></tbody></table>`;
const cards = (id: string) =>
  `<ul aria-label="Invoices"><li data-invoice-id="${id}">New layout</li></ul>`;
for (const fixture of [
  { name: "old layout", html: table("invoice_137"), ids: ["invoice_137"] },
  { name: "new layout", html: cards("invoice_982"), ids: ["invoice_982"] },
  {
    name: "ambiguous layouts",
    html: table("invoice_137") + cards("invoice_982"),
    reason: "ambiguous",
  },
  { name: "unsupported page", html: "<main>No invoices</main>", reason: "unsupported" },
  {
    name: "loading state",
    html: '<div role="progressbar"></div>' + cards("invoice_982"),
    reason: "loading",
  },
  {
    name: "identity mismatch",
    html: table("invoice_137") + table("invoice_463"),
    reason: "identity_mismatch",
  },
])
  test(`variant example chooses a layout from one observation: ${fixture.name}`, async ({
    page,
  }) => {
    await page.setContent(fixture.html);
    const { result } = await runExample(page, readInvoiceIds, {});
    if (fixture.ids) expect(result).toEqual(Either.right({ ids: fixture.ids }));
    else
      expect(failure(result)).toMatchObject({ _tag: "OperationFailure", message: fixture.reason });
  });

test("calendar example moves to the requested month and reads the committed date", async ({
  page,
}) => {
  await page.setContent(`
    <input aria-label="Travel date" readonly>
    <div role="dialog" aria-label="Choose date" hidden>
      <button>Previous month</button><button>Next month</button><div id="panel"></div>
    </div>
    <script>
      let month = 9;
      const render = () => {
        const id = "2026-" + String(month).padStart(2, "0");
        document.querySelector("#panel").innerHTML = '<section data-month="' + id + '">' +
          [1, 15].map((day) => '<button data-date="' + id + "-" + String(day).padStart(2, "0") + '">' + day + "</button>").join("") + "</section>";
      };
      render();
      document.querySelector("input").onclick = () => { document.querySelector("[role=dialog]").hidden = false; };
      document.querySelector("[role=dialog]").onclick = (event) => {
        const target = event.target;
        if (target.textContent === "Next month") { month++; render(); }
        else if (target.textContent === "Previous month") { month--; render(); }
        else if (target.dataset.date) document.querySelector("input").value = target.dataset.date;
      };
    </script>`);
  expect((await runExample(page, pickTravelDate, { date: "2026-11-15" })).result).toEqual(
    Either.right({ date: "2026-11-15" }),
  );
  expect(
    failure((await runExample(page, pickTravelDate, { date: "2026-11-03" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "day_ambiguous" });
});

test("calendar example stops when a month step leaves the shown month unchanged", async ({
  page,
}) => {
  // The calendar offers nothing past its last month: its next-month button does nothing there.
  await page.setContent(`
    <input aria-label="Travel date" readonly>
    <div role="dialog" aria-label="Choose date">
      <button>Previous month</button><button>Next month</button>
      <section data-month="2026-12"><button data-date="2026-12-01">1</button></section>
    </div>`);
  expect(
    failure((await runExample(page, pickTravelDate, { date: "2027-01-01" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "month_unavailable", dispatch: "not_sent" });
});

/** A synthetic documents site on its own origin, with a file input and a statement export. */
const documentsSite = async (page: Page) => {
  const origin = "https://documents.example.test";
  await page.route(`${origin}/**`, (route) =>
    new URL(route.request().url()).pathname === "/statement.csv"
      ? route.fulfill({
          contentType: "text/csv",
          headers: { "Content-Disposition": 'attachment; filename="statement.csv"' },
          body: "date,amount\n2026-01-02,12.50\n",
        })
      : route.fulfill({
          contentType: "text/html",
          body: '<label>Documents<input type="file" accept=".txt"></label><a href="/statement.csv">Download statement</a>',
        }),
  );
  await page.goto(`${origin}/`);
  const directory = await mkdtemp(join(tmpdir(), "pomerado-example-files-"));
  const scope = Effect.runSync(Scope.make());
  return {
    origin,
    directory,
    scope,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("upload example has the host place the caller's file and reads back the choice", async ({
  page,
}) => {
  const site = await documentsSite(page);
  try {
    const path = join(site.directory, "report.txt");
    await writeFile(path, "synthetic report");
    const reference = pathToFileURL(path).href;
    const files = await localFiles(page, {
      siteOrigin: site.origin,
      references: [reference],
      downloads: join(site.directory, "downloads"),
      scope: site.scope,
    });
    const input = { document: reference };
    const placed = await runExample(page, attachDocument, input, { files });
    expect(placed.result).toEqual(Either.right({ name: "report.txt", size: 16 }));
    // No call's code carries the file's bytes.
    expect(placed.calls.join("\n")).not.toContain("synthetic report");
    expect(failure((await runExample(page, attachDocument, input, { files })).result)).toMatchObject({
      _tag: "OperationFailure",
      message: "already_selected",
    });
  } finally {
    await site.close();
  }
});

test("download example returns the statement as a file object the host keeps", async ({ page }) => {
  const site = await documentsSite(page);
  try {
    const files = await localFiles(page, {
      siteOrigin: site.origin,
      references: [],
      downloads: join(site.directory, "downloads"),
      scope: site.scope,
    });
    const { result } = await runExample(page, downloadStatement, {}, { files });
    const statement = "date,amount\n2026-01-02,12.50\n";
    expect(Either.getOrUndefined(result), JSON.stringify(failure(result))).toMatchObject({
      statement: {
        $file: {
          name: "statement.csv",
          media_type: "text/csv",
          size: statement.length,
          sha256: createHash("sha256").update(statement).digest("hex"),
        },
      },
    });
  } finally {
    await site.close();
  }
});

test("a download's type comes from its bytes, else the server's type, never its name", async ({
  page,
}) => {
  test.info().annotations.push({ type: "slow", description: "Two downloads Chromium must save" });
  const site = await documentsSite(page);
  // Each export names itself one type and is another.
  const exports = [
    {
      filename: "statement.csv",
      contentType: "text/csv",
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    },
    { filename: "statement.pdf", contentType: "text/csv; charset=utf-8", body: Buffer.from("a,b\n") },
  ];
  await page.route(`${site.origin}/statement.csv`, (route) => {
    const next = exports.shift();
    return next === undefined
      ? route.abort()
      : route.fulfill({
          contentType: next.contentType,
          headers: { "Content-Disposition": `attachment; filename="${next.filename}"` },
          body: next.body,
        });
  });
  try {
    const files = await localFiles(page, {
      siteOrigin: site.origin,
      references: [],
      downloads: join(site.directory, "downloads"),
      scope: site.scope,
    });
    const typeOf = async () => {
      const { result } = await runExample(page, downloadStatement, {}, { files });
      return (Either.getOrUndefined(result) as { statement: { $file: Record<string, unknown> } })
        .statement.$file;
    };
    expect(await typeOf()).toMatchObject({ name: "statement.csv", media_type: "image/png" });
    expect(await typeOf()).toMatchObject({ name: "statement.pdf", media_type: "text/csv" });
  } finally {
    await site.close();
  }
});

test("dialog example keeps the confirm open for the host and applies accept in the next call", async ({
  page,
}) => {
  await page.setContent(`<table><tr><td>INV-7</td><td>
        <button onclick="if (confirm('Delete invoice INV-7?')) this.closest('tr').remove()">Delete</button>
      </td></tr></table>`);
  const asked: unknown[] = [];
  const { result, calls } = await runExample(
    page,
    deleteInvoice,
    { invoice_id: "INV-7" },
    {
      dialogs: ({ interactionId: _id, ...report }) =>
        Effect.sync(() => {
          asked.push(report);
          return { choice: "accept" as const };
        }),
    },
  );
  expect(result).toEqual(Either.right({ deleted: true }));
  expect(asked).toEqual([
    {
      step: "delete-invoice",
      type: "confirm",
      message: "Delete invoice INV-7?",
      url: "about:blank",
    },
  ]);
  expect(calls).toHaveLength(2);
  await expect(page.getByRole("row")).toHaveCount(0);
});
