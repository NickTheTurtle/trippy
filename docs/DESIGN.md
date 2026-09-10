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
1. Schedule items are **typed** (poi / food / transport / travel / lodging / free-time).
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
ScheduleItem 0..1─ POI    (poi/food items reference a POI)
ScheduleItem 1─* TravelLeg (leg to the next item)
Trip 1───* Expense
Expense *─* User          (participants via ExpenseSplit)
Lodging 1─* Vote ; POI 1─* Vote
```

### 2.2 Item-type vocabulary (reconciled)

The canonical set, exported as `ITEM_TYPES` from `@trippy/core` with `ItemType`
derived from it:

```
poi | food | transport | travel | lodging | freetime
```

This document previously specified `poi | meal | travel | lodging | freetime |
meetup`, and `packages/core/src/types.ts` matched it, but nothing imported that
type. The literals that were actually **persisted, validated and rendered** were
the other list: the server's edit validator, the API's item-type guard and the
calendar's type picker all used `food` and `transport`, and no client could
produce `meal` or `meetup` or render a label for either. A vocabulary that
enforces nothing is worse than no vocabulary, so the implemented set won and the
spec was corrected to it rather than the other way round.

Only seeded demo rows ever carried `meal` (9 rows in the live database, from the
sample day). An additive, idempotent migration in `db.ts` renames them:
`UPDATE schedule_items SET type = 'food' WHERE type = 'meal'`. The seed sources
(`packages/core/src/sample.ts`, `packages/server/src/seed-athens.ts`) now emit
`food` directly, so the migration has nothing to do on a second run.

`meetup` was dropped rather than implemented: it never existed in the schema, the
API or the UI, and an assignee list already expresses "these people are meeting
here". `transport` (a flight or long leg placed on the board as a block) and
`travel` (the shorter hop between two stops) both stay, because the calendar's
quick-add offers them as different things.

### 2.3 Discover buckets (`pois.kind`)

Discover filters places by one user-facing bucket, exported as `POI_KINDS` from
`@trippy/core`:

```
attraction | food
```

This is a stored column (`pois.kind TEXT NOT NULL DEFAULT 'attraction' CHECK (kind
IN ('attraction', 'food'))`), not something derived at render time. `pois.category`
is whatever the provider said (Google place types, OSM tags, and for older rows a
display label that `places.ts` had already normalized), so classifying it in the
view would mean every client reimplementing the same string matching against a
vocabulary neither of them controls, and would make a place impossible to
re-bucket by hand. Storing it once, at write time, keeps the filter a plain
indexed predicate and lets a traveller correct a mistake.

Existing rows were backfilled once by the migration that added the column, using
`poiKindFromCategory` from `@trippy/core` (the same classifier the seeds use, so a
fresh demo database and a migrated one agree). The backfill is gated on the column
having just been created, which is both what makes it idempotent and what stops it
from silently undoing a later hand correction. Live data at migration time was 25
places: 23 `attraction`, 2 `food` (categories `Food` and `Nightlife`). `Nightlife`
counts as food because the bucket the UI shows is "Food & Drink".

**Stays are not a kind.** The Discover dropdown offers Attractions / Food & Drink /
Stays as three choices, but Stays is a view switch onto `lodging_options`, a
different table with votes, a lock and a nightly price. `'stay'` is deliberately
not a legal value of this column, and the CHECK constraint rejects it.

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
  - **Anyone may tick anyone's box**: `toggleTask` takes a `targetId` and accepts
    any assignee of the task, from any member of the trip. The row records who the
    task is *for*, not who pressed the button. It still refuses a non-member, and a
    target the task is not assigned to.
- Who has finished is a menu on the row, one entry per assignee, and each entry
  is the control that ticks that person off.
- **A task can be rewritten in place.** `updateTask` takes new wording and a new
  roster together; the ticks of everyone still on the task survive it, and the
  tick of anyone taken off is dropped with them.
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
- **Surfaced inside Discover**, not as its own tab; the header type dropdown
  (Attractions / Food & Drink / Stays) switches the grid. The two share one card
  design (cover art, vote pill, open icon, remove, and the tally along the bottom
  edge); stays additionally show price/night, "Edit dates" and "Lock as choice".
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
| `apps/svelte` | The original app | **Deleted at parity** |
| `apps/mobile` | Expo / React Native (not yet created) | n/a |

**The SvelteKit app is gone.** It was kept runnable through the port so any
behaviour could be compared against the original rather than against memory.
Once the React app had passed a review of every page, keeping it stopped paying:
it was stale by design, so every difference had to be argued about before it
could be dismissed, its `svelte-check` warnings were the only noise in an
otherwise clean `npm run check`, its seed script had been broken since the
monorepo move, and it held the last em dash in the tree. It is one `git revert`
away if it is ever wanted. The one thing worth keeping, `scroll-lock.ts`, was
already copied into `apps/web`, and its `.env` was byte-identical to the root
one.

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

**Getting out of a trip: two different actions, never one that branches.** The
header offered no way out at all, so the only exit was abandoning the row. The
organizer now deletes from inside the edit dialog, which is where the rest of
the trip's settings already live, and everyone else gets a **Leave trip** button
in the same header slot the edit button occupies. They are separate endpoints
(`DELETE /trips/:id` and `POST /trips/:id/leave`) rather than one that decides
by role, because they destroy wildly different amounts of data and a member must
never be one permission bug away from wiping the group's trip. The organizer
cannot leave: that would orphan the trip, so their refusal names deleting
instead.

Leaving takes only the membership row. Expenses paid, shares owed and votes cast
all stay, because the ledger has to keep balancing and a departure is not a
reason to rewrite what the group already agreed. Deleting takes everything: each
trip-scoped table cascades from `trips(id)`, so one statement clears cities,
places, stays, votes, schedule, crews, expenses, budget and tasks. The one thing
that does not cascade is a **placeholder user**, the account an invite creates
before that person registers. It is owned by the trip that invited it but lives
in `users`, so deleting the trip would strand it with no membership, invisible
and unreachable forever. `deleteTrip` sweeps up any placeholder left without a
membership, in the same transaction.

The confirmation is the shared `ConfirmDialog`, and deleting closes the edit
dialog rather than opening on top of it: two stacked modals mean two scroll
locks and two Escape handlers. Cancelling reopens the edit dialog, so a change
of mind does not also close the thing you were editing.

**Every confirmation says one sentence: "Are you sure? This action cannot be
undone."** Each of the six delete flows used to explain its own blast radius,
some of them with live counts. The result read as six different voices arguing
for the same decision, and the longer bodies were the ones people skipped. The
name of the thing being destroyed carries the specificity instead, so it moved
into the title: *Delete Kyoto in Spring?*, *Remove Sam?*, *Delete Hotel
deposit?*. `ConfirmDialog` therefore takes no `body` prop at all, which is what
stops the explanations growing back one page at a time.

The cost is real and was accepted deliberately: removing an invited-but-never-
registered member deletes the expenses they paid and moves everyone's balances,
and the dialog no longer says so. The rule that the wording is identical
everywhere was judged worth more than the one screen where a warning helped. The
`GET /people/:userId/removal-impact` endpoint, its client type, and the
`removalImpact` query that fed those counts are gone with the copy; the cascade
they documented is now recorded on `removeMember` itself, which is where it
actually happens.

**An empty list draws a fly, not an explanation.** The places in a city, the
task list, and the packing list all start out empty, and the old treatment was a
grey line of text and a button repeating the Add already sitting at the top
right of the same panel. That is three pieces of furniture saying one thing.
`EmptyMark` replaces them with a single drawing: a fly on a long dashed S of a
flight path, above one shared caption, `Nothing added yet.`

The choices worth recording. **One caption for every section**, not a
section-specific sentence, because "No tasks yet" next to a heading that says
Tasks is the kind of restatement the rest of the copy has been pruned of.
**A joke, not an icon**, because an empty list is not an error and this is the
only screen in the app with room for one: a fly with no idea where it is going
is what a trip nobody has planned yet actually looks like. **No background
tile**: a filled shape behind the drawing read as a large unpressable button.
**No action button** in the empty state, since every one of these panels already
has its own Add control a few pixels away.

Explicit `width` and `height` on the `svg` rather than Tailwind size classes.
The utility classes are only emitted for values already used elsewhere in the
tree, so a new one silently does nothing and the drawing stretches to fill its
container.

Deliberately not applied to the expenses list, the estimated-costs table, or the
trips page. Those are tables and a top-level index rather than a section of a
trip, and the first two share a screen with a real total; a drawing there would
be decoration rather than an answer.

**The trip shell owns the trip fetch; sections read it from outlet context.**Every section needs the same trip record. Letting each one fetch it would mean
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

**A row is a box, a label, and a menu of who has finished.** The earlier row
carried four different things on its right, and which ones appeared depended on
the task: a bare name for one assignee, or a progress bar that expanded a roster
for several, plus a "You: to do" tag, plus a leading box that was a button, an
inert dashed box or a shared tick depending on whether the task was yours. Five
rows of that were five different layouts, and the answer to "who still has to do
this" was behind a click.

A chip per person replaced all of it and was right for a small trip, but it
sized the row by the size of the group: a dozen names wrapped over three lines
and pushed the label out of the way. The menu is the same control at a fixed
width. Its trigger reads "1/3 done", which is the part that actually gets read
at a glance, and opening it shows the names with the ticks. It reuses
`MultiSelect`, with a `summary` override, because "who is finished" is not the
same sentence as the list of names its ticks would otherwise spell out.

**Anyone can tick anyone's box.** The old rule was that completion is personal
and the server refused any target but the caller. It was wrong about how a group
trip works: people say "I've done mine" out loud, and one person is holding the
phone. Refusing the tick did not make the list more accurate, it just left it
stale. Every entry in the menu is pressable by everyone.

**The leading box is the whole task, including a third state.** On an unassigned
task it toggles the shared flag. On an assigned one it brings the entire roster
to the same state, walking the per-person endpoint, because the API has no bulk
call and inventing one for a button would put the same rule in two places. It
shows a dash when some but not all are done: without that, two people out of
three finished looks exactly like nobody having started.

**Editing a task is not deleting and re-adding it.** Both halves of a task
change as a trip firms up: the wording, because "book something" becomes "book
the 9:40 ferry", and the roster, because the person it was for drops out. The
only way to do either was to delete the row, which threw away every tick on it.
`PUT` takes both at once and keeps the ticks of everyone still on the task.

**The menu is quiet until it is wanted.** A bordered trigger on every row drew a
column of boxes down the card that out-shouted the rows themselves, so at rest
the trigger is just the count; the border and the caret arrive on hover, focus
or opening.

**Glyphs are drawn, not typed.** The row's marks were text characters (✎, ×, ✓,
–). Those are rendered by whatever font the platform has for them, so their
weight never matched the row and some systems drew the pencil in colour as an
emoji. They are inline SVG in `components/ui/icons`, which also became the home
of the icons Discover had defined inside one of its own page files.

The same argument reaches the checkbox. A native `input[type=checkbox]` paints a
tick the browser chooses and sets a little high of centre, which read as a
misprint beside our own square. `components/ui/CheckBox` keeps the real input,
invisible and full-size on top, so labels, focus and the keyboard behave exactly
as before, and draws the box and the tick itself.

**Assigning is a menu, and it is empty by default.** A task belongs to the trip
until somebody claims it, so the dialog's second field is one closed dropdown
reading "Assign to...". Leaving it alone leaves the task shared, which is the
common case; an always-open roster of names made it look as though a task
*needed* an owner. It is a `MultiSelect` rather than a grid of checkboxes: the
grid was fine for three people and unreadable for twenty, and the dropdown is
already how the row itself asks who has finished.

**Packing takes no roster at all.** A task is work handed out; a packing item is
your own bag, so asking who it is for is a question with one answer. The dialog
for one is a single field, the row carries no menu, and the item keeps the one
shared tick. The rule is enforced in `addTask` and `updateTask` rather than in
the form, so no client can put a roster back on, and a migration folds any rows
an earlier version left behind into the shared flag: an item everyone had ticked
stays ticked.

**"Assigned to me" takes the whole row out of the list.** The full list is sorted
by what is outstanding across everyone, so your own two jobs can be anywhere in
it. The block answers the question most people open the tab for. It holds the
real row, roster menu and pencil and bin included, and those rows leave the list
below rather than being repeated in it: the same task in two places is two boxes
to reason about, and one ticked while its twin sits unticked a few pixels down
reads as a bug. It is the same `TaskList` in both places, given a `boxFor`, which
is the one difference between them: your block's leading box ticks *your* row,
where the full list's ticks the whole task's. Ticked items stay in the block,
checked and sorted last: dropping one the moment you tick it makes the row you
just pressed vanish, and takes away the only place you could undo it. The lists
are titled only while the tab is actually split, and the lower card is not drawn
at all when everything is yours. It is tasks only. Packing is already a list of
your own things.

**The empty box shows its tick on the row's hover, not its own.** An 18px target
that only reveals what it does once the pointer is inside it tells you too late.
Faint ink as soon as the row is hovered, accent once the pointer arrives.

**Editing and deleting are on hover, not always visible.** Every row carrying a
permanent pencil and bin makes a long list feel hostile and invites misclicks.
They are revealed by the row's `group` hover and by keyboard focus, so they are
still reachable without a mouse.

**Add and Edit are the same dialog, for a task and for a cost alike.**
`id === null` means add. The fields, validation and layout are identical, and
keeping them as one component is what stops the edit form from quietly falling
behind the add form.

**The add button says "+ Add" and nothing else.** It used to name what it added:
"+ Add task", "+ Add item", "+ Add cost". The section nav sits immediately to its
left with the current section highlighted, so the noun was the same word twice on
one screen.

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

**The search is the Name field of the add form.** There used to be a search box
in the header whose dropdown carried an "Add manually" escape hatch, and that
hatch opened a second, near identical form. Two forms for one intent made the
manual path something you had to discover, and a found place and a typed place
were filled in differently. There is now one popup: type in Name, results appear
under it, pick one to fill in the provider data or ignore them and submit what
you typed.

**Adding closes the popup.** It used to stay open for places, on the reasoning that
one place is often added several times, once per activity, and it counted the adds in
the footer. That optimises for the rarer case: most adds are one place, and the reward
for the common path was a dialog that would not go away and a running total nobody
asked for. Adding now closes, the same way a stay always did.

**The picked result shows a picture, not a panel.** Confirmation that the right
place was chosen is a thumbnail, the rating and today's hours on one line, and a link
to detach it. What was there before was a tinted box that also repeated the address,
which is already prefilled into the Notes field a few rows below it.

**Switching type clears the search.** Places and stays are different searches
against different provider filters, and one's results never apply to the other.
Leaving hotel results hanging over the places pool would let you add a hotel as a
place with two clicks.

**The whole result row is the button.** A small "Add" button beside a rich result
made the click target far smaller than the thing it acted on.

**Deleting a place is confirmed, deleting a stay is not.** A place can have
calendar events pointing at it, and those go with it; the dialog says how many.
A stay carries only votes.

**Stays get cover photos from the same pipeline as places.** Every option in the
lodging vote rendered as the same grey bed icon, which is nothing to vote on when
the choice is between an apartment, a villa and a hostel. `lodging_options` gains
the same nullable `photo` column, and the backfill that already runs on the
Discover load now covers stays too: null means never asked, the sentinel means
asked and Google had nothing, so each stay costs at most one lookup ever. Stays
hold no coordinates, so the lookup is biased by city and country alone, which is
specific enough for a hotel name. A stay added from the hotel search carries its
photo straight over and skips the lookup entirely.

**Remove on a place card waits for hover.** It was a red link under a divider on
every card, so a 14 place city put fourteen red links on the page for the action
almost nobody takes, while the card's real affordance (click it to edit) is
silent. The link keeps its space so the grid never shifts, comes back on hover,
on keyboard focus anywhere in the card, and unconditionally where the device has
no hover.

**The page's two axes were swapped.** The sidebar used to switch between Places
and Stays while a dropdown in the header chose the city, which put the rarely
changed choice in the persistent control and the frequently changed one in a
popup. Cities are what everything on the page is scoped to, so they are now the
standing list, sorted alphabetically because this is a lookup ("where is
Kyoto?") and the itinerary's own order is what the calendar reads from. The
header dropdown now chooses the
type: Attractions, Food & Drink, Stays. There is no "All", because the first two
filter `pois.kind` while Stays swaps the list for `lodging_options` and a
different card (see 2.3).

**Adding and deleting a city are organizer-only on the server, so those controls
are hidden from everyone else** rather than shown and refused. Deleting is
confirmed and the dialog names what goes: the city's places and stays with every
vote on them, and its estimated costs. Scheduled calendar items are deliberately
*not* named as deleted, because they are not: their FK is `ON DELETE SET NULL`,
so a block keeps its title and slot and only loses the link back to the place.
That is worth saying, because deleting a single place *does* take its calendar
events, and the reader would reasonably assume the same here.

**The card footer is two controls, left aligned.** It used to be four: a vote
bar, the text "5 votes", an "Open" button and a "Vote" button, laid out with
`justify-between` so the buttons sat against the right edge with a gap that grew
with the card. Three of the four said the same thing (the bar, the count and the
button's Voted state), so the count and the button collapsed into one vote pill,
a caret plus the count, filled in accent when you have voted. "Open" became a
compass icon keeping the same accessible name it had as text. The vote bar moved
flush to the card's bottom edge, where it reads as an indicator on the card
rather than a fourth thing competing in the row. Both card types share the
treatment; a stay keeps its price, nights and the organizer's lock.

**Icons are inline SVG with `currentColor`.** That is what the app already did
for the one icon it had (`Modal`'s close button), so no icon dependency was
added for four small glyphs.

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

**Every picker offers the value it currently holds.** An event dragged on the
board snaps to 5 minutes and a travel buffer is estimated from distance, so a
saved event routinely sits off the option grid: 10:05, 75 minutes, a 9 minute
hop. A `Select` whose value matches no option falls through to its placeholder,
so the detail dialog read "Select..." for a field that was set, and the only way
to see the real number was to save something else. `withCurrent(options, value,
label)` unions the offered list with the held value and re-sorts, and the three
affected pickers (Start, Duration, Travel before) go through it. The add form
does not need this because it can only start from the option lists. This is the
same failure as the account time zone picker and is now stated once as a rule
under shared conventions.

Both schedule forms, the crew add form and the split grid use the shared `Field`
and `FieldShell` like the rest of the app; the hand-rolled label and input rules
they used to carry are gone from `calendar.css`.

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

### 5.0.8 Adding and removing cities

**Every section is scoped to a city, and until this existed nothing could create
one.** `createTrip` inserts a trip, a membership and the default Everyone party,
and no city, so a freshly created trip rendered "Add cities to this trip to start
collecting places." with no control anywhere in the app that added one. The three
server functions (`addCity`, `updateCity`, `removeCity`) had been written and
were fully unreachable: no route, no UI. The app only worked on seeded data.

**Cities are added from the page they are the axis of, not from the Edit trip
dialog.** The Edit trip form saves on submit; adding a city takes effect
immediately. Sharing a dialog between the two would leave the user unable to tell
which half of it was already saved, and Cancel would mean two different things in
one box. So the entry points are both on Discover: the city sidebar's "Add city"
button, and the empty state's call to action when there are none.

**The dialog adds; the sidebar deletes.** `AddCityDialog` used to list every city
with its own Remove button, which was the sidebar's job done a second time: two
views of one list, guaranteed to disagree the moment either changed. The dialog
is now a single search field, and the sidebar is the one place a city is removed.
The sidebar's delete button is overlaid on its row rather than laid out beside
it, so a city button is exactly as wide as the Add city button under it; the
trailing space is reserved whether or not the button is showing, so revealing it
on hover never reflows the label.

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

**Cities are dateless places, not schedule spans.** `cities.arrive` and
`cities.depart` were removed because an itinerary city answers "where", while
`trips.start_date` / `trips.end_date` answer "when". Keeping per-city dates made
the app pretend it knew which city every day belonged to. Until the calendar
redesign adds real day-to-city assignment, the calendar uses the first city as
the trip-wide default and lets `party_day.city_id` be the only explicit override.
It deliberately does not slice the trip range across cities in sort order,
because that would fabricate the schedule this change removes.

**The last city cannot be removed** (`removeCity` refuses, and the button is
disabled with a `title` saying why). Removing it would put the trip back into
exactly the dead-end state this feature exists to get out of. Disabled rather
than hidden: a button that vanishes as you delete down to one looks like a bug.

**A trip must have both dates.** They started out optional, for the "we know
where, not when" case, and produced a `Dates TBD` placeholder wherever a range
was rendered. That placeholder was a label pretending to be data: the schedule,
per-day costs and the travel-fit check all read the endpoints, so a dateless
trip was one that could not use half the app. `createTrip` and `updateTrip` now
reject a blank date, the two date fields lost their "(optional)" suffix, and
`formatDayRange` takes two days rather than two nullables, which is what deleted
the placeholder string outright.

Existing dateless rows are anchored by migration to the day the trip was
created, as a single-day trip. That invents no travel plan, it is traceable to
something real, and one edit corrects it. The same migration recomputes the
stored `dates` label wherever it disagrees with the endpoints, since the label
is now always derived from them; it had drifted on rows written when the label
was free text. The columns stay nullable on purpose: tightening them to NOT NULL
means rebuilding a table several others reference by foreign key, which is not
worth the risk when the two writers both validate.

### 5.0.9 The expense ledger

**Each row shows when it was logged.** The list is ordered newest first and the
rest of the row is a payer, a split and an amount, so two similar dinners were
impossible to tell apart and the ordering itself was unexplained. It is the
`created_at` the row already carried, not a new field: nobody is asked to date an
expense they are typing in now, and there is no schema change. The year is shown
only when it is not the current one, since it would otherwise repeat on every row
of the page.

### 5.0.10 The trip list

**A trip card leads with its first city's photograph.** The cards were flat
gradients on the first screen anyone sees after signing in, while every other
card in the app had gained a real picture. The same lookup and the same proxy
serve it, and the trip's gradient stays as the fallback so a trip with no cities
yet looks exactly as it did before. Only the first city of each trip is looked
up, because that is the only one a card shows, which also keeps the cost of
opening this page proportional to the number of trips rather than to the number
of cities in them.

**A card says how many cities, not which ones.** It used to list the names
joined by a chevron, which read as an itinerary, but cities are stored as an
unordered pool: the arrows implied a route nobody had chosen, and on a trip with
eight stops the line wrapped to three. The count answers what the line was
really for, which is telling two trips apart.

**Cards say how many people are on the trip.** The card already answered where
and when and what your role is; group size is the other thing that distinguishes
two trips at a glance, and it is one aggregate on a query that already runs.

**The photo pipeline is now used in three places**, so the rule is worth stating
once: a nullable `photo` column, `NULL` meaning never looked up and a sentinel
meaning looked up and missing, a backfill on the page that displays it, and the
value carried straight over when the record came from a search that already had
one. `pois`, `lodging_options` and `cities` all follow it.

### 5.0.11 The signed-out front page

**It was still the port's smoke test.** `/` rendered a card headed "Port smoke
test" showing `settle()` output for three made-up people and the current time in
three zones. That was deliberate on day one, to prove `@trippy/core` resolved
through the workspace link and the Tailwind theme had picked up the ported
tokens, and both have been proven a thousand times since by the app itself. It
was the first thing a stranger saw. It is now a real page: what the tool does,
in six lines that each describe something it does today, and the same two actions
the header offers rather than a third phrasing of them. The primary action is
registering, because anyone with a session is redirected to `/trips` before this
page renders, so a link into the app would only ever be followed by someone who
cannot use it.

## Shared UI conventions

These exist so five pages don't each invent their own version. Reach for them
before adding page-local CSS.

**All user-facing text lives in `apps/web/src/copy.ts`.** One `export const
copy` object, nested to mirror the surfaces and ordered by user journey. The
point is not localization, which is not planned; it is that the owner can read
and edit the app's entire voice in one file without opening 48 components. A
key is named for the role the string plays, not for the words it currently
contains, so rewording never forces a rename. Strings that interpolate become
functions, and any existing pluralization moves inside them, so the sentence
stays whole rather than being reassembled at the call site.

Only authored prose moves. Icon glyphs, CSS classes, route and API paths, query
keys, SSE event names, currency codes and IANA zone names stay put: they are
identifiers that happen to be strings. Developer-only throws and `console`
messages stay too, since no user reads them. `Calendar.tsx` is excluded while it
is frozen; its strings fold in during its redesign.

**Helper text is the exception, not the default.** The app had drifted into
explaining itself: a hint under a field repeating the field label, an empty
state whose message, hint and button all said "add one" beside a button that
already said it. The rule now is that a hint earns its place only by stating a
non-obvious constraint or a consequence the user cannot see. "At least 8
characters" stays because it is a rule the form will enforce. "This cannot be
undone" and the delete confirmations that name what is destroyed stay because
they describe real loss. Everything that merely restated its own label or the
button beside it is gone, and `EmptyState` lost its `hint` prop entirely once no
caller passed one. An empty Discover grid now shows nothing at all, because the
primary "Add a place" button sits directly above it.

**Where a file goes in `apps/web/src`.** Sources are grouped by role: `hooks/`,
`lib/`, `styles/`, `components/`, and `pages/`. The one boundary that needs a
rule is `components/ui/` versus `components/`: a `ui/` component is generic and
would drop into another app unchanged, while a top-level component knows about
this domain, meaning it imports `Trip`/`TripCity`, calls `/trips/...`, or renders
a trip concept. The test is the import list, not how widget-shaped something
looks: `Cover` sits at top level despite being a plain card, because it imports
`coverArt` from `@trippy/core/cover`. `GoogleMap` is the deliberate exception,
kept top level even though it imports only React, because its props are authored
around itinerary tracks (per-day polylines, numbered pins) and `TripMap`
re-exports its `MapTrack` type.

The layout previously said nothing: 16 loose files at the root of `src` and 19
flat ones under `components/` that mixed generic widgets with trip-specific
ones, with `pages/discover/` the only page ever given a folder. Grouping by role
means a new file has one obvious home. A page earns a folder of its own once it
grows dialogs, cards or rows worth naming; `pages/discover/` is the pattern to
copy.

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
go in a `.fhint` under the field (as on password fields), which is what
`Field`'s `hint` prop renders.

**Fields: `src/components/ui/Field.tsx`, styled by `.field` and `.input`.** Four
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

**Modals: `src/components/ui/Modal.tsx`.** Every dialog in the app uses it.
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

**`ModalFooter` writes the `.mfoot` row, and every dialog uses it.** Seven
dialogs had hand-written the same three things: the failure message, a Cancel
that closes, and a primary button that swaps its label while the request is in
flight. They had already drifted, one omitting the message and one saying
"Close" where the rest said "Cancel", which is the usual fate of a shape copied
by hand. The primary button submits the surrounding form; `onSubmit` turns it
into a plain button for `AddCityDialog`, whose body is not a `<form>`, and
`start` takes the delete that the trip form pins to the left.

Add and Edit remain **one component per thing**, not one per verb: `TripFormDialog`,
`EditTask` and `EditCost` each take a draft whose `id === null` means add. The
exception is Discover, where adding is a provider search that fills a form and
editing is a form over a saved row; those stay separate components and share
their fields through `place-fields` instead.

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
overflowed narrow modal rows. A percentage cannot resolve inside a shrink-to-fit
parent either, so a `Select` in an inline-flex wrapper needs a flat width.

**A `Select` must always be given the value it holds as an option.** A value
matching no option renders the placeholder, so a set field reads as unset while
the state underneath is fine. Any list that can meet a value from outside it
(zones the platform omits, times off the grid, estimated durations) unions the
held value in before rendering.

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

**Section sidebars: `src/components/ui/SectionNav.tsx`.** A page with
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
(`src/components/Cover.tsx`): a place's Google Places photo: the
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

**One home for the backlog: `packages/server/src/photos.ts`.** The same backfill
had been written three times (trip cities, places, stays) with three different
caps: two of them unbounded. How much billed Google traffic a page view
triggered therefore depended on which table happened to have accumulated nulls,
which is not a decision anyone made. `backfillTripPhotos(tripId, cap?)` and
`backfillTripListPhotos(userId, cap?)` are now the only entry points; both cap a
single request at `PHOTO_BACKLOG_CAP` (24) lookups and run at most 4 at a time,
so a large backlog drains over several visits instead of being billed at once
and opening dozens of sockets. The at-most-one-lookup-ever rule and the
`NO_PHOTO` sentinel are unchanged.

**Cover images: `src/components/Cover.tsx`.** Cards for places and stays
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

- **A city can only be on a trip once.** Identity is name + country + region, compared
  trimmed and case-insensitively, and both `addCity` and `updateCity` refuse a
  collision. The region has to be part of the test rather than the name alone, because
  a trip can legitimately visit Nashville, Tennessee and Nashville, Georgia, or both
  Parises. Coordinates are deliberately *not* the test: they come from whichever
  geocoder row was picked, so the same city reached by two different searches can carry
  slightly different numbers and would slip through. The add-city search marks a city
  the trip already holds as `Added` and makes the row unpickable, so the rule is
  visible before it is enforced; the server still refuses, since the dropdown is a
  convenience and not the guard. No UNIQUE index backs it, on purpose: the real
  database already holds one duplicated city, and adding the index would either fail on
  boot or require deleting somebody's data. `addCity` is the only writer.

- **Typing reaches Autocomplete; only a query it cannot answer reaches Text Search.**
  A text search is billed per request, so a search that fires as you type bought a Pro
  request per pause in typing. Autocomplete is priced differently: requests carrying a
  session token that ends in a Place Details call on the same token are not billed at
  all, and that details call is one Discover already makes when a result is picked. The
  same keystrokes therefore cost one request instead of one per pause, and it is a
  request that was already being paid for. The token is minted in the popup, sent with
  every search in that session, spent on the details lookup, and replaced after each
  pick, because a spent token cannot be reused.

  Predictions are prefix matching, so they come up empty on a wordier question ("a
  quiet place for coffee before the drive", which Text Search answers with two cafes).
  A search only falls through to the billed text search once autocomplete has returned
  nothing, which keeps the wordy answer without paying for it on ordinary lookups. A
  failed autocomplete falls through the same way rather than dropping to the keyless
  provider: it says nothing about whether Google is reachable.

  Autocomplete is steered by a **restriction**, not the bias a text search gets. Bias
  was measured to be as weak here as it is there: biased on Nashville, Georgia it
  offered museums in Washington, New York and Boston. The restriction is a one-degree
  rectangle around the city, about 110km north to south, which reaches Mount Fuji from
  Tokyo while leaving Nashville, Tennessee well outside Nashville, Georgia. A circle
  cannot do this job at all, since Google caps its radius at 50km.

  Two consequences worth naming. A prediction carries only a name and an address, so
  the details call now also buys `displayName`, `formattedAddress`, `location` and
  `types`: without them a suggested place would land on the board with no map pin.
  They are free, because a request is priced by the highest tier in its mask and the
  ratings alongside them are already Enterprise. And a cache hit on the details lookup
  means the session is never terminated, so its suggestions bill at the cheap
  per-request Essentials rate instead of nothing. That is still the right trade: not
  making a call beats making one.

- **What a place *is* comes from the place, not from the tab it was found under.**
  The add popup posted whatever type its dropdown held, and the dropdown only ever held
  the view the popup was opened from. A ramen bar found under "All" was therefore filed
  as an attraction, and nothing a member picked could change that. The popup now reads
  the category off the result and sets the type itself: from the search hit, and again
  when the details land, since an autocomplete suggestion arrives with no category at
  all. A member who touches the dropdown wins permanently, because they know a bakery
  is a breakfast stop. Inferring a stay sets the view directly rather than going
  through `changeView`, which deliberately clears the results on that boundary and
  would throw away the pick that caused the switch.

  The server-side classifier was wrong twice over. It tested food before lodging and
  treated Google's `primaryType` as one more entry in the type list, so Hotel Gracery
  Shinjuku (`primaryType: hotel`, with `restaurant` and `food` further down `types`
  because it has a restaurant in it) came back as Food & Drink. `primaryType` is
  Google's own answer to this exact question and is now asked first; the full list is
  only consulted when it means nothing to us, and only then does an unknown place
  default to Sights. The second miss was narrowness: the real primary type is
  `ramen_restaurant`, not `restaurant`, and there is a long tail of those, so a
  `_restaurant` / `_cafe` / `_bar` suffix is read as food rather than being listed one
  cuisine at a time. Cached details keep their old category for up to a week, which is
  the cache's TTL; re-fetching them to correct the label would cost real money for a
  handful of development lookups.

- **A search is scoped by the city's state, not just its name.** Google's Text Search
  resolves the *text* it is given, so `museum Nashville United States` returns
  Tennessee however the request is biased: a `locationBias` circle over south Georgia
  was measured to change the results not at all. Naming the state is what picks out the
  right town, so `citySearchContext` carries `region`, `lat` and `lng` alongside the
  name, and the query reads `museum Nashville Georgia United States`. The bias circle
  is sent as well, but as a tie-breaker rather than the fix: with the state in the
  query it is what stops a bigger neighbour (Atlanta, in this case) taking the top
  slots. A region equal to the city name is dropped rather than repeated, so Tokyo does
  not search for "Tokyo Tokyo Japan", and a city-state with no region searches exactly
  as it always did.

  The 50km bias does cost something, and it is worth naming: a landmark far outside the
  city, Mount Fuji searched from Tokyo, drops from first to second as nearer noise is
  promoted. Being ranked below is recoverable, being absent is not, which is the trade
  taken. The same region now travels with the photo lookups, which had the same bug
  more quietly: the trip card for a Nashville, Georgia trip was showing a picture of
  Nashville, Tennessee. The search cache key had to widen too, since it was keyed on
  city and country alone and two trips holding two different Nashvilles were served
  each other's results.

- **Provider caches live in SQLite, because the process restarts constantly.** Google
  bills per request, and the free monthly allowance is per SKU (10,000 Essentials,
  5,000 Pro, 1,000 Enterprise) rather than one pooled credit, so the SKU that runs
  hottest is the one that starts costing money. Here that is Text Search Pro: the
  Discover search fires as you type, and its cache was in memory only. The API runs
  under `tsx watch`, so every saved file threw that cache away and the next search was
  bought again. `createPersistentCache` writes results through to a `provider_cache`
  table, keeping the in-memory layer in front of it because that is what de-duplicates
  requests already in flight, which a stored value cannot do. TTLs are capped at 30
  days, the limit Google's terms put on caching Places content, and set to 7 for
  searches and details so a rating or an opening time is never more than a week stale.

  Photo bytes get their own table rather than sharing that one, since they are binary
  and large. `/api/place-photo` was a pure pass-through: measured, three identical
  requests each took about 110ms and each one reached Google. The browser cache was the
  only brake, and it is per profile, so every new profile, private window and automated
  check re-bought the same pictures. It now serves from a `photo_cache` table and
  fetches only on a miss, measured at 996ms cold and 4ms warm for identical bytes. The
  response is buffered rather than streamed for exactly that reason: a streamed body is
  spent by the time it reaches the browser. `Cache-Control` went from one day to 30
  days and `immutable`, since a photo reference's bytes never change; 30 rather than
  forever is the same terms limit. Both tables are pure cost optimisations and never a
  source of truth, so either can be deleted at any time and the app only gets slower,
  never wrong.

  The search debounce went from 350ms to 600ms in the same pass. At 350ms a normal
  typist pays for two or three prefixes of the word they are still writing. The
  three-character minimum was already enforced on the server, where it is a cost guard
  rather than a UX choice.


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
  `Cover.tsx`'s generated art when a place has no photo. `googleCategory()` orders
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
  subset of the trip, edit the wording and the roster, tick **anyone's** box, and
  remove items. Unassigned tasks keep a
  single shared checkbox. New trips seed a starter checklist including multi-person
  items (visa, insurance) with partial progress.
- Coordinate-based travel legs: when consecutive schedule items carry coordinates,
  `schedule.ts` estimates each leg (haversine distance with a padding factor, then
  walk / transit / drive by distance) and renders it between blocks. Saved POIs can be
  scheduled onto a track from the calendar, carrying their coordinates so legs compute.
- Interactive map (`src/components/TripMap.tsx`): a real Leaflet map on the
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
- Real routing (`packages/server/src/routing.ts`): the calendar refines each travel leg
  with a real road duration from the public OSRM router instead of a straight-line
  estimate. Each request has a short timeout, and any failure falls back to the
  haversine estimate, so travel times always render. Short hops keep the walking
  estimate (the public router is driving-only). Legs go through the same
  `createCache()` as the place lookups, keyed by the rounded coordinate pair: a plain
  `Map` had no TTL, no bound and no in-flight sharing, so two duplicate legs in one
  board load could each hit the provider. The haversine and the fallback estimate
  themselves live in `@trippy/core/geo`, because the calendar and the router each had
  their own copy and one of them carried a comment saying it matched the other.
- Editable cities (`trips.ts` `addCity` / `updateCity` / `removeCity`, overview page):
  organizers can add, rename, re-zone, and remove cities inline on the trip
  overview. Validation covers the required labels and IANA time-zone shape, and
  at least one city is always kept. Non-organizers see a read-only list.
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
- Google Maps on the calendar (`GoogleMap.tsx`): when `GOOGLE_MAPS_KEY` is set the
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
DELETE /api/trips/:tripId                  delete the trip (organizer)
POST   /api/trips/:tripId/leave            leave the trip (everyone else)
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
POST   /api/trips/:tripId/expenses/settle             records a suggested transfer
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
`getBudget` / `setBudget`, `toggleSave` and `linkedItemCount` exist in
`packages/server` but no UI ever called them. They are deliberately not exposed:
the API mirrors the app that exists.

---
## 6. Data Model (Drizzle-style sketch)

```ts
users(id, email, passwordHash, displayName, homeTz, createdAt)
trips(id, organizerId, name, startDate, endDate, homeCurrency)
memberships(userId, tripId, role)                 // organizer | member
locations(id, tripId, name, tz, lat, lng)
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

Enums: `role`, `item_type` (see 2.2), `booking_status (booked|tentative|unbooked)`,
`travel_mode (walk|drive|transit|rail|flight)`.

---

## 7. Notable Algorithms

### 7.1 Minimal-transaction settlement
1. Convert all expenses to home currency (FX at expense date).
2. Net balance per user = paid − owed.
3. Greedy match largest creditor with largest debtor until all ≈ 0.
   Produces ≤ n−1 transactions.

**Everything is integer minor units, end to end.** `settle()` in
`@trippy/core/settlement` takes `Balance { userId, netCents }` and returns
`Transaction { from, to, amountCents }`; `balances()` accumulates whole cents and
never divides while summing. It previously worked in floating-point major units
with an `epsilon = 0.01` guard, which silently discarded an exact one-cent
imbalance: the smallest real debt the system can express was the one debt it
refused to settle. With integers there is nothing to guard against, so there is
no epsilon, and the transfers reconcile a zero-sum balance set to zero exactly.
Formatting into a major-unit string happens only at the display edge.

The server rows still carry a major-unit `net` / `amount` alongside `netCents` /
`amountCents` for the existing API and UI contract, but those are derived from
the cents figure rather than accumulated, so they cannot drift. New consumers
should read the cents fields.

**Recording a transfer writes an ordinary expense.** A settlement is exactly an
expense one member covered on one other member's behalf: the payer is credited,
the single participant is charged, and both balances move to zero. Storing it
that way means balances, the transfer suggestions, currency conversion and
deletion all keep working with no second code path, and undoing a payment is
just deleting the row. The only thing the `settlement` flag changes is the
label: the ledger calls the row a payment rather than a shared cost, and drops
the payer and split line, since the description already names both sides.

The amount posted is the one the member was looking at, not one recomputed on
the server. If it has gone stale the balances simply do not clear, which is
visible on the same screen, and that is a better failure than silently paying a
different number than the button said.

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
