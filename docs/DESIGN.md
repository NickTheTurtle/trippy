# Trip Planner: Design Document

> Collaborative, internationally-aware group trip planner. SvelteKit + TypeScript.
> Status: **Design / pre-implementation**. Last updated: 2026-09-02.

---

## 1. Purpose & Vision

A collaborative tool where a user registers, creates a **Trip**, gathers candidate
**Points of Interest (POIs)** via a discovery tool, and schedules them on a
multi-track **calendar** with a map and travel-time estimates. It supports parallel
**tracks** (when a group splits up), **lodging voting**, a **pre-trip** checklist,
an **estimated cost** view, and a **Splitwise-style** expense settlement, all
**time-zone aware** across multiple cities in one trip.

### Reference material (analyzed)
Two real itinerary spreadsheets informed this design:

- **Multi-city China trip** (Beijing → Chongqing → Guilin → Hangzhou → Shanghai,
  16 days, 30-min grid). Revealed: typed activities beyond sightseeing: **meals
  with named venues, boba stops, nightlife, travel legs (flight / high-speed rail),
  "Free time", meetups with people**, and cross-references to other trips.
- **Escape-room weekend trip** (3 days). Revealed: **fixed time-window activities**
  (e.g. `10:00–12:00`), an explicit **booking status marker** (`* = Unbooked`),
  car rental, and lodging check-in blocks.

**Design consequences:**
1. Schedule items are **typed** (poi / meal / travel / lodging / free-time / meetup).
2. Items can be **booked / tentative / unbooked**.
3. Some items have **hard reservation windows**; others are flexible.
4. **Travel legs** live *between* POIs and need computed durations.
5. A single trip spans **multiple cities → multiple time zones**.

---

## 2. Core Concepts (Domain Model)

```
User
Trip            organizer, members[], date range, homeCurrency
  Location      a city/region within a trip; owns an IANA timezone + geo center
  POI           discovered candidate: geo, category, hours, priceLevel, url, votes
  Track         a parallel schedule ("group splits up") within a trip
  ScheduleItem  a typed block placed on a Track's calendar
                { type, startUtc, endUtc, timezone, bookingStatus, cost,
                  poiId?, assignees[], notes }
  TravelLeg     derived edge between consecutive ScheduleItems
                { mode, durationMin, distanceM, cost, provider, cachedAt }
  Lodging       candidate stay for a Location + a voting poll
  Poll / Vote   lodging + POI ranking (approval or ranked)
  Expense       payer, amount, currency, splitRule → Settlement
  Settlement    minimal set of "who pays whom" transactions
```

### 2.1 Entity relationships (ER sketch)

```
User 1───* Membership *───1 Trip
Trip 1───* Location
Trip 1───* Track
Trip 1───* POI            (POI optionally tied to a Location)
Location 1─* Lodging
Track 1───* ScheduleItem
ScheduleItem 0..1─ POI    (poi/meal items reference a POI)
ScheduleItem 1─* TravelLeg (leg to the next item)
Trip 1───* Expense
Expense *─* User          (participants via ExpenseSplit)
Lodging 1─* Vote ; POI 1─* Vote
```

---

## 3. Feature Modules (mapped to the workflow)

### M1: Accounts & Trips
- Email + password (Lucia/Auth.js) and OAuth (Google/GitHub).
- Roles per trip: **organizer** (full control) vs **member** (suggest, vote, expense).
- Invite links / email invites; join request approval.

### M2: POI Discovery
- Candidate places are **auto-saved** to the trip on add (no separate Save step).
- All discovered places with coordinates are plotted on a map preview per city.
- Search a Places provider (Google Places / Foursquare / OpenTripMap) scoped to a
  Location. Import geo, category, opening hours, price level, rating, photo, url.
- Members suggest + upvote POIs into a shared **candidate pool** per Location
  *before* scheduling. Manual POIs also allowed (for venues not in providers).

### M3: Calendar (core)
- Day / multi-day agenda grid mirroring the reference sheets (configurable slot size,
  default 30 min; drag snaps to 5-min increments).
- **Derived column layout**: see M3.2. Columns are computed, not authored.
- Drag POIs from the candidate pool onto slots. Supports:
  - **Fixed windows** (reservations) that lock start/end.
  - **Booking status**: booked / tentative / unbooked (mirrors the `*` marker).
- **Per-activity assignees** (`item_assignees` join table): assign any subset of members to
  each activity. Unassigned items fall back to the track's crew, and are otherwise treated
  as whole-group/shared.
- **Event popup**: clicking a block opens a detail/edit dialog (title, type, start,
  duration, travel-before, attendees, booking status, delete). Dragging never opens it;
  a click only counts when the pointer didn't move.
- **Live "now" line**: a red marker at the current time, drawn only on the day that is
  actually today *in the destination city's zone* (`localDayMinutes` in `src/lib/tz.ts`).
- **"View as <user>"** filter: preview any member's personal schedule (their assigned items
  plus shared items); the schedule form's track picker stays unfiltered.
- **Travel as a first-class activity type** (`type = 'travel'`) that can itself be assigned to
  members, alongside a per-item `travelBefore` lead time.
- **Free time** resets place + travel (no POI/lat/lng/travel), since members are free to roam;
  it also breaks the auto travel-leg chain.
- **Title field** on scheduled places (e.g. multiple escape rooms at the same venue).
- **Per-day lodging banner**: each calendar day shows the lodging in effect for that night.
- **Map panel**: pins for the day + routed path. Hidden on the 3-day and People views so
  the board gets the full width.
- **Auto travel legs**: compute ETA to next POI by mode (Directions API / OSRM);
  flag a conflict when travel doesn't fit the gap between items.

### M3.2: Layout engine & the People swimlane

Earlier versions drew one calendar column per authored *track*, which meant "who is doing
this" had three possible answers (the track's crew, the item's assignees, and the member's
crew membership) that could disagree. **An event's attendee list is now the single source of
truth**; tracks survive only as a colour/grouping detail. Layout is derived.

`src/lib/layout.ts` is a pure module (no DOM) that turns a day's events into a drawing:

- **`buildFlows`**: each person's events in start order; every adjacent pair becomes a
  *hop* (`from → to` at a time), aggregated so one arrow carries everyone making it.
- **`rankEvents`**: a global left-to-right rank per event, seeded by start time then
  relaxed with a weighted barycentre sweep over the hop graph. Events that exchange many
  people drift together, so arrows stay short and un-crossed. `countCrossings` scores an
  ordering, and on the sample day the sweep takes crossings from 1 → 0 vs. naive ordering.
- **`layoutDay`**: packs each cluster of transitively-overlapping events into the fewest
  columns *in rank order*, then lets each event expand rightwards into any column that
  stays free for its whole span. **Width therefore tracks contention**: a solo morning
  activity spans the full board, an event overlapping one other takes ⅔, and a three-way
  afternoon split takes ⅓ each.
- **`personBands`**: each person's day as a contiguous strip (gaps become `null` "free"
  bands), which is what the swimlane renders.

**Day view** draws the packed blocks plus dashed bezier **flow arrows** for hops where the
travelling group differs from either end's full party *and* the two events sit in different
columns; a hop straight down one column is just "what happens next" and needs no arrow.

**People view** (`view=people`) transposes the board: **rows are people, x is time**. Each
row is one continuous band strip coloured by activity, so a split is literally visible as
rows diverging into different colours and converging again. A single overlay draws the
split / rejoin guide-lines and the "now" line across every row, so a change reads as one
moment rather than four separate events.

**Switch moments** (`switchLines`) are likewise derived from the flow graph, not from crew
membership: one event feeding several is a *split*, several feeding one is a *rejoin*,
anything else is a *move*.

### M3.1: Crews (parties), how people get assigned

Groups rarely move as one solid block: they split for a day, or even an afternoon,
then re-merge. **Crews** are the authoring tool for that (the Crews dialog), and they
supply the *default* attendee list for events that have no explicit assignees. They are no
longer a layout concept; see M3.2.

**Model**
- `parties(id, trip_id, name, color, is_solo, created_at)`: a crew. A solo split
  auto-creates a party named after the person (`is_solo = 1`).
- `party_membership(id, party_id, user_id, day, start_min, end_min)`: who is in which
  crew, when. Day + minutes match the calendar grid and avoid cross-city TZ ambiguity.
  Invariant: per `(user, day)` segments never overlap; gaps fall back to **Everyone**.
- `party_day(party_id, day, city_id, lodging_option_id)`: where a crew is (and sleeps)
  on a day. This is what lets city/lodging differ per person.
- `tracks.party_id`: a track belongs to a party. Tracks no longer form calendar columns.

**Everyone default**: every trip has an `Everyone` party containing all members for the
full day of every day (`0→1440`). Existing tracks backfill to it, so single-group trips
behave exactly as before with zero setup.

**"View as <user>"**: for each day, read the user's membership segments; for each
segment, pull the tracks of the party they're in during that window; stitch into one
continuous timeline. Their city/lodging = the party they **end** the day with.

**Split flow**: select person(s) + a time → *Split off* → target = existing crew or
*New crew* (auto-solo if just them). System closes the current membership segment at the
split time and opens a new one in the target from that time. If the two crews differ in
location at that moment, a `travel` activity is auto-inserted to bridge them. *Rejoin*
closes the temp segment and reopens membership in the original.

> **Caveat: attendance is whole-event.** A person attends an event or doesn't; there are
> no per-person partial ranges. To model someone leaving halfway, split the event in two.
> This is what keeps "who is where at time T" a single unambiguous lookup.

**Edge cases**: solo split → auto/reuse a solo party; re-merge → rejoiner inherits the
party's items (no duplication, items live on the party track); orphaned party (nobody in
it for a segment) persists but renders collapsed; unassigned gap → Everyone fallback.

**Backward-compat**: `item_assignees` stays as an optional finer filter *within* a party
(e.g. one escape room, two people). Migration is additive.

**Phasing**: **P1** tables + Everyone default + `tracks.party_id`; per-party lanes; view-as
reads membership (no behavior change for existing trips). **P2** `party_day` city/lodging
per crew per day; calendar banner + map follow the viewer's crew. **P3** split/rejoin UI +
auto-travel bridge.

### M4: Preparation View (`/pretrip`)
- Consolidated checklist: flights, lodging confirmations, visas, packing.
- "What must still be booked" derived from `bookingStatus = unbooked`.
- **Per-person completion.** A task can be assigned to any subset of the trip.
  Something like "apply for a Schengen visa" is not done when one person files it;
  every assignee has to tick their own box. `task_assignees` is the source of truth
  for who is on the hook; `task_done` records who has finished. A task is `done`
  only when `doneCount === people.length`.
  - `trip_tasks.done` survives as the shared flag for tasks with **no** assignees
    (a one-off the group needs once, e.g. "collect everyone's flight numbers").
  - `trip_tasks.assignee` (a comma-joined name string) is now display-only legacy;
    do not read it for logic.
  - **Completion is personal**: `toggleTask` refuses any `targetId` that is not the
    actor, and the action returns 403. Other people's boxes render as inert `<span>`s,
    never buttons, but the server check is what actually enforces it.
- Row affordance scales with the roster: one assignee shows their name, several show
  a `13/20` progress pill that expands to per-person chips.
- **Estimated costs live here too** (see M5): planning what a trip will cost is the
  same job as preparing for it, and splitting them across two tabs meant bouncing
  between them. `/costs` 307-redirects here.

### M5: Estimated Costs (inside Preparation)
- Roll up per-POI cost + travel + lodging share, grouped **per person** and **per day**,
  normalized to the trip's home currency (FX conversion).
- Rendered as a section of `/pretrip`, not its own tab. Add/edit go through a modal.

### M6: Lodging Voting Portal
- Per Location: candidate stays (photo, price/night, link, distance to POIs).
- **Day-scoped options**: a city can have multiple lodging options for different nights
  (each option carries an optional check-in/check-out range); the calendar resolves the
  option in effect for each day.
- **Approval or ranked** voting; live tally; organizer locks a winner.
- **Surfaced inside Discover**, not as its own tab; a Places / Stays segmented control
  switches the grid. The two share one card design (cover art, vote bar, tally, vote
  toggle, remove); stays additionally show price/night, "Edit dates" and "Lock as choice".
- The **tables stay separate** even though the UI is merged. Place votes are multi-vote
  (`poi_votes` PK `(poi_id, user_id)`); stay votes are *exclusive per city*
  (`lodging_votes` PK `(city_id, user_id)`, so voting again replaces). Stays also carry
  price/currency/check-in/check-out/locked, and `party_day.lodging_option_id` is a foreign
  key into them. Merging the storage would churn the calendar, crews and costs for no
  user-visible gain; merging only the presentation gets the whole benefit.

### M7: Expenses (Splitwise-style)
- Log expense: payer, amount, currency, split rule (equal / shares / exact / % ).
- Compute net balances; produce a **minimal-transaction settlement**.
- Multi-currency: store original amount + currency, normalize at settlement time.

#### Split model (implemented)

All three split modes collapse to **one representation: a non-negative `weight` per
participant** (`expense_participants.weight`), and splitting is always "divide the total in
proportion to the weights". The mode (`expenses.split_mode`) only says how the UI collected
those weights:

| Mode | Stored weight | UI |
| --- | --- | --- |
| `even` | `1` for everyone | checkbox only |
| `shares` | the share count (a private room = 2) | share stepper |
| `exact` | the person's amount **in cents** | amount input, must sum to the total |

`splitByWeight()` in `src/lib/split.ts` does the apportionment: floor every share, then hand
the leftover cents to the largest fractional parts (largest-remainder). Shares therefore sum
back to the total **exactly**, so a balance set always nets to zero.

Two rules that are easy to get backwards:

- **Convert, then split.** `balances()` converts the expense total into the home currency
  first and applies the weights afterwards. Splitting first and converting each share
  drifts by up to a cent per person, and the balances stop netting to zero.
- **Income is a sign flip, not a record type.** A refund or payout is stored as a negative
  `amount_cents`; the payer becomes the receiver and every participant is credited instead
  of charged. `splitByWeight` splits `abs(total)` and re-applies the sign, so negative
  amounts get the same exact-sum guarantee.

**There is no "this is income" checkbox.** The sign of the amount *is* the flag. A separate
checkbox is a second source of truth that can disagree with the number next to it; a user
who types `-120` with the box unticked means income either way. The form derives everything
(modal title, "Paid by" vs "Received by", the per-person preview, the save button) from
`amount < 0`, and the server derives the stored sign from the amount alone. In `exact` mode
the per-person amounts are still typed as positive magnitudes and checked against
`abs(total)`.

Validation is doubled: the client disables Save when `exact` amounts don't add up, and the
server independently re-checks and fails the action.

---

## 4. Cross-cutting Technical Design

### 4.1 Time zones (first-class)
- Store every timestamp as **UTC** *and* keep the Location's **IANA zone**
  (e.g. `Asia/Shanghai`).
- Render in the **place's local time**, with an optional "your local time" overlay.
- Use **Luxon** (or `@date-fns/tz`) everywhere; never do naive `Date` math.
- Travel legs that cross zones (e.g. flight) recompute local arrival correctly.

### 4.2 Travel time
- Provider Directions API (Google/Mapbox) or self-hosted **OSRM** for driving/walking;
  flights/rail entered manually or via schedule lookups.
- Cache results keyed by `(originPoiId, destPoiId, mode)`; recompute on reorder.
- Render each leg as a **distinct block** on the grid; warn on overlap/insufficient gap.

### 4.3 Maps
- **Mapbox GL JS** (or Google Maps JS). Day-scoped route + numbered pins.

### 4.4 Realtime collaboration
- WebSockets via a small Node hub, or a managed backend (Supabase Realtime).
- Optimistic UI + last-write-wins per ScheduleItem; presence indicators.

### 4.5 Currency
- Daily FX snapshot cached in Redis (e.g. exchangerate.host). Store original
  currency + amount; convert only for display and settlement.

---

## 5. Architecture & Stack

| Layer            | Choice |
|------------------|--------|
| Frontend         | **React** (Vite + React Router). See 5.0; SvelteKit is being retired |
| Styling          | Tailwind CSS |
| Server API       | Standalone JSON API (`apps/api`), consumed by web and native |
| Validation       | Zod (shared client/server schemas) |
| Auth             | Lucia (or Auth.js for SvelteKit) |
| ORM              | Drizzle ORM (production target) |
| Database         | Local dev: Node built-in `node:sqlite`. Production target: PostgreSQL + **PostGIS** (geo) |
| Cache            | Redis (directions, FX) |
| Maps / Places    | Mapbox GL + a Places provider |
| Dates            | Luxon |
| Realtime         | WebSocket hub / Supabase Realtime |
| Testing          | Vitest (unit) + Playwright (e2e) |

> Note: local development uses `node:sqlite` so the app runs with no native build
> step or external service. The query layer is intentionally small and plain, so
> moving to Postgres later is low-churn. The stated target stack is unchanged.

### 5.0 Framework: the React port (supersedes SvelteKit)

**Decision: the app is moving from SvelteKit to React, and the repository is a
monorepo.** This is recorded here because it was previously agreed in
conversation and never written down, which cost a round of confusion later.

The driver is a planned React Native port. Everything that stayed inside a
`.svelte` file is unusable on mobile, so the goal of the restructure is to move
as much as possible out of the UI layer and into places both a web and a native
client can import.

| Workspace | Contains | Ported to native? |
|-----------|----------|-------------------|
| `packages/core` | Types plus pure logic: settlement, split, tz, layout, cover | Yes, unchanged |
| `apps/api` | JSON API over the `node:sqlite` modules; owns the Google keys | Yes, shared over HTTP |
| `apps/web` | Vite + React + React Router + Tailwind | No, web only |
| `apps/svelte` | The original app, kept runnable as a reference | Deleted at parity |
| `apps/mobile` | Expo / React Native (not yet created) | n/a |

Choices worth the words:

**Vite + React Router, not Next.js.** Trippy is entirely behind auth, so SSR
buys no SEO, and the calendar is heavy client-side interaction. Next's server
components have no analogue in React Native, so building on them would create
work that has to be undone at port time. A plain SPA is the shape that
transfers.

**Two UI codebases, not React Native Web.** RN Web would render web and native
from one source, but it flattens the bespoke web design this app has had a lot
of attention paid to. Sharing logic (not components) gets most of the benefit
for much less cost.

**`packages/core` may not import a framework, touch the DOM, or use Node APIs.**
That is what makes it portable. The seven files moved there were verified to
have zero imports and no DOM references before the move, and the SvelteKit app
was repointed at `@trippy/core` immediately, so the existing working UI acts as
the regression test for the extraction.

**One database, resolved from the repo root.** `db.ts` previously used
`process.cwd()`, which silently means a different file per workspace. It now
resolves from `import.meta.url` up to the repo root, with `TRIPPY_DB` as an
override.

### 5.0.1 Sessions and route guarding in the React app

SvelteKit answered "who is signed in" in a server `load`, so every page already
knew the user before it rendered. A single-page client has no equivalent
moment, so `AuthProvider` asks `/api/auth/me` once on mount and shares the
result.

**Three states, not a nullable user.** `loading`, `authenticated`, `anonymous`.
Collapsing `loading` into `anonymous` makes every reload flash the signed-out UI
and, worse, makes the route guard redirect a signed-in user to `/login` before
the session check has come back.

**Guarded routes are grouped under one `RequireAuth` element** rather than each
page checking for itself. A per-page check is only as good as the one page that
forgets it, and that page is the security hole. The guard is a convenience, not
the enforcement: the API authorises every request independently, so a client
that skipped the guard entirely would still get 401s and 404s.

**Redirect after login is declarative, and this is load-bearing.** The first
version called `navigate(next)` after `logIn()` resolved. It never ran: `logIn`
sets the auth state, which re-renders `Login`, and the `status ===
'authenticated'` early return fired its own `<Navigate>` first. The imperative
call always lost the race, so every deep link silently landed on `/trips`. Type
checking cannot see this and it does not reproduce when the deep link happens to
be the default destination, which is why it survived the first test pass. The
fix is to have the single early-return redirect target `next`, and to make the
state change the only trigger.

**The attempted URL travels in history state, not the query string.** It is
plumbing, so it does not belong in the address bar where a visitor can edit it.

**Both hops use `replace`.** After signing in, `/login` is gone from history, so
the back button cannot return the user to a form they have already satisfied.

**Errors surface as the server's own message.** `api()` turns any non-2xx into
an `ApiError` carrying the server's `error` field, so callers handle a value or
a throw and never re-decide what `res.ok` means. The login failure text stays
deliberately vague, because the API refuses to distinguish a wrong password from
an unknown account.

### 5.0.2 Route shape, the trip shell and data loading

**The tab list was rebuilt from the running app, not from the scaffold.** The
React scaffold listed nine sections and landed `/trips/:tripId` on the calendar.
The app has **five** tabs, in the order discover, pretrip, calendar, expenses,
people, and the bare trip URL lands on **discover**. Calendar is labelled
"Schedule". `costs` and `lodging` are not tabs; they were folded into
preparation and discover, and survive only as redirects so older links still
land somewhere sensible. `settings` has no page at all: it is the organizer's
edit dialog in the trip header. `nav.ts` is now the single source for all of
this, and `App.tsx` generates both the tab routes and the redirects from it, so
adding a section cannot leave the router and the tab bar disagreeing.

**The trip shell owns the trip fetch; sections read it from outlet context.**
Every section needs the same trip record. Letting each one fetch it would mean
five identical requests per navigation and five chances to render a different
name in the header than in the body. `TripShell` loads it once and passes
`{ trip, reloadTrip }` down; `useTrip()` is the accessor. `reloadTrip` is handed
down deliberately: a section that changes something the header shows has to be
able to refresh it, and the alternative is a full page reload.

**`useApi` returns `reload` rather than hiding it.** SvelteKit's
`invalidateAll()` re-ran the page `load` after every form action, and React has
no equivalent. It keeps the previous `data` visible while refetching, so an edit
reads as an update rather than a flash of empty layout.

**Layout is a route, not a component each page renders.** The top bar mounts
once, so its open menu survives navigation. It renders a plain wrapper rather
than a `<main>`, because every page renders its own.

**The nav renders nothing while the session is loading.** Guessing wrong means
the bar visibly flips from "Log in" to a username a moment after every load.

**Unknown or forbidden trips render "not found" in place.** The API returns 404
for both, so the shell cannot tell them apart, and that is the point: trip IDs
cannot be probed by watching which ones produce a different error.

### 5.0.3 Bugs the port surfaced

**Removing an invited placeholder orphaned its invite row.** `trip_invites`
holds `placeholder_id TEXT REFERENCES users(id) ON DELETE SET NULL`, so deleting
the placeholder user did not delete the invite, despite a comment in
`removeMember` claiming it cascaded. Because the table is
`UNIQUE (trip_id, email)`, the surviving row rejected every later attempt to
invite that address to that trip with "already a member or invited", while
nothing in the UI showed anyone by that name: an organizer could lock an address
out of a trip permanently with no way to undo it. The row would also still have
turned into a membership if that person ever registered, silently re-adding
someone who had been removed. `removeMember` now deletes the invite explicitly.
Found by running the People page twice in a row, which a single pass would not
have caught.

**`--danger-ink` was never defined.** Every reference in the Svelte stylesheet
carried an inline fallback, and two of them had drifted (`#a8392f` against
`#a12b21`), so the same "destructive" red was two different reds depending on
which rule won. The React theme defines `--color-danger-ink` and
`--color-danger-soft` once.

**Pending invites were fetched but never shown.** The Svelte loader returned
`invites` and defined a `revoke` action, and no markup used either. Carried
over into the API and then removed on both sides: see "An invite has one
representation" below for why a second list could not have said anything the
roster does not already say.

**`--radius-DEFAULT` produced no `--radius`.** Tailwind v4 does not emit a bare
variable for a `DEFAULT` key in a theme namespace, so every plain-CSS rule
written as `border-radius: var(--radius)` resolved to nothing and rendered
square. Buttons, inputs and panels were all affected, and nothing failed: an
undefined custom property is not an error. The token is now `--radius-md`.
Caught by reading the computed value out of a live page rather than trusting
that the name worked.

**One dialog rule was dropped in the first CSS port.** `.mfoot .mfoot-note` was
missing, so a footer error message would have sat to the right of the buttons
instead of pushing them aside. Found by porting a page that actually uses it.

**`/api/place-photo` was never ported, so no card could ever show a real photo.**
`photoSrc` turns a Google photo reference into `/api/place-photo?name=…`, and the
proxy behind it existed only as a SvelteKit route. The React app therefore fell
back to generated cover art on every place, silently: a missing photo is exactly
what the fallback is *for*, so nothing looked broken, and a type-check cannot see
a URL that has no route. Caught only by screenshotting both apps side by side.
The proxy now lives on the API. It keeps the original's SSRF guard, a strict
pattern match on the photo resource name before any outbound request, and is
session-gated for the same reason `/citysearch` is: the pictures are public, but
every miss spends our Google quota and this must not be an open proxy.

**The accent city dropdown was styled by a scoped rule that had no React home.**
The Svelte page carried `.cityselect :global(.seltrigger)` in its own `<style>`
block, so the green pill the user asked for came back as a plain grey `Select`
in React with nothing to indicate it. Now a real rule in `index.css`, asserted in
the browser suite by reading the computed background colour rather than by eye.

**Escape inside a `Select` or `MultiSelect` closed the whole dialog.** Both
components closed their own menu on Escape and stopped there, so the key went on
to the surrounding `<dialog>` and dismissed it, losing everything typed into the
form. `stopPropagation` alone does not fix this: the browser closes a `<dialog>`
as the *default action* of the Escape keydown, not by listening for the bubbled
event, so `preventDefault` is the part that matters. The handler also moved from
the trigger button to the component root, because once the menu is open focus
sits on an option, which is not inside the trigger. Only reachable by keyboard,
which is why it survived the SvelteKit original and was found by a browser suite
pressing Escape to dismiss a picker.

**Tailwind's preflight left `h4` to `h6` at the inherited weight.** The theme
restyles `h1` to `h3` and stops, so every `h4` sub-heading rendered at body
weight and simply read as another paragraph. Nothing errors and a type-check
cannot see it. Caught by screenshotting the calendar's "Travel legs" heading
against the Svelte page, where the same markup is bold.

**`/account` was a live dead-end.** The top-bar user menu linked to it from
every signed-in page, but the route rendered the "Not ported yet" placeholder,
so the only way to change a password was unreachable. The API route had been
finished all along. The placeholder is now deleted outright and the router's
`SECTION_PAGES` is a full `Record` rather than a `Partial`, so adding a tab
without a page is a compile error instead of a blank panel.

**The home time zone picker read as unset for every default account.**
`Intl.supportedValuesOf('timeZone')` returns canonical zone names and omits
`UTC`, which is exactly the value new accounts start on and the value the
profile route falls back to, so the stored zone matched no option and the
`Select` fell through to its "Select..." placeholder. Saving still worked and
still resolved to `UTC`, which is why nobody noticed. The offered list is now
built per user and always contains the zone the row actually holds, which also
covers an alias or any zone a given runtime does not enumerate.

### 5.0.4 Preparation: tasks, packing and estimated costs

**One list component serves both tasks and packing.** They differ only in
wording, so the difference is data: the section descriptor carries the kind, the
empty-state sentence and the add-button label. Two near-identical components
would have drifted the first time a row gained a feature.

**A task's status is per person, and the row has to show three things at once.**
Whether *you* are done, how far *everyone* is, and whether the task as a whole is
finished. Cramming twenty names into a row is unreadable, so the roster collapses
to a progress bar plus a `done/total` count, and only expands when clicked. One
roster is open at a time, because these lists run to twenty people. Your own
state is pulled out into a separate "You: done" / "You: to do" tag so you never
have to expand a roster to find yourself.

**Boxes you cannot tick look different rather than being hidden.** A task
assigned to other people still shows a box, dashed and inert, because the row
would otherwise look misaligned and it would not be obvious *why* you cannot tick
it. The server enforces this independently: `POST /tasks/:id/toggle` returns 403
for any `userId` that is not the caller, verified directly against the API rather
than only through the UI.

**Deleting is on hover, not always visible.** Every row carrying a permanent ×
makes a long list feel hostile and invites misclicks. The button is revealed by
the row's `group` hover and by keyboard focus, so it is still reachable without a
mouse.

**Add and Edit for a cost are the same dialog.** `id === null` means add. The
fields, validation and layout are identical, and keeping them as one component is
what stops the edit form from quietly falling behind the add form.

**Example placeholders were dropped.** The Svelte fields carried "Apply for a
visa", "Power adapter", "Museum tickets" and "0" as placeholder text. Each field
already has a label saying the same thing, and a placeholder that repeats its
label is noise that also disappears the moment you type. This follows the
convention already used in People: labels always, placeholders only where
the *format* is not obvious.

### 5.0.5 Discover: places, stays and the search

**Search is split in two, and the split is the whole design.** Typing hits
`/discover/search`, which returns names, addresses and pins only. Ratings,
opening hours, the website and the photo come from `/discover/details`, and only
for the one result a member actually clicks. Fetching everything up front would
buy eight enriched results per keystroke to add one place. Three things enforce
it: a 350ms debounce, a three-character floor mirrored from the server's
`MIN_QUERY`, and an `AbortController` so a slow early request cannot land after a
later one and replace good results with stale ones ("acr" overwriting
"acropolis"). Verified by counting requests during a real search: typing
"acropolis museum" cost **one** search call and **one** details call.

**The details response is merged back into the row, not just the popup.** A place
you looked at once keeps its rating in the list, so closing the popup and
reopening it costs nothing. The merge is guarded by the result's key, because the
user may have closed the popup or clicked another result while the request was in
flight.

**The dropdown opens on focus, not on results.** "Add manually" is the answer to
"the place I want is not findable", and you often know that before you type. An
empty query therefore shows the sticky footer alone, with no "type to search"
line telling you to use the box you just clicked.

**Adding a place does not close the results.** One place is often added several
times, once per activity, so the count of adds is shown on the row ("Added ×2")
rather than a tick that would understate it. The click-away and Escape handlers
both ignore events while a modal is open, because a modal is a layer above the
dropdown rather than a click elsewhere on the page.

**Switching section clears the search.** Places and stays are different searches
against different provider filters, and one's results never apply to the other.
Leaving hotel results hanging over the places pool would let you add a hotel as a
place with two clicks.

**The whole result row is the button.** A small "Add" button beside a rich result
made the click target far smaller than the thing it acted on.

**Deleting a place is confirmed, deleting a stay is not.** A place can have
calendar events pointing at it, and those go with it; the dialog says how many.
A stay carries only votes.

### 5.0.6 Calendar: the board, crews and the port's one plain stylesheet

**The calendar is the only page with its own stylesheet, and that is deliberate.**
`calendar.css` is plain CSS rather than Tailwind utilities because the board is an
absolutely positioned time grid whose geometry *is* the layout. A block's `top`
and `height` come from `(minutes - DAY_START) * PX_PER_MIN`, its `left` and
`width` are percentages produced by `layoutDay`, its colour is `color-mix()` over
a per-track `--c`, and how many lines of title and how many people chips fit come
from `--trows` and `--wrows`. Expressing one coordinate system in arbitrary-value
brackets would scatter it across dozens of class strings where no reader could
check it.

**Every rule is scoped under `.cal`.** Svelte gave the original page scoping for
free, and this page uses names a shared stylesheet would also want: `.board`,
`.empty`, `.small`, `.hint`, `.tools`, `.swatch`, `.tag`. The page root carries
`className="cal"`, and `Modal` renders its `<dialog>` inline in the tree rather
than through a portal, so the scope still reaches the dialogs even in the top
layer. The one name that could not be reused is `.chip`, which `index.css`
already defines as a static label; the calendar's quick-add templates are
buttons, so they are `.tchip`.

**The geometry constants live in exactly two places and must move together.**
`DAY_START`, `DAY_END`, `PX_PER_MIN` and `HEAD_PX` in `Calendar.tsx` decide where
a block lands; the 56px gutter and 34px head in `calendar.css` decide where the
hour axis is drawn. Change one without the other and every block silently sits
off its own time label. The browser suite pins this by asserting a three-hour
block is exactly 216px tall.

**`didDrag` is a ref, not state.** It is written during `pointermove` and read by
the `click` that follows in the same event sequence. As state it would lag a
render behind, and every drag would also open the detail popup on release.

**A drag or resize only writes when the snapped value actually changed.** Live
position snaps to five-minute steps so the label never shows decimals, and a
resize will not go below fifteen minutes. Pressing and releasing without moving
therefore costs no request, which is what makes click-to-open and drag-to-move
able to share one pointer sequence.

**The detail popup deliberately sends up to four requests.** `edit` handles the
title, type and travel buffer; `move` and `resize` have different validity rules
on the server and can each be refused on their own; assignees are a separate
`PUT`. Collapsing them into one endpoint would mean one rejection discarding
edits that were fine.

**`EventDetail` is keyed by the event id.** Switching from one block to another
remounts it, so its working copy resets without a hand-written effect. The Svelte
original rebuilt a `detail` object field by field in `openDetail` and had to
remember to add each new field.

**The day and the view live in the URL.** `?day=…&view=…`, navigated with
`<Link>`, so a board is addressable, the back button walks the days, and
`useApi`, which keys off the query string, refetches without any extra wiring.

**Crews are a day-scoped membership, not a group.** A person belongs to a crew
from a given minute of a given day, which is what lets the board draw switch
lines and hop arrows instead of just colouring lanes. Splitting people off
between two cities also writes a travel item on the target crew's lane, so the
gap between "we left" and "we arrived" is on the calendar rather than implied.

**Both map components tolerate a double mount.** React's StrictMode mounts twice
in development. Google Maps survives being handed the same div again, but Leaflet
throws "Map container is already initialized", so each effect sets a `cancelled`
flag and tears the map down on cleanup.

**"+ Add track" is now a "Tracks" panel, because tracks could never be deleted.**
There was `createTrack` and nothing else, so a typo, or a split that was planned
and then dropped, sat on the day forever and kept showing up in the event form's
track picker. The toolbar button now opens a panel that lists the day's tracks
with their event counts and a Delete on each, with the add form underneath, and
the panel stays open after adding since it is a place you manage rather than a
one-shot form.

**Deleting a track deletes its events, by cascade, and confirms only when there
is something to lose.** The events belong to the track and there is nowhere else
to put them, so the delete button on a track with events becomes "Delete 3?" and
needs a second click, while clearing away an empty mistake stays one click.
Closing the panel drops the pending confirmation. Unlike a city, the last track
can go: a day with no tracks is how every day starts.

**`.sel`'s `min-width: min(7.5rem, 100%)` cannot resolve inside a shrink-to-fit
parent.** The percentage is measured against a container that is itself being
measured, so the "View as" box in the calendar toolbar came out narrower than the
trigger inside it and the picker painted on top of the Crews button. `.viewas`
gives its `.sel` a flat width instead. Any other inline-flex or floated wrapper
around a `Select` needs the same. A sweep of every page at 1440 and 1100 for
controls painting outside their parent found no other instance.

### 5.0.7 Account settings

**Profile and password are two independent forms with their own messages.** They
fail for unrelated reasons: a profile save loses to a duplicate email, a password
change loses to a wrong current password or a mismatched confirmation. A single
shared banner would report one form's error above the other form's fields, and a
single submit would make the user re-enter a password to rename themselves.

**Saving the profile calls `refresh()` on the auth context.** The top bar renders
the signed-in name from the session snapshot the provider holds, so without this
a rename appears in the field and nowhere else until a reload. `refresh()`
re-reads `/auth/me` and swallows failures deliberately: it runs in the background
with no place to surface an error, and the page's own save already reported
whatever went wrong.

**The `Profile` component is keyed on the loaded email.** Its inputs are local
state seeded from props, so a refetch after saving would otherwise leave stale
values in the boxes. Keying it remounts the form against the new server truth.

### 5.0.8 The itinerary editor

**Every section is scoped to a city, and until this existed nothing could create
one.** `createTrip` inserts a trip, a membership and the default Everyone party,
and no city, so a freshly created trip rendered "Add cities to this trip to start
collecting places." with no control anywhere in the app that added one. The three
server functions (`addCity`, `updateCity`, `removeCity`) had been written and
were fully unreachable: no route, no UI. The app only worked on seeded data.

**Cities are edited from the chain they are shown in, not from the Edit trip
dialog.** The Edit trip form saves on submit; these controls take effect
immediately. Sharing a dialog between the two would leave the user unable to tell
which half of it was already saved, and Cancel would mean two different things in
one box. The chain in the trip header gains "Edit itinerary" for an organizer, or
a primary "Add a city" when there are none.

**Discover's empty state opens the same dialog.** That page is where a new
organizer actually lands, and its copy pointed at something the app could not do.
It now says what the rule is (places are collected per city) and offers the
button, or explains the wait if the reader is not the organizer.

**The city picker is the geocoder, not seven text boxes.** `GET /citysearch`
already existed, unused, and returns name, country, latitude, longitude and the
IANA zone together, the zone resolved offline from the coordinates by `tz-lookup`.
So the organizer types a city name and never sees a time zone field, which
matters because the zone is what the whole calendar renders through and is the
single field a human is most likely to get wrong.

**Dates default forward.** A new city arrives the day after the previous one
departs, because the common case is appending the next stop. The first city falls
back to the trip's start date, or to today when the trip's dates are still the
free-text string `createTrip` accepts.

**Dates save on blur, with no per-row Save button.** One button per city reads as
one form per city. If the server refuses the edit, the row resets to the value
the trip actually holds rather than keeping a number that was never stored.

**The last city cannot be removed** (`removeCity` refuses, and the button is
disabled with a `title` saying why). Removing it would put the trip back into
exactly the dead-end state this feature exists to get out of. Disabled rather
than hidden: a button that vanishes as you delete down to one looks like a bug.

## Shared UI conventions

These exist so five pages don't each invent their own version. Reach for them
before adding page-local CSS.

**Writing style.** No em dashes, anywhere: not in UI copy, not in code comments,
not in this document. Use a colon to introduce an explanation, commas or
parentheses around an aside, and a semicolon or a full stop between independent
clauses. En dashes stay, but only for genuine ranges (`Apr 16 – 20, 2026`,
`9:00 AM – 5:00 PM`).

**Form labels.** Every field has a real `<label>`, and optional fields mark
themselves in that label as a muted `(optional)`. Optionality is a property of
the field, so it belongs with the field's name and must stay visible while you
type; it was previously split between labels and placeholder text, which meant
the same fact was written two ways and half of it vanished at the first
keystroke. Placeholders are for *format* only, where the shape of the value is
not obvious from its name (`https://` on a URL field, `mm/dd/yyyy` from the
native date input). A placeholder is never used to restate the label, to give an
example of the content, or to carry a rule the user must satisfy: a rule that
disappears when you start typing is missing exactly when it is needed, so those
go in a `.fhint` under the field (as on password fields and the free-text trip
`Dates` field), which is what `Field`'s `hint` prop renders.

**Fields: `src/components/Field.tsx`, styled by `.field` and `.input`.** Four
pages had each grown their own `Field` component and their own `INPUT` class
string, and they had drifted: three label sizes, four corner radii and three
paddings for what is meant to be one control. The spec now lives in two element
classes in `index.css` and the components are only markup. `Field` is a label
plus a text input; `FieldShell` is a label plus any control, which is what a
`Select` or a custom widget needs. `.input` deliberately sets no width, because
callers legitimately need full width, a fixed width for a number box, or an
intrinsic width in a toolbar, and an unlayered rule here would beat the Tailwind
width utility that says so. `.input.compact` is the tight variant, sized to sit
level with `.btn.small`.

**One picker component, not two.** The trip settings dialog used a native
`<select>` for currency while every other picker in the app used `Select`. It
looked different, it did not get the Escape fix, and it opened an OS menu in the
middle of a styled dialog. Native `<select>` is not used anywhere now.

**An invite has one representation, not two.** `GET /people` used to return a
separate `invites` array and there was a `DELETE /people/invites/:id` to revoke
one, but neither client ever rendered or called them, and they could not have
said anything new: `inviteToTrip` always creates a placeholder member, so a
pending invite is already a roster row carrying the real address and an
`invited` tag, and `removeMember` on that row deletes the invite with it. Both
are gone. The revoke route was also lying, discarding `revokeInvite`'s boolean
and answering `{ok:true}` whether or not anything was removed. What is verified
now is the property that matters: after removing an invited row, the same
address can be invited again, which only holds if the `trip_invites` row went
too (it is `UNIQUE (trip_id, email)`).

**Formatting is Prettier, configured at the repo root.** Tabs, single quotes, no
trailing commas, 100 columns: not a fresh opinion, but the settings that leave
the SvelteKit app's hand-carried style unchanged, so the port's files and the
originals stay diffable. There was no config before, which meant anyone running
`npx prettier` picked up the defaults (spaces, double quotes) and rewrote every
file they touched. `npm run format` and `npm run format:check` cover
`apps/web/src`; the API and the retiring Svelte app are left alone.

**Modals: `src/lib/components/Modal.svelte`.** Every dialog in the app uses it.
It wraps the native `<dialog>` element with `showModal()`, which gives focus
trapping, Escape-to-close, focus restore, background inertness and top-layer
rendering (immune to z-index and `transform` clipping) for free. The one thing
`<dialog>` does *not* do is lock body scroll, so the component does that
explicitly; that was the actual cause of the double-scrollbar bug.

Layout contract for consumers:

| Slot class   | Role |
|--------------|------|
| `.mform`     | Optional `<form>` wrapper spanning body + footer |
| `.mbody`     | The **only** scrolling region. Never nest another `overflow: auto` inside it |
| `.mfoot`     | Pinned action row, primary button last |
| `.mfoot-note`| Left-aligned hint text in the footer |

`.mform` is a **descendant-styling hook**, not a layout class; it wraps `.mbody`
and `.mfoot`, so giving it `display: flex; gap` inserts a gap above the pinned
footer. Stack fields with a `.fields` wrapper *inside* `.mbody` instead; `.mbody`
supplies padding and scrolling but deliberately no gap between its children.

Sizes are `sm` / `md` / `lg` (460 / 620 / 860px). Use `focusOnMount` from
`src/lib/focus.ts` on the first meaningful field.

**Global styles live in `src/app.css`, not in page files.** Specifically: the
`:focus-visible` ring, `:disabled` treatment, the `prefers-reduced-motion`
guard, `.sr-only`, and every button variant (`.btn.small` / `.btn.sm`,
`.btn.primary`, `.btn.danger`). Button sizing and danger colours had drifted
across five files with three different paddings before being consolidated here;
adding a local override reintroduces that drift.

**Repeated controls need disambiguated labels.** A grid of cards each with a
"Vote" or "Remove" button is identical to a screen reader. Pass the subject in
via `aria-label={`Remove ${name}`}` (or a `.sr-only` span for links).

**`min-width` on a shared control must be `min(Xrem, 100%)`.** A bare length is
a hard floor flexbox cannot shrink below, so `Select`/`MultiSelect` silently
overflowed narrow modal rows.

**Tabs own their titles; pages don't repeat them.** The workspace tab strip
already names the current view, so no page renders an `<h2>` matching its tab.
A page's `.head` row carries only a one-line hint and its primary action.

**No footer, and no "My trips" link.** The chrome is one sticky top bar. The
brand mark doubles as the home link and points at `/trips` when signed in, so a
separate nav entry would go to the same place. `/` is the signed-out marketing
page only; it 307s to `/trips` for anyone with a session, which is also why its
secondary CTA is "Log in" rather than a link into the app. The root `<main>`
carries the bottom padding the footer used to supply.

**Tab order follows the planning timeline**, not feature age:
`Discover → Preparation → Schedule → Expenses → People`. You find places, get
ready and budget for them, lay them out on a calendar, then settle up; People is
the roster you consult throughout. Retired tabs keep a 307 redirect rather than
404ing (`/costs → /pretrip`, `/lodging → /discover`).

**Scoped styles are not namespaces.** Svelte scopes a component's CSS against
other components, not against itself, so two unrelated blocks in the same file
can collide on a class name: `.who` as both a modal fieldset and a task-row
label silently gave task names a fieldset's border and padding. Two rules follow:
keep class names distinct within a file, and remember bare element selectors
(`ul { flex-direction: column }`) still apply to every matching element in the
file, so a wrapping chip list must set `flex-direction: row` explicitly.
Beware specificity too: `.mform label` (0,1,1) beats `.wholine` (0,1,0).

**Section sidebars: `src/lib/components/SectionNav.svelte`.** A page with
several related panels (Discover, Preparation, Expenses) switches between them
with a vertical list on the left, not a second row of tabs or a segmented
control. Tabs move you between features; this moves you within one. Items carry
an optional badge counting what is *outstanding* (unfinished tasks, people not
square) or simply how many are there (places, stays). It collapses to a
horizontal scroller under 860px. The page wraps it in a `.layout` grid
(`190px minmax(0, 1fr)`) with a `.panel` column, and renders modals *outside*
`.layout` so they aren't constrained by the grid.

The sidebar costs ~215px of row width, so a page that also has a right-hand rail
has to give ground. Discover initially narrowed its map rail to 320px; the map
was later dropped entirely, which is what lets its cards run three to a row.

Section-level stats belong **in `.phead`**, not on a line beneath it: Discover's
"18 of 20 voted" only applies to Stays, and a line that exists for one section
and not the other would move the cards when you switch.

Do not restate a `SectionNav` badge as prose. Preparation's `.phead` used to read
"2 of 10 tasks done before you leave." / "4 of 9 items packed." next to a sidebar
already badging the outstanding count for each section; the sentence was a second
rendering of the same number and was dropped. `.phead` there is now the action
button alone, right-aligned, still reserving `--phead-h`.

**Nothing may move when you switch view.** Two shifts were fixed and both are
easy to reintroduce:

- *Horizontal.* `app.css` sets `scrollbar-gutter: stable` on `html` (with an
  `overflow-y: scroll` fallback). Without it, navigating from a page taller than
  the viewport to a shorter one removes the scrollbar and slides the whole
  centred layout sideways by ~15px.
- *Vertical.* A section header (`.phead`) is a one-line hint plus an optional
  action button. Sections without a button would be ~12px shorter and the panel
  below would jump, so `.phead` sets `min-height: var(--phead-h)`, a token in
  `:root` matching `.btn`'s height. Keep summary blocks and stat rows *out* of
  `.phead`; put them in the panel body, as Estimated costs does.

Headless browsers use overlay scrollbars and report a scrollbar width of 0, so
this class of bug is invisible to a headless screenshot. Verify with a headed
browser and compare `window.innerWidth - document.documentElement.clientWidth`
plus a fixed element's `getBoundingClientRect()` across views.

**Card cover images use real photographs, then generated art**
(`src/lib/components/Cover.svelte`): a place's Google Places photo: the
storefront-style picture Maps shows, and deterministic generated art when there
is none. Map thumbnails were tried as a middle tier and dropped: a card showing a
street map told you nothing the map beside it wasn't already showing, and read as
a placeholder rather than a picture.

Seeded and hand-added places start with no photo, so `discover/+page.server.ts`
backfills them on first view via `lookupPhoto()`, biased to the place's own
coordinates so a generic name resolves to the right venue. The result is written
back to `pois.photo`, including the `NO_PHOTO` (`'-'`) sentinel for a genuine
miss, so a place is looked up at most once ever rather than on every page load.
Lookups run in `Promise.allSettled` and failures are swallowed: a missing picture
must never stop the page rendering. Cost is one-off (~500ms for a fresh trip,
~40ms thereafter).

**Cover images: `src/lib/components/Cover.svelte`.** Cards for places and stays
always show a cover. When a photo exists it is rendered; otherwise `coverArt()`
in `src/lib/cover.ts` hashes the name (FNV-1a) into one of eight muted gradients
and picks a category emoji. The fallback still has to look deliberate rather than
broken; stays never get photos (a proposed "Plaka apartments (5 flats)" is not a
Google place, and a lookup would return someone else's building), so generated
art is their permanent presentation, stable across reloads.
`onerror` falls back to art too, because Google photo references expire.

Google's photo media URLs require the API key as a query parameter, so an
`<img src>` pointing straight at them would leak `GOOGLE_PLACES_KEY` to every
visitor. `src/routes/api/place-photo/+server.ts` proxies them server-side.
Because that endpoint turns caller-supplied input into an outbound request, its
`places/{id}/photos/{id}` allow-list regex is a load-bearing SSRF guard, not a
formality.

**Popup menus are `position: fixed`, anchored by `use:anchor`.** `Select` and
`MultiSelect` used to position their menus absolutely inside the control. That
is fine on a plain page but wrong inside a modal: `.mbody` is a scroll
container, so an absolutely-positioned menu is clipped by it and can push the
modal into scrolling. `src/lib/anchor.ts` instead writes viewport coordinates
onto a fixed-position menu; fixed elements escape ancestor overflow entirely,
and still paint in the top layer inside an open `<dialog>`. The action flips the
menu above its trigger when the space below is cramped, caps its height to the
room actually available, and clamps it horizontally, so a 20-person list can't
run off-screen. It re-runs on capture-phase `scroll` (to catch `.mbody`) and on
resize. Menus are width-capped, so option labels ellipsis rather than overflow.

**Opening a modal must not shift the page.** `Modal` locks page scroll via
`lockScroll()` in `src/lib/scroll-lock.ts`. Setting `overflow: hidden` on the
body removes the document scrollbar, which on classic-scrollbar platforms widens
the viewport and slides the whole page sideways as the dialog appears. The lock
measures `documentElement.clientWidth` immediately before and after applying
`overflow: hidden` and pads the body by exactly the difference. Measuring beats
a hard-coded ~15px because how much width is reclaimed varies: classic
scrollbars free the whole track, overlay scrollbars (macOS, touch, and headless
Chromium) free nothing, short pages free nothing, and `scrollbar-gutter: stable`
keeps the gutter reserved, so a fixed constant would *create* a jump in three of
those four cases. The lock is reference-counted so overlapping dialogs can't
unlock each other.

## Implementation status

Built and verified:
- Design system (`src/app.css`) and shared layout with auth-aware header.
- Marketing landing, trips list, and the full trip workspace (discover with places and
  stays, calendar with parallel tracks and map, costs, expenses, pre-trip, people).
  Every workspace module is backed by the database.
- The trip root and the old `/lodging` route both 307-redirect to `/discover`.
  Trip name, dates and home currency are edited from an "Edit trip" modal in the
  workspace header; because SvelteKit has no layout actions, its form posts
  cross-route to `/trips/[tripId]/settings?/edit`.
- Deleting a place cascades to its scheduled calendar items inside one
  transaction; the FK is `ON DELETE SET NULL`, which would otherwise leave
  orphaned blocks with no location. The confirmation dialog states the count first.
- Real accounts: register, log in, log out. Passwords hashed with `node:crypto`
  scrypt. Session cookie resolved in `hooks.server.ts`.
- SQLite persistence for users, sessions, trips, memberships, cities. New accounts
  start with no trips; a dev-only demo account (`demo@waypoint.test`) is seeded with
  two example trips for exploration.

### Sample data

Two seeded trips, chosen to exercise opposite ends of the layout engine:

- **China, autumn**: four people, five cities. Exercises multi-city timezone handling,
  per-city lodging and budgets.
- **Athens escape marathon** (`src/lib/server/seed-athens.ts`): **twenty** people, one
  city, four days. Escape rooms seat four, so twenty people means *five rooms running
  simultaneously*, which is precisely the case the layout engine exists for. Teams are
  reshuffled between slots (a one-person cyclic rotation on day 2, a full redraft on day 3)
  and the group repeatedly collapses back into one full-width block for meals. On day 2 the
  board goes 5 columns → 5 columns → 1 → 4 → 1 in a single day, and the People swimlane
  shows twenty rows changing colour together at each switch. Every one of the 43 events
  carries an explicit assignee list.

  `node scripts/seed-athens.ts` re-seeds it into an existing dev database (idempotent).
- Trips are real and per-user: list and create from the database, guarded by auth.
- Minimal-transaction settlement runs from `$lib/settlement.ts`.
- Calendar schedule is persisted: tracks and schedule items live in the database
  (`tracks`, `schedule_items`). New China trips are seeded with two parallel tracks
  on one day. The organizer can drag a block to reschedule (5-minute snap, duration
  preserved, clamped to the day) and click a booking tag to cycle its status. Moves
  and status changes go through a JSON endpoint with membership checks and persist
  across reloads. Organizers can add tracks and switch days.
- Expenses (Splitwise-style) are persisted: `expenses` and `expense_participants`
  tables. Members log who paid and pick who shares each cost (equal split). Balances
  and the minimum-transfer settlement are computed server-side per trip. New China
  trips seed a small roster and a few shared expenses so settling has data to show.
  Amounts are in the trip's home currency; cross-currency FX is future work.
- Lodging voting is persisted: `lodging_options` and `lodging_votes` tables, organized
  per city. Members propose stays (name, tag, price, link) and cast a single vote per
  city; re-voting moves the vote, and clicking the current pick clears it. The
  organizer can lock a leading option as the choice. New China trips seed three
  Beijing options with a leading pick.
- POI discovery is persisted (`pois`, `poi_votes`): per-city candidate pools with
  save, upvote, and remove. The city is chosen from a **dropdown**, not a row of pills:
  the pill row grew with the itinerary and wrapped to a second line on a five-city
  trip, moving the cards down with it, whereas a dropdown is one fixed-height control
  whatever the itinerary. Each option carries its own count (`Beijing · 4`), which the
  pills also did, and the count follows the section; a city shows its places count on
  Places and its stays count on Stays. The search box lives **in the header row, beside
  the city selector**: searching is the primary way places get added, so it should not
  cost a click to reach, and it costs no vertical space there. Its placeholder is just
  "Search…"; the accessible name carries the city ("Search places in Athens"), which
  is where that detail belongs once the field sits inside a row already labelled by
  the city selector. The input and the city trigger are both 36px tall and the
  indeterminate progress
  bar is *overlaid* on the input's lower edge, so the header row is exactly as tall on
  Places as on Stays and starting a search adds no height.

  Results render as an **anchored dropdown**, not an in-flow list; they are a
  transient overlay, so finding a place must not push the pool of places you already
  have down the page. It opens **on focus**, not only once results exist: "add
  manually" is the answer to "the provider doesn't have my place", and you often know
  that before typing a character, so the footer is reachable from an empty field. With
  the field empty the footer is the *only* content: a line telling you to search the
  box you just clicked is noise. Short queries say `Keep typing…` rather than sitting
  blank. It dismisses the way a popup should: click away, press
  Escape (deferred while a modal is open, since a `<dialog>` owns Escape), or clear the
  field; focusing the input again brings it back. The whole result row is the click
  target; a small "Add" button next to a wide row is a needlessly small target for the
  only action the row has. The dropdown scrolls at `min(60vh, 380px)`.

- **Stays are searched too, but as a separate search.** The Stays section gets the same
  header search box and the same dropdown, with `kind=stay` restricting Google to
  `includedType: 'lodging'`, verified to cover hotels, hostels, resorts and the
  apartment listings people actually book, and to return *nothing* for a landmark
  query. This is a different search, not the place search filtered afterwards:
  "apartment" in a general search returns letting agents and furniture shops, and
  someone shopping for a bed should never be shown the Acropolis. The Photon fallback
  has no type filter, so it over-fetches (25) and filters to OSM `tourism` lodging tags
  before trimming to 8. Switching section clears the query and results, because hotel
  results left hanging over the places pool are worse than no results. Picking a result
  opens the existing Add-stay modal prefilled with name and website; the cursor lands
  on **Price / night**, the one thing the search cannot supply (Google gives a `$`
  band, not a nightly rate). Both sections' dropdowns carry the same "Add manually"
  footer, which on Stays opens the stay form rather than the place form, so the
  standalone "+ Add stay" button is gone, and adding a stay starts the same way as
  adding a place.

  There is no top-level "Add manually" button. Manual entry is a **sticky footer on the
  results dropdown**: a right-aligned "Add manually" button with the provider
  attribution ("Powered by Google Maps" / "Powered by OpenStreetMap") in small text
  underneath, because that is exactly the moment you learn the provider does not have
  your place. It opens the manual modal prefilled with what you typed. The footer is set
  apart from the rows above by a `--surface-2` tint rather than another rule: it is the
  escape hatch, not one more result. Being a sticky `<li>` at the end of the list, it
  overlays while there is content below and settles into flow at full scroll, so the
  last result is never trapped behind it. When nothing matches, a `.nores` row states
  so and the footer still offers the way forward. Attribution is not decoration;
  showing Places data off a Google map obliges us to credit Google next to the data,
  and the OSM fallback is ODbL. Result rows carry no "Add" pill: the whole row is the
  button, so labelling it added nothing. A row already used still shows **Added ✓** as
  a state marker, and stays clickable, because one place legitimately hosts several
  activities and each is its own card. Repeat adds show **Added ×2**, ×3 …, since a
  bare tick would read as "done" on the one row you may well click again. For the same
  reason a modal opening does **not** dismiss the dropdown: the popup is a layer above
  the results, not a click elsewhere on the page, and treating it as one meant adding a
  place closed the list and the second activity needed the search retyped.

  Duplicates are policed by **title, not by venue**: the add is rejected only when the
  resulting card title already exists in that city, which is exactly the case where the
  same place is being added for the same activity. The rejection keeps the popup open
  and states the reason inside it (a page-level note would sit behind the overlay) so
  the activity can be edited in place.
  (The Stays section has no search box; proposed
  lodging like "Plaka apartments, 5 flats" is not a provider result. That asymmetry is
  content, not an inconsistency.)

  Clicking a result opens a detail popup rather than adding it blind, so the two things
  only the traveller knows, the **activity** and **notes**, are captured at the
  moment of adding. Category is provider-derived and never shown as an input or a card
  chip: on a card of real places the tag was the same handful of words over and over
  and told you nothing the photo and name did not. It survives only to seed
  `Cover.svelte`'s generated art when a place has no photo. `googleCategory()` orders
  its tests **specific before generic** and consults Google's own `primaryType` first,
  because Google tags nearly everything visit-worthy as `tourist_attraction`; testing
  that early collapsed a flea market, a hill and a museum into one bucket.
  Notes are prefilled with the address, and everything else (link, coordinates, rating,
  price, hours, photo) rides along in
  hidden fields. Notes is a `textarea`, and the card's notes line is `white-space:
  pre-line` so typed breaks survive to the card, still clamped to two lines so cards
  keep equal height.

  A saved place is **edited by clicking it**: the cover, name and meta are one
  `<button class="oinfo">` opening an edit modal for name, notes and link. Only those
  three: rating, hours and photo are the provider's answer, not the traveller's, and
  editing them would silently diverge from the source. The button deliberately wraps
  *part* of the card rather than the whole `<article>`: Vote, Open and Remove live in
  the footer, and nesting them inside a button is invalid and unusable by keyboard.
  The same modal names **who voted** for the place, below the fields; it is read-only,
  and the editable thing you came for should not be pushed down by it. The card can
  only afford a count, and a count answers "is this popular?" while the names answer
  "whose evening am I cancelling?", the question you actually have when you are about
  to cut something. It renders as one line of prose ("16 votes: Adaeze, Diego, …")
  rather than avatar chips: past a handful of voters the initials start repeating and
  become noise, and a modal has room for real names where the trip header does not.
  Voter names come from one query per trip joined in memory rather than a
  `group_concat` subquery per row, because a concat needs a separator no person's name
  can contain and no such character exists.
  The provider is pluggable (`$lib/server/places.ts`): keyless OpenStreetMap (Photon)
  by default, or Google Places (New) Text Search when `GOOGLE_PLACES_KEY` is set,
  with Google falling back to Photon on error. Google is pinned to `languageCode: 'en'`
  it otherwise answers in the language of each result, which put Greek addresses in
  a field the user is expected to read and edit. Manual entry remains for venues not in
  the providers. New China trips seed several POIs per city, a few saved for scheduling.
- Cost estimates are persisted (`cost_estimates`, keyed by trip/city/category over
  lodging, activities, food, travel). They render as a section of the **Preparation**
  tab: an editable per-city budget table with a per-person total; add and edit both go
  through a modal. New China trips seed a starting budget per city.
- Preparation checklist is persisted (`trip_tasks`, kind `task` or `packing`) with
  per-person completion in `task_assignees` / `task_done`. Members add, assign to any
  subset of the trip, tick **their own** box, and remove items. Unassigned tasks keep a
  single shared checkbox. New trips seed a starter checklist including multi-person
  items (visa, insurance) with partial progress.
- Coordinate-based travel legs: when consecutive schedule items carry coordinates,
  `schedule.ts` estimates each leg (haversine distance with a padding factor, then
  walk / transit / drive by distance) and renders it between blocks. Saved POIs can be
  scheduled onto a track from the calendar, carrying their coordinates so legs compute.
- Interactive map (`src/lib/components/TripMap.svelte`): a real Leaflet map on the
  calendar with keyless OpenStreetMap tiles. Scheduled items with coordinates render
  as numbered, track-coloured pins with a dashed route line per track, and the map
  fits to the day's stops. Loaded client-side only (dynamic import) so SSR is clean.
- Time-zone awareness (`src/lib/tz.ts`, client-safe): the trip overview shows each
  city's live local time, zone abbreviation, and offset relative to the viewer's own
  zone; the calendar labels the day with its destination city and current local time,
  so schedule times are unambiguous. Offsets are DST-correct via `Intl`.
- Real trip overview (`src/lib/server/stats.ts`): the dashboard tiles and the
  "Needs attention" list are computed from the database (saved places, scheduled
  blocks, tight connections, lodging locked vs. pending, and the viewer's net balance)
  rather than placeholder numbers.
- Multi-currency FX (`src/lib/server/fx.ts`): expenses can be logged in any of ~18
  currencies. Balances and settlement convert every expense to the trip's home
  currency before splitting, so mixed-currency trips settle correctly. Rates refresh
  in the background from a keyless endpoint with a static fallback, so conversion is
  always available and never blocks. Each expense shows its original amount and the
  home-currency equivalent.
- Trip invites & people management (`src/lib/server/members.ts`,
  `/trips/[tripId]/people`): the organizer can invite by email. If an account with
  that email exists the person joins immediately; otherwise a pending invite is
  recorded and a placeholder member stands in until they register. The People tab lists
  members (with organizer / you / sample / invited tags and real emails) and lets the
  organizer remove members, and the header "Invite" button links here.
- Schedule editing (`/trips/[tripId]/calendar`, `schedule.ts` `resizeItem` / `editItem`):
  besides dragging a block to reschedule, its bottom edge drags to change the end time
  (5-minute snap) and a double-click opens an inline editor to rename the stop, change
  its type, or set a travel buffer. Edits go through the same JSON item endpoint with
  `resize` and `edit` ops, guarded by trip membership.
- Richer POI details (`places.ts`, `pois.ts`, discover): when Google is the active
  provider, search results carry rating, review count, price level, and weekly opening
  hours. These show as compact badges on both the search results and the saved-place
  cards (with today's hours highlighted), and are persisted with the POI when added.
  The OpenStreetMap fallback simply omits the fields it can't supply.
- Real routing (`src/lib/server/routing.ts`): the calendar refines each travel leg with
  a real road duration from the public OSRM router instead of a straight-line estimate.
  Results are cached per coordinate pair, each request has a short timeout, and any
  failure falls back to the previous haversine estimate, so travel times always render.
  Short hops keep the walking estimate (the public router is driving-only).
- Editable cities (`trips.ts` `addCity` / `updateCity` / `removeCity`, overview page):
  organizers can add, rename, re-zone, re-date, and remove cities inline on the trip
  overview. Validation covers the IANA time-zone shape, ISO dates, and arrive ≤ depart,
  and at least one city is always kept. Non-organizers see a read-only list.
- Placeholder members (`members.ts`): inviting an email that has no account now creates
  a visible placeholder member (synthetic address, non-login `placeholder:` hash) so the
  invitee shows up on the trip immediately and can be assigned to expenses and votes.
  When they register with that email, `consumeInvites` relinks the placeholder's
  memberships, expenses, and votes to the real account and deletes the placeholder. The
  People tab tags placeholders as "invited"; removing one cleans it up.
- Itemized costs (`costs.ts` `cost_items`, costs page): the estimated-costs view is now a
  line-item table (item, category, city or general, amount) with add / inline-edit /
  remove, per-category subtotals, a grand total, and per-person share. New trips seed a
  few itemized lines per city. The old per-city matrix (`cost_estimates`) is retained
  underneath for compatibility.
- Finer drag snapping (`schedule.ts` `SNAP = 5`, calendar): dragging or resizing a block
  snaps to 5-minute steps, and the live time label snaps too, so times never show
  decimals. Minimum duration stays 15 minutes.
- Travel-before buffers (`schedule_items.travel_before_min`): each event can carry a
  travel buffer that renders as a hatched block directly above it on the calendar. Set it
  from the schedule add form or the inline editor; it persists through the item endpoint.
- Standard time slots (calendar add form): one-click template chips (Flight, Breakfast,
  Lunch, Dinner, Coffee, Free time, Hotel, Transfer) prefill the title, type, and length,
  and the add form now carries an explicit type so non-POI slots save with the right kind.
- City autocomplete & autofill (`geocode.ts`, `/api/citysearch`, `CitySearch.svelte`):
  adding or editing a city now searches a keyless geocoder (Photon, English names) and the
  organizer picks from a dropdown. Country, coordinates, and the IANA time zone are
  autofilled from the chosen result (`tz-lookup`, offline), so those fields are no longer
  hand-typed. Cities store `lat`/`lng`.
- Decluttered overview: the cities panel is titled "Cities" and shows just name, country,
  and dates. The per-city live clock / offset row and footer note were removed to reduce
  noise (time-zone awareness stays on the calendar). The trip header timeline shows city
  names only, without the time-zone label.
- Multi-person assignment (pre-trip): tasks and packing items can be assigned to several
  members via a checkbox dropdown; assignees render as chips. Stored comma-separated.
- Google Maps on the calendar (`GoogleMap.svelte`): when `GOOGLE_MAPS_KEY` is set the
  calendar uses a larger Google map that defaults to previewing the day's city (from its
  coordinates) and draws track-coloured numbered pins with route lines; it falls back to
  the Leaflet/OpenStreetMap map when no key is present.
- Calendar views (`calendar/+page.server.ts`, `+page.svelte`): a Day / 3-day / Week /
  Agenda switcher with previous/next day navigation. Day keeps the full interactive board;
  3-day and Week stack per-day boards (drag, resize, inline edit intact); Agenda is a
  grouped read list. Seeded sample cities carry coordinates so the map previews correctly.
- Multiple schedules via crews/parties (`parties.ts`, `db.ts` `parties` /
  `party_membership` / `party_day`, `tracks.party_id`, calendar): the group can split into
  named crews. Every trip has a default **Everyone** party (backfilled for existing trips);
  tracks belong to a party. The calendar "Crews" modal creates/renames/recolours/deletes
  crews, sets each crew's **city for a day** (`party_day`, so which city on which day is
  person-dependent), and **splits people off** into a crew from a chosen time to end of day
  (time-segmented `party_membership`, non-overlapping per user/day; **rejoin** returns them
  to Everyone). A mid-day split between different cities auto-inserts a **travel bridge**
  onto the target crew's lane. "View as" resolves each person's day through the crew they
  end it with, filtering lanes and switching the banner, map, and time-zone chip to that
  crew's city/lodging. `item_assignees` remains as a finer within-crew filter. Verified
  end-to-end (create crew → crew lane → set city → split → auto-travel → rejoin).


### 5.1 Proposed project structure
```
trip-planner/
  src/
    lib/
      server/
        db/            # drizzle schema, migrations, client
        auth/          # session, providers
        services/      # places, directions, fx, settlement
      components/      # calendar, map, poi-card, vote, expense
      stores/          # svelte stores (trip, calendar, presence)
      utils/           # tz, currency, geo helpers
    routes/
      (auth)/          # login, register
      trips/
        [tripId]/
          discover/    # M2
          calendar/    # M3
          pretrip/     # M4
          costs/       # M5
          lodging/     # M6
          expenses/    # M7
    hooks.server.ts    # auth guard
  docs/DESIGN.md
```

### 5.2 API surface (as built)

Everything is under `/api`, which the web dev server proxies so the browser
stays on one origin. Session is an httpOnly cookie; there is no token.

```
GET    /api/health

POST   /api/auth/register | login | logout
GET    /api/auth/me

GET    /api/account                        profile + IANA time zone list
PATCH  /api/account/profile
POST   /api/account/password

GET    /api/citysearch?q=                  geocoder, session-gated

GET    /api/trips                          list
POST   /api/trips                          create
GET    /api/trips/:tripId                  trip + cities + members
PATCH  /api/trips/:tripId                  rename / re-date / re-denominate
POST   /api/trips/:tripId/cities           add a city (organizer)
PATCH  /api/trips/:tripId/cities/:cityId   re-date a city (organizer)
DELETE /api/trips/:tripId/cities/:cityId   remove a city, never the last one

GET    /api/trips/:tripId/discover                    places + stays + votes
GET    /api/trips/:tripId/discover/search?q=&cityId=&kind=
GET    /api/trips/:tripId/discover/details?id=
POST   /api/trips/:tripId/discover/pois
PATCH  /api/trips/:tripId/discover/pois/:poiId
DELETE /api/trips/:tripId/discover/pois/:poiId
POST   /api/trips/:tripId/discover/pois/:poiId/vote
POST   /api/trips/:tripId/discover/stays
POST   /api/trips/:tripId/discover/stays/:optionId/vote | /lock
PATCH  /api/trips/:tripId/discover/stays/:optionId/dates
DELETE /api/trips/:tripId/discover/stays/:optionId

GET    /api/trips/:tripId/calendar?day=&view=          board for the visible days
POST   /api/trips/:tripId/calendar/tracks
DELETE /api/trips/:tripId/calendar/tracks/:trackId   takes its items with it
POST   /api/trips/:tripId/calendar/items
PUT    /api/trips/:tripId/calendar/items/:itemId/assignees
POST   /api/trips/:tripId/calendar/items/:itemId/op    move|resize|edit|cycle|delete
POST   /api/trips/:tripId/calendar/crews
PATCH  /api/trips/:tripId/calendar/crews/:partyId
DELETE /api/trips/:tripId/calendar/crews/:partyId
PUT    /api/trips/:tripId/calendar/crews/:partyId/day
POST   /api/trips/:tripId/calendar/crews/split | /rejoin

GET    /api/trips/:tripId/expenses                     rows + balances + settlement
POST   /api/trips/:tripId/expenses
DELETE /api/trips/:tripId/expenses/:expenseId

GET    /api/trips/:tripId/pretrip                      tasks + packing + budget
POST   /api/trips/:tripId/pretrip/tasks
POST   /api/trips/:tripId/pretrip/tasks/:taskId/toggle
DELETE /api/trips/:tripId/pretrip/tasks/:taskId
POST   /api/trips/:tripId/pretrip/costs
PUT    /api/trips/:tripId/pretrip/costs/:itemId
DELETE /api/trips/:tripId/pretrip/costs/:itemId

GET    /api/trips/:tripId/people                       members, invited ones included
POST   /api/trips/:tripId/people/invites
DELETE /api/trips/:tripId/people/:userId               also revokes an invite
```

Choices worth the words:

**The section GET endpoints return the page payload, not a normalised
resource.** `GET /calendar` returns the whole board: days, tracks, per-crew city
and lodging cells, membership segments and the maps key. That is what the
SvelteKit `load` returned, and it is one round trip instead of six. The cost is
that it is shaped for a screen rather than for reuse, which is the right trade
while there is exactly one consumer.

**One `/op` endpoint for the five item mutations** (move, resize, edit, cycle
booking, delete) rather than five REST verbs. The calendar fires all of them
from one drag handler and the ownership check is identical, so splitting them
would spread that check across five places for nothing.

**Votes are POST, not PUT.** Sending the same request twice is a vote and then
an un-vote. That is the intended behaviour, so claiming idempotence would be a
lie.

**Membership is checked once, by the router.** Each section router applies
`requireMember`, which conflates "no such trip" with "a trip you cannot see" so
trip ids cannot be probed. No handler repeats the check.

**Split weights are a map, not flattened keys.** The SvelteKit form had to send
`w:<userId>` fields because FormData has no nested values. JSON does, so the
body carries `weights: { userId: number }`.

**Untrusted bodies go through `parse.ts`.** A JSON field can be missing, null,
or an object, and `String(x)` on an object yields "[object Object]" rather than
failing. FormData could only ever yield strings, so the old `String(f.get(k) ??
'')` idiom was safe and the JSON equivalent is not.

**Known gaps, inherited rather than introduced.** `tracks` has no delete, and
`addCity` / `updateCity` / `removeCity`, `getBudget` / `setBudget`,
`toggleSave` and `linkedItemCount` exist in `packages/server` but no UI ever
called them. They are deliberately not exposed: the API mirrors the app that
exists. Cities currently only arrive via seed data, which is a real product gap
to close before the Svelte app is retired.

---
## 6. Data Model (Drizzle-style sketch)

```ts
users(id, email, passwordHash, displayName, homeTz, createdAt)
trips(id, organizerId, name, startDate, endDate, homeCurrency)
memberships(userId, tripId, role)                 // organizer | member
locations(id, tripId, name, tz, lat, lng, arriveDate, departDate)
pois(id, tripId, locationId, name, category, lat, lng,
     openHours jsonb, priceLevel, url, source, addedBy)
tracks(id, tripId, name, color)
schedule_items(id, trackId, type, poiId, startUtc, endUtc, tz,
     bookingStatus, cost, currency, notes)
schedule_item_assignees(itemId, userId)
travel_legs(id, fromItemId, toItemId, mode, durationMin, distanceM,
     cost, currency, provider, cachedAt)
lodgings(id, locationId, name, pricePerNight, currency, url, lat, lng)
votes(id, tripId, targetType, targetId, userId, rank)   // targetType: poi|lodging
expenses(id, tripId, payerId, amount, currency, description, splitRule, createdAt)
expense_splits(expenseId, userId, share)                // shares/exact/percent
```

Enums: `role`, `item_type (poi|meal|travel|lodging|freetime|meetup)`,
`booking_status (booked|tentative|unbooked)`, `travel_mode (walk|drive|transit|rail|flight)`.

---

## 7. Notable Algorithms

### 7.1 Minimal-transaction settlement
1. Convert all expenses to home currency (FX at expense date).
2. Net balance per user = paid − owed.
3. Greedy match largest creditor with largest debtor until all ≈ 0.
   Produces ≤ n−1 transactions.

### 7.2 Travel-fit conflict check
For consecutive items A→B on a track: required = A.end + leg(A,B).duration.
If required > B.start → flag conflict (insufficient travel time).

### 7.3 Time-zone rendering
Persist `startUtc` + item `tz`. Display = `DateTime.fromISO(startUtc,{zone:'utc'}).setZone(item.tz)`.
Optional viewer overlay = `.setZone(user.homeTz)`.

---

## 8. Delivery Phasing

- **MVP (Phase 1)**: accounts, trips + locations, POI discovery pool, **single-track
  calendar** with map + travel ETA, basic booking status.
- **Phase 2**: multiple tracks, lodging voting, cost rollup, full time-zone rendering.
- **Phase 3**: Splitwise settlement, pre-trip checklist, realtime multi-editor,
  cross-trip references.

---

## 9. Open Questions
- Places/Directions provider choice (Google vs Mapbox vs OSM); affects cost & ToS.
- Self-host vs managed backend (Supabase) for realtime + auth.
- Offline/mobile support scope for on-trip use.
- Notifications channel (email vs push) for pre-trip reminders.
