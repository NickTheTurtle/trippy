# Trip Planner: Design Document

> Collaborative, internationally-aware group trip planner. SvelteKit + TypeScript.
> Status: **Design / pre-implementation**. Last updated: 2026-09-02.

---

## 1. Purpose & Vision

A collaborative tool where a user registers, creates a **Trip**, gathers candidate
**Points of Interest (POIs)** via a discovery tool, and schedules them as
**events** on a board with a map and travel-time estimates. When the group splits
up, two events at the same time with different people on them **are** the split,
and travel is derived from who is moving where. It supports **lodging voting**, a
**pre-trip** checklist, an **estimated cost** view, and a **Splitwise-style**
expense settlement, all **time-zone aware** across multiple cities in one trip.

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

1. Events are **typed** (activity / food / stay / travel / free time).
2. Some events have **hard reservation windows**; others are flexible.
3. **Travel legs** live _between_ events and need computed durations.
4. A single trip spans **multiple cities → multiple time zones**.

The spreadsheet's `* = Unbooked` marker was built and then removed; see §6 for
why a status nothing derives from did not earn its line on a block.

---

## 2. Core Concepts (Domain Model)

```
User
Trip            organizer, members[], date range, homeCurrency
  Location      a city/region within a trip; owns an IANA timezone + geo center
  POI           discovered candidate: geo, category, hours, priceLevel, url, votes
  Event         a typed block on the board, carrying the people who are on it
                { type, day, startMin, endMin, tz, cost,
                  poiId?, lodgingId?, people[], notes }
  TravelLeg     derived edge between two events, for one set of people
                { fromId, toId, people[], mode, mins, autoMode, autoMins }
  Crew          a saved selection of people; a shortcut, never a schedule
  Lodging       candidate stay for a Location + a voting poll
  Poll / Vote   lodging + POI ranking (approval or ranked)
  Expense       payer, amount, currency, splitRule → Settlement
  Settlement    minimal set of "who pays whom" transactions
```

### 2.1 Entity relationships (ER sketch)

```
User 1───* Membership *───1 Trip
Trip 1───* Location
Trip 1───* POI            (POI optionally tied to a Location)
Location 1─* Lodging
Trip 1───* Event
Event *───* User          (who is on it, via EventPeople)
Event 0..1─ POI           (activity/food events reference a POI)
Event 0..1─ Lodging       (a stay references the option slept in)
TravelLeg *─1 Event ×2    (from → to, for one set of people)
Trip 1───* Crew *───* User (a saved selection, no schedule)
Trip 1───* Expense
Expense *─* User          (participants via ExpenseSplit)
Lodging 1─* Vote ; POI 1─* Vote
```

### 2.2 Event-type vocabulary

The canonical set, exported as `EVENT_TYPES` from `@trippy/core` with `EventType`
derived from it:

```
activity | food | stay | travel | freetime
```

Five types, not six, and `poi`, `transport` and `lodging` are gone. Each of the
three lost a reason to exist when tracks did:

- `poi` meant "a place from Discover", which is a question about where the event
  came from, not what it is. It became `activity`, and the link to the saved
  place is `events.poi_id`, where it belongs.
- `transport` and `travel` were a flight and a hop: two names for a journey,
  split by how long it was. Travel is derived now, so the only hand-entered
  journey is `travel`, and how long it is decides nothing.
- `lodging` was a block that said a hotel existed. `stay` is the night itself,
  carrying the people who slept there, and it is what the next morning's first
  journey starts from.

Only one of the five is not a place: `freetime` is deliberately nowhere.
`LOCATED_EVENT_TYPES` and `isLocatedType` name that distinction, because
switching to free time clears the coordinates.

A `travel` event carries a location too, and it means where the journey _ends_:
the ferry drops you on the island, so the address is the island. That makes it a
one-way anchor, and `planLegs` treats it as one. Nothing is ever planned _to_ a
hand-entered journey, because a walk to the middle of your own flight is not a
thing anyone does; but the chain resumes _from_ where it lands, so the next stop
gets its journey from the ferry terminal rather than from wherever you were
before you boarded. A `travel` event with no end location still breaks the chain
outright, which is the old behaviour and the right answer when nobody has said
where they came out.

`TRANSPORT_MODES` is the companion list, for what a journey is made by:

```
walk | cycle | transit | drive | ferry | flight
```

The provider ladder can only answer for four of them (see 4.2); ferry and flight
exist because a person can still say so by hand, and a schedule that cannot
express a ferry is wrong about the trip rather than silent about it.

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
  _before_ scheduling. Manual POIs also allowed (for venues not in providers).

### M3: Schedule (core)

The board was rebuilt on **events** in place of tracks. What follows is the model
as built; the reasoning for the change is in M3.1.

- Day / people views. Slots are 30 minutes, drag snaps to 5.
- **Derived column layout**: see M3.2. Columns are computed, not authored.
- Drag places from the candidate pool onto slots. Supports:
  - **Fixed windows** (reservations) that lock start/end.
- **People on the event** (`event_people`): any subset of the trip. This is not a
  filter or a decoration; it is what the travel planner reads. An event with
  nobody on it is shared and belongs to the whole group.
- **Event popup**: clicking a block opens a detail dialog (title, type, start,
  duration, people, delete). Dragging never opens it; a click
  only counts when the pointer did not move.
- **Live "now" line**: a red marker at the current time, drawn only on the day
  that is actually today _in the destination city's zone_ (`localDayMinutes`).
- **"View as"**: the whole trip or one member, everyone by default, filtering the
  board to the events that person is on plus the shared ones. See M3.3.
- **Travel is derived**, with a hand-entered `travel` event as the override of
  last resort. See 4.2.
- **Free time** clears its place, since nobody has promised to be anywhere, and
  therefore breaks the travel chain on both sides.
- **A stay is an ordinary block** on the evening it starts, like every other
  event. It is also the origin of the following day's first journey.
- **Map panel**: every location saved in Discover, grey, with the day's scheduled
  ones in green over them, numbered when the day has an order. Beside the board in
  both views.
- **Agenda view**: one person's day in order, journeys included, beside the map.

### M3.2: Layout engine and the agenda

Earlier versions drew one column per authored _track_, which meant "who is doing
this" had three possible answers (the track's crew, the item's assignees, and the
member's crew membership) that could disagree. **An event's people are now the
single source of truth**, and tracks are gone entirely. Layout is derived.

`packages/core/src/layout.ts` is a pure module (no DOM) that turns a day's events
into a drawing. It survived the rework unchanged, because it was already keyed on
people rather than on lanes:

- **`buildFlows`**: each person's events in start order; every adjacent pair
  becomes a _hop_ (`from → to` at a time), aggregated so one arrow carries
  everyone making it.
- **`rankEvents`**: a global left-to-right rank per event, seeded by start time
  then relaxed with a weighted barycentre sweep over the hop graph. Events that
  exchange many people drift together, so arrows stay short and un-crossed.
  `countCrossings` scores an ordering.
- **`layoutDay`**: packs each cluster of transitively-overlapping events into the
  fewest columns _in rank order_, then lets each event expand rightwards into any
  column that stays free for its whole span. **Width therefore tracks
  contention**: a solo morning spans the full board, an event overlapping one
  other takes two thirds, a three-way afternoon split takes a third each.

**The second view is an agenda, not a swimlane.** It used to transpose the board:
rows are people, x is time, so a split showed as rows diverging into different
colours and converging again. That is a good picture of a group and a poor
answer to the only question anybody brought to it. A trip of twenty drew twenty
near-identical rows of slivers too narrow to label, and "what does my day look
like" was the hardest thing to pick out of it. The day board already shows the
group; the second view now shows one person, as a list, journeys included, with
the map beside it.

It is therefore always about somebody, which is why "view as" drops "Everyone"
there: an agenda for the whole group is the day board with extra steps. Arriving
with nobody chosen reads as you, and `viewAs` itself is left alone, so leaving
the agenda returns to a day board read as everyone. `personBands`, which existed
only to feed the swimlane, went with it.

**Motion is part of the layout, not decoration.** Everything on the board is
absolutely positioned from derived values, so a re-layout teleports blocks. That
is a real loss of information: width tracks contention, so adding one attendee
can push a neighbour from full width to two thirds, and a jump cut leaves no clue
that the two facts are connected. `schedule.css` therefore transitions `top`,
`height`, `left` and `width` at two speeds, held in `--sched-settle` and
`--sched-track` on `.sched`:

- **Settle (220ms)** is for a layout the reader did not drive: a re-planned
  journey, a column count that changed under them, a server value that differed
  from what they dropped. Being followable matters more than being quick.
- **Track (90ms)** is for the block under the pointer. Dragging snaps to five
  minutes and `PX_PER_MIN` is 1, so every step is a five-pixel jump; that is the
  choppiness, and smoothing it is the whole point. The duration is bounded from
  both sides: long enough to glide a 5px step, short enough that the block still
  reads as stuck to the cursor. `.dragging` and `.resizing` also narrow the
  transition to the single axis the pointer drives.

The transition forced a correctness fix rather than merely revealing a cosmetic
one. A drop cleared the live drag state immediately and then waited on a round
trip, so the block rendered at its **old** position until the new day arrived.
Un-animated this was a one-frame flicker; animated it became a visible rubber
band. `Schedule.tsx` now holds a `pending` override of the dropped position and
drops it the moment any fresh payload lands, whatever that payload says, so a
value the server clamps or refuses still wins and the override can never outlive
the round trip it exists to bridge.

Blocks fade in rather than slide, because a block that was not there a moment ago
has no old position to travel from. Under `prefers-reduced-motion` all of it is
removed: the board is read, not watched, and every block is already in the right
place without the motion.

### M3.1: Events carry people, and travel follows

**The change.** Tracks, parties, `party_day` and `party_membership` are deleted.
An event carries its people; two events at the same time with different people
**are** a split, and nothing has to declare one.

**Why the old model had to go.** A track made the lane the unit of planning. That
had three consequences that could not be fixed inside it:

1. A person could only be in one lane at a time **by construction**, so the model
   could not represent a mistake, which meant it could not warn about one either.
2. Travel belonged to the lane rather than to the people moving, so two people
   leaving the same place for different destinations shared one computed leg and
   one of them was simply wrong.
3. Splitting the group meant authoring a second lane and keeping both in step by
   hand, which is bookkeeping the schedule already had the facts to do itself.

On top of that, `party_membership` was time-segmented: putting two people in a
group was a scheduling decision with week-long consequences, and merging two
identities (see 4.8) needed a bespoke, deliberately-unresolved conflict rule for
overlapping segments. A **crew** is now only a saved selection of people, a
shortcut for the people picker, with no schedule, city, lodging or days. Choosing
one selects its members and gets out of the way. Nothing reads a crew while
drawing a day, so one can be renamed or deleted at any time without the schedule
moving underneath anybody, and the merge rule became "it is a set".

**Crews live inside the people menus, not beside them.** Every `MultiSelect`
over people takes `groups`, and renders them as a "Crews" section above the
"People" one: the schedule's event picker, the task assignees and the cost
sharers all offer the same shortcut in the same place. A crew row ticks on only
when every member it can offer is already picked, and it ignores members who
have left the trip, because a row that is on while naming somebody the menu does
not list could never be turned off. The schedule used to show crews as chips
under the field that _replaced_ the selection; in the menu they add and remove
like every other row, so two crews can be combined without the second wiping the
first. Two exceptions, both deliberate: the crew editor itself (a crew that can
tick itself is a puzzle, not a shortcut) and the task list's "who is done" menu,
which records what happened rather than choosing people.

**Everyone is a crew the trip does not own.** Every trip has one group asked for
far more than any other, and no member should have to assemble it by hand or
keep it current as people join and leave. `crewsForTrip` therefore returns it
first, always, under the fixed id `everyone`, with the live roster as its
members and `locked: true`. It is derived on every read rather than stored as a
row, because a stored one would have to be rewritten by every path that touches
the roster: joining, being added, being removed, leaving, and merging a
placeholder into a real account. Each of those is a chance for it to fall behind
and start naming a group that is no longer everyone, which is the one thing it
exists to be. Derived, it cannot drift, needs no migration for trips that
already exist, and cannot be deleted by somebody tidying up. `editCrew` and
`deleteCrew` refuse the id, and the People page renders the row as plain text:
a row that looks like the others but does nothing when clicked is worse than one
that plainly is not a control.

**Everyone is stored as nothing and shown as everything.** An event with nobody
on it already means the whole group, which is why the picker's trigger reads
"Everyone" when the stored list is empty. That empty list is the representation
worth keeping: it still means everyone the moment somebody joins the trip, where
a frozen roster of today's ids would silently leave the new arrival out of an
event that was meant to include them. So `PeoplePicker` collapses a full
selection back to none before saving, and `PUT /events/:eventId/people` stores
exactly the list it is handed.

Storing it that way is not a reason to **show** it that way, and for a while the
picker did both. Opening an ordinary event showed twenty empty checkboxes for an
event that applied to all twenty people, which reads as nobody; and ticking
names one at a time cleared the lot on the last tick, because that is the moment
the selection collapses. Both are the same mistake, a storage form leaking into
the display. `PeoplePicker` is now the only place the two forms meet: it expands
empty to every name ticked on the way in, and collapses a full set back to empty
on the way out. Unticking one name therefore writes out everyone-except-them
explicitly, and reticking them empties the field again.

Three consequences worth naming. A name that has left the trip is dropped from
the display and written out on the next edit, because a stored id the menu
cannot offer could never be unticked and would hold the count permanently short
of the roster, putting "Everyone" out of reach. A stored list naming only people
who have left is therefore the empty list by another route, and reads as
Everyone. And unticking the last remaining name returns to Everyone rather than
to nobody, which is not a bug but the schema showing through: an event with no
people is defined as an event for the whole group, so a one-member trip cannot
distinguish the two and no trip can express "nobody". Free time, not an empty
participant list, is how the schedule says somebody is not involved.

**A tick that cannot change anything says so.** The consequence above was
correct and invisible, which is a bad combination for the one row most likely to
be clicked: the derived Everyone crew sits at the top of the picker's menu, and
once everyone is picked, clicking it asks to untick the whole trip. That is the
unrepresentable pick, so the ticks come straight back and the control reads as
broken. The reported bug was exactly that: "I cannot click Everyone to deselect
everyone."

Nobody is still not a thing an event can be, and the fix is not to pretend
otherwise. An empty field that saved as everyone would be a lie told in the one
place the two forms are supposed to be reconciled, and there is no third record
to write: `writePeople` deletes the rows and `toPlanner` reads no rows as the
whole roster. So the refusal is said instead of performed. `PeoplePicker`
remembers the tick that asked for nobody and passes a line back to the menu,
which shows it at the top, where the click was; the same line stays under the
field once the menu closes. It goes in the menu and not only in the field's hint
because the open menu is `position: fixed` and covers the line under the field,
so a hint alone would be written where the reader cannot see it. That is the
same judgment the People page makes about the locked crew row: a control that
silently does nothing is worse than one that explains itself.

**"Everyone" is expanded at the persistence boundary, and core reads ids
literally.** The convention above is a storage convention, and `planLegs` never
knew about it: it builds its traveller set out of the `people` arrays and walks
each person's own events, so an event naming nobody was on nobody's chain. A
trip whose events were all left on the default therefore had an empty traveller
set and **no travel legs at all**, which is the bug that made this explicit.

The two readings were both written down and neither was wrong on its own, so
the rule is now stated in one place and enforced in another:

- `PlannerEvent.people` in `packages/core/src/travel.ts` is **exactly the ids
  travelling**. An empty list is nobody, never everybody. Core is pure and
  browser-portable, so it has no roster to expand against and cannot get one
  without doing I/O.
- `toPlanner` in `packages/server/src/persistence/schedule.ts` expands an empty
  list to the trip's `memberships`, for blocks, for tonight's stays and for
  last night's incoming stays alike, and reads the roster fresh on every plan
  rather than copying it onto a row.

The rejected alternative was a roster parameter on `planLegs`, which would have
kept "empty means everyone" in a single place. It was rejected because that
place would be the one module that must stay free of trip concepts and of I/O,
and it would not even settle the question: every other caller constructing a
`PlannerEvent` would still be free to mean something else by an empty array.
Expanding at the boundary leaves core with one meaning and no special case.

Three consequences, all deliberate:

- **A trip with no members plans nothing.** The expansion yields an empty set,
  which is right: there is nobody to travel.
- **A stale id is dropped.** `event_people` outlives a membership, so a person
  who has left can still be named on an old event. A named list is filtered to
  the roster, and a list that names only people who have left empties to
  **nobody**, not to everybody: somebody chose those names, and the choice was
  not "the whole group".
- **Leg keys change where an event was on Everyone**, because the key carries
  the sorted travellers. Nothing is orphaned in practice, since those days
  previously planned no legs to store. To catch days nobody writes to again,
  `reconcileAllLegs()` runs the ordinary per-day reconciliation across every
  stored day once, guarded by a row in `schema_backfills`; it inserts what is
  newly planned and prunes what is not, keeping every row whose key still stands
  along with its override. Additive, like every other migration here: no table
  is dropped and no row is rewritten.

**The client preview is told the same thing.** `replanLegs` in
`apps/web/src/pages/schedule/replan.ts` runs the same `planLegs` while a dialog
is open, and its `plannerEvent` is a copy of the server's `toPlanner`. It now
takes the roster as a third argument, `ScheduleData.members` mapped to ids from
`Schedule.tsx`, and applies the identical rule to the day's blocks, tonight's
stays and last night's origins: an empty list expands to the roster, a named one
is filtered to it, an empty roster expands to nobody. Without it a preview of an
Everyone day showed no journeys where the board behind it showed them, which
reads worse than either being wrong on its own.

The rule now has two implementations that must agree, which is exactly the
shape of the original bug. It cannot live in `planLegs` itself without giving
pure logic a trip concept, but it could live in a pure
`expandPeople(people, roster)` helper exported from `packages/core` and called
by both boundaries. That is a follow-up for the core workspace, not something
the web side can do on its own.

**Deriving the legs** (`packages/core/src/travel.ts`, `planLegs`). For each
person, walk their own events in order and pair each consecutive two. Bucket the
pairs by the pair of event ids, so:

- everyone going from A to B lands in one bucket and shares **one** leg;
- two people leaving A for different places land in two buckets and get **two**.

That is the whole of splitting and rejoining. Three rules keep it honest:

- **Free time breaks the chain on both sides.** Not because it has no location,
  but because nobody has promised to be anywhere, so planning a journey out of it
  would be inventing a fact.
- **An event with no location breaks the chain, like free time does.** A block
  with no coordinates does not say _where_ its people are, so a journey measured
  across it is an estimate from the last known place drawn on the day as a fact.
  A missing estimate is more honest than a wrong one, so the chain stops at such
  a block and picks up at the next place somebody has named.

  This **reverses the earlier rule**, which passed a location-less block over on
  the grounds that it says _when_ someone is busy rather than _where_ they are,
  and so kept the journeys either side of it. That rule was written against the
  failure it replaced (breaking on anything that was not an anchor, which meant
  a reminder dropped into an afternoon silently deleted the travel times around
  it). What it traded away is worse: with A located, B without an address and C
  located, it planned and drew an A -> C travel time that nobody can stand
  behind, because between A and C the group's whereabouts are unknown. Adding an
  address to B brings both journeys back; until then the day shows none, which
  is what it knows.

  Only an ordinary block is affected. `freetime` already broke the chain, and a
  `travel` event is decided before this rule is reached: one with a destination
  becomes the origin of the next leg, one without breaks the chain, both exactly
  as before.

- **A hand-entered `travel` event is never an endpoint**, so no automatic leg is
  planned into or out of it. Saying how you are getting from A to B is how you
  turn the planner off for that hop.
- **Two stops within ~30 m are one place** (`SAME_PLACE_KM`), which is inside the
  error of a geocoded address and well inside the width of a hotel.

**The leg key is `fromId>toId>sortedPeople`**, and this is what makes a manual
override survive an unrelated edit: dragging an event ten minutes does not change
who is going where, so the key is stable and the override is matched back to it.
Changing **who** is travelling changes the key deliberately, because a ferry
booked for two is not a fact about the journey one of them now makes alone.

**A journey is anchored to its arrival, not its departure** (`placeLeg`): a table
booked at seven means leaving at half six. When the duration exceeds the gap the
leg is marked `tight` and drawn at the gap rather than shrunk, because an
unachievable day should show the problem instead of hiding it.

**Reconciliation.** Travel has to be both derived and editable, so `travel_legs`
rows are reconciled on every event write: keep rows whose key is still planned
(preserving the override), insert newly planned keys, delete the rest.
`auto_mode` / `auto_mins` hold the provider's answer, `mode` / `mins` hold the
user's, and the user's win. Clearing both hands the leg back to the provider,
which is how somebody undoes a guess without having to remember what the
automatic answer was. Every write recomputes **the day and the day after**,
unconditionally: a stay is the previous night for the morning that follows it, and
doing it only for stays leaves a bug where an event changes type into one and the
next morning is never told.

**Drawing dense travel** (`layoutBoard`). A day that splits four ways generates a
lot of short legs at the same moment. Every one of them is drawn as a **block**,
because a block says how long the journey takes and how much of the gap it eats,
where a line says only that people moved.

Each journey hangs under **the event it arrives at**, in that event's column and
directly on top of it. A journey means "this is how these people get into this
event", so the arrival is what it belongs to, and anchoring it there makes
containment true by construction rather than something to test for. There is
nothing left for a connector to explain, so the board draws no lines at all.

The arrival rather than the departure, for two reasons. It is the anchor the
clock already uses: `placeLeg` ends every journey exactly when its arrival
starts, because the fixed point is the thing you are trying not to be late for.
And it is the end that is reliably there. Measured over the seeded trip, 9 of 37
journeys have no departure event on their day, all of them leaving the lodging in
the morning, while **no journey lacks its arrival**. The old rule needed both
ends and so drew those nine nowhere.

Journeys take no column of their own. Events are laid out exactly as if journeys
did not exist, which is the widest they can ever be, and the journeys are then
hung underneath. Where several land on the same event they share its width,
ordered by the column they came from, so the fan carries positionally what the
crossing arrows used to: the leftmost bar is the group from the leftmost column.
A fan is never the narrowest mark on the board, because many arrivals means many
people means a whole-group event, and those are full width.

Three rules the board applies on top, all about legibility rather than meaning:

1. A leg too short to hold two lines is drawn as a one-line rule with its
   duration on it, floored to a height a pointer can hit. The floor grows
   **upwards**, into the waiting time before the journey, because downwards is
   the block it arrives at.
2. A bar names where it came **from**, not where it lands, and only while it has
   the width to: its position already says where it lands. The origin is the one
   thing the drawing no longer carries, so the label carries it.
3. Below about sixty pixels a bar drops its padding and its type drops a step,
   because at seven columns a bar that reads "10m" is worth more than one that
   reads "1...".

The rejected alternatives, and the measurements behind this, are in
`docs/notes/travel-decision.md` and `docs/notes/travel-visualisation.md`.

There was an earlier heuristic here (`layoutLegs`, `MAX_LANES = 3`) that collapsed
whole clusters of legs into single arrows. It existed because legs were drawn in a
30px gutter beside the day, where four parallel journeys genuinely could not fit.
Once they contend for real columns the constraint is gone, and collapsing them was
throwing away the detail the board is for.

> **Caveat: attendance is whole-event.** A person is on an event or is not; there
> are no per-person partial ranges. To model somebody leaving halfway, split the
> event in two. This is what keeps "who is where at time T" a single unambiguous
> lookup, and therefore what lets the travel planner be a pure function.

**The migration was destructive, by agreement.** `db.ts` drops the six old tables
outright rather than converting them. Its one destructive step, taken because
there is no honest conversion: a track's items have no people of their own, so
inventing an attendee list for each would be fabricating the exact fact the new
model exists to record. The trip's places, stays, expenses, tasks and people are
all untouched; only the scheduled blocks were lost, and only after the owner
confirmed they were disposable.

### M3.3: The toolbar is bounded at both ends

Two controls decide which board you are looking at, and both were unbounded in
ways that let the reader end up somewhere the trip does not go.

**Day navigation walks `days`, not the calendar.** The arrows used to add or
subtract a day forever, so a few clicks left the trip entirely and drew an empty
board with nothing to say which way was back. They now step through `days`, the
list the payload already carries, and render as disabled buttons at each end
rather than disappearing: a control that vanishes makes the pair jump sideways on
the days you can still step from.

`days` rather than the trip's start and end dates on purpose. `tripDays` is a
_union_ of the date range and every day that actually holds an event, so an event
stranded by a shortened trip stays reachable. The bound is therefore what the
trip offers, not what its dates claim, and stepping by index skips the gap to a
stranded day instead of landing on a day that is not there.

**The server clamps the same way**, because the day is a URL: it can be typed,
bookmarked, or left behind by a trip whose dates were edited afterwards. Guarding
only the buttons would answer all three with an empty board. The existing
malformed-day fallback is unchanged and still comes first; the clamp only applies
to days that parse.

**The 3-day view was removed.** It was a window three columns wide, which bought
one thing: seeing tomorrow without leaving today. It cost a second clamp rule
(the anchor had to stop early enough that the far edge landed on the last day), a
second board layout, a second docking rule for the edit panel, and journeys drawn
at a third of their usual width, which is what the travel-visualisation study was
answering in the first place. The day view answers the same question one arrow
press away. The payload still carries `board` as an array, so a view that spans
days can come back without reshaping it. An old `view=3day` URL falls back to the
day board rather than to nothing.

**"View as" is one person or everyone.** It was a multi-select, which allowed
arbitrary subsets. Nobody asks what the day looks like for an arbitrary subset:
the question is "what is my day", or one other person's. A single `Select` also
makes the schedule agree with the estimates table and the expense ledger, which
have always offered exactly this choice through `ViewAsBar`, down to the `(you)`
suffix that saves reading your own name back at you. It hides below two members
for the same reason `ViewAsBar` does: a dropdown with one name changes nothing.

### M3.4: The phone pass

Responsive web is in scope down to 390px; a React Native client is not (see
`AGENTS.md`). Nothing here is a separate mobile layout. Every fix below is the
same page, told how to give something up.

**Nothing overflowed. Everything was squeezed.** The first measurement was for
horizontal overflow at every width from 1440 to 360 and there was none, on any
tab. The damage was all proportion: a flex child with `min-w-0` and no basis
shrinks to nothing instead of forcing its sibling onto the next line, so the
trip title was 12px wide and 662px tall at 390, a preparation task read `C...`,
and an expense was `P.`. The fix in every case is a real `flex-basis` on the
column that matters, which is what finally makes `flex-wrap` do anything.

**What gets dropped is computed, not styled.** The header shows 8, 5 or 3 faces
by measuring the viewport, rather than hiding avatars in CSS, because "+17" has
to stay true.

**Every 190px column becomes a dropdown, not a scroller.** Below `lg` the pages
that carry one (Preparation, Expenses, Discover's cities) drop it. The old
fallback turned the list into a horizontal scroller, which showed two or three
entries and ran the rest off the edge: the one thing it could not tell you was
where you already were. A dropdown says that in its trigger, in one line. A
drawer was tried in between and removed; M3.5 has why.

One breakpoint, `lg`, shared with the grid the pages already used, and named
once as `NARROW_QUERY` in `hooks/useMediaQuery`. The old scroller was keyed to
860px instead, so between 860 and 1024 the column had already collapsed while
the nav still styled itself as a sidebar.

**The tab strip earns its scroll.** It was already `overflow-x-auto`, which is
the right shape (the tabs are one flat set) but gave no sign there was more, and
arriving on a later tab left the active tab off-screen. `TabStrip` measures both
edges and fades whichever still has tabs behind it, and scrolls the active tab
into view itself rather than calling `scrollIntoView`, which walks up every
scrollable ancestor and would drag the page vertically to fix a horizontal
problem.

**Hover-only controls are revealed where there is no pointer.** Every
`opacity-0 group-hover:opacity-100` row now carries `[@media(hover:none)]`,
following `discover/card-controls.tsx`, which had it first.

### M3.5: Destinations and controls

The phone pass left the app with three mechanisms for "switch what I am looking
at": the trip tabs, the 190px column, and the schedule's pills. The rule that
sorts them came from React Navigation, which draws the line the same way and was
worth borrowing since `apps/mobile` will eventually have to agree with the web.

**A destination is somewhere you are; a control changes what you see while you
stay there.** A destination belongs in a navigator, gets a path segment and can
be linked to and returned to. A control is local state and belongs in the header
of the thing it acts on. Under that rule the trip tabs are destinations, and
everything the 190px column ever held is a control: a section, a city, a view.

**Narrow, a column is a dropdown and the section's action sits beside it.** The
header is the scarcest thing on a phone, so the row reads `[where you are]` then
`[the one button you came to press]`, and the page's figures drop to the line
below. Preparation, Expenses and Discover all do this, which is why "+ Add" is
in the same place on all three.

- The row is not rendered at all where it would be empty. Tasks and Packing have
  no figures, and reserving the height there only opened a gap under a dropdown
  that had already named the section.
- The counts are left behind in the narrow form. They are a right-aligned chip
  in the column, and folded into a dropdown's single line of text they read as
  part of the label ("Settle up 19").

**A drawer was tried first, and removed.** The sections went behind a menu
button on a `<dialog>` sliding in from the left, on the argument that they are
navigation. Two things were wrong with it. A menu button hides where you are
behind a tap, which is what the scroller was punished for; and it was the app's
fourth way to change view, sitting a swipe away from the tab strip that is the
real navigation. The dropdown says where you are without being opened. `Modal`
now owns `useDialog` alone.

**A fixed, short set of views is pills; everything else is a dropdown.**
Discover's type filter (All / Attractions / Food & Drink / Stays) is four short
labels that fit one row, so it is one tap rather than two and it never covers
the grid it filters. The sections are three labels, but one of them is
"Estimated costs", and they are joined by an action button that a full-width
pill row would have pushed onto its own line. Wide, the type filter goes back to
a `Select`: the header has other work to do there and the menu is not in the
way.

`Pills` is shared, and moved out of `schedule.css` when Discover needed it, so
the schedule's Day / People switch and Discover's filter are one
treatment rather than two lookalikes. The schedule's segments stay `<Link>`s,
because its view _is_ addressable, and share only the styling. The expense
dialog's split control is still its own thing; it is a form field, not a view
switch.

**Where the controls a dropdown cannot carry went.** A list has a delete button
per row; a dropdown has no row to hang one on. So on a phone Discover's add and
delete sit beside the city dropdown and delete acts on the city on screen,
disabled on the last one for the same reason the column disables it: the server
refuses to remove it, and a control that vanishes as you delete down to one
reads as a bug.

- Consolidated checklist: flights, lodging confirmations, visas, packing.
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
    task is _for_, not who pressed the button. It still refuses a non-member, and a
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
  (`poi_votes` PK `(poi_id, user_id)`); stay votes are _exclusive per city_
  (`lodging_votes` PK `(city_id, user_id)`, so voting again replaces). Stays also carry
  price/currency/check-in/check-out/locked, and `events.lodging_id` is a foreign
  key into them. Merging the storage would churn the schedule, crews and costs for no
  user-visible gain; merging only the presentation gets the whole benefit.

### M7: Expenses (Splitwise-style)

- Log expense: payer, amount, currency, split rule (equal / shares / exact / % ).
- Compute net balances; produce a **minimal-transaction settlement**.
- Multi-currency: store the original amount and currency **plus the rate they were entered
  at** (`expenses.fx_rate`, `expenses.fx_home`), and convert with that stored rate.

This last point corrects the doc, which previously said "normalize at settlement time",
meaning convert from today's rates on every read. That is not what is implemented, and the
implementation is right. Converting on read made a €920 dinner worth a different number of
dollars each time the page loaded, and let a trip that everybody had settled up drift back
out of balance months later with nobody having touched it. The rate is locked to the
transaction instead, which is what every other expense tool does. A stored rate is used
only while `fx_home` still matches the trip's home currency; when it does not, or when the
row predates the columns, the reader falls back to a live conversion and the next edit
re-locks it.

#### The date an expense happened (`expenses.spent_on`)

An expense carries the day it happened, `YYYY-MM-DD`, separate from `created_at`, which is
the instant it was typed. Members reconcile a week of receipts in one sitting, and without
this the whole week landed on the day of the sitting.

It is a zone-free calendar day, like `trips.start_date` and `events.day`, not an instant.
A trip crosses time zones by definition, so an instant would render as a different date
depending on who was reading it: a 9pm dinner in Tokyo is the previous day in London. The
day the group had that dinner is one fact, and everyone who was there agrees on it.

**`spent_on` is descriptive and drives ordering only. It must never affect FX conversion.**
Backdating an expense does not revalue it: the rate stays the one recorded when it was
entered. Two reasons, and both matter:

1. The rate provider serves current rates only and has no historical lookup, so there is no
   rate for the named day to honour even if we wanted one.
2. A rate that changed retroactively would silently move every member's settled balance
   without anybody having edited a number. Correcting a date is a bookkeeping tidy-up, and
   it must not be able to move real money between real people.

Only a change to the expense's own currency re-locks the rate.

Ordering is `spent_on DESC, created_at DESC`: newest day first, and within a day the most
recently entered first. The entry time is the tiebreaker because it is the only total order
left, and it means a trip whose expenses all share a date reads exactly as it did before
the column existed.

The server backstops the date rather than validating it into a refusal: a missing, blank or
malformed value falls back to today (UTC) on create, and on edit an omitted value keeps the
day already on the row, so a caller that forgets the field cannot drag a backdated expense
forward. Absurd-but-real days such as `1200-01-01` are stored as typed; bounding them
belongs to the API layer, which has an error channel to explain a refusal. The UTC fallback
is deliberate: there is no trip timezone to use, since each city carries its own `tz` and an
expense is not linked to a city, so the client, which knows what day it is where the member
is standing, should always send the date.

#### Split model (implemented)

All three split modes collapse to **one representation: a non-negative `weight` per
participant** (`expense_participants.weight`), and splitting is always "divide the total in
proportion to the weights". The mode (`expenses.split_mode`) only says how the UI collected
those weights:

| Mode     | Stored weight                        | UI                                  |
| -------- | ------------------------------------ | ----------------------------------- |
| `even`   | `1` for everyone                     | checkbox only                       |
| `shares` | the share count (a private room = 2) | share stepper                       |
| `exact`  | the person's amount **in cents**     | amount input, must sum to the total |

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

**There is no "this is income" checkbox.** The sign of the amount _is_ the flag. A separate
checkbox is a second source of truth that can disagree with the number next to it; a user
who types `-120` with the box unticked means income either way. The form derives everything
(modal title, "Paid by" vs "Received by", the per-person preview, the save button) from
`amount < 0`, and the server derives the stored sign from the amount alone. In `exact` mode
the per-person amounts are still typed as positive magnitudes and checked against
`abs(total)`.

Validation is doubled: the client disables Save when `exact` amounts don't add up, and the
server independently re-checks and fails the action.

**Read as one person, the ledger is signed.** With "View as" set to a member, a row shows
what it did to that person's balance rather than the gross share it charged them: the
payer's converted total, minus their own share. That is the arithmetic `balances()` runs
over the whole ledger, read one row at a time, so the signed rows add up to exactly the
figure the balances panel gives that member. A settlement needs no special case, because it
is stored as the payer covering the recipient in full: whoever handed the money over goes
up, whoever received it goes down. The list also keeps a row the viewer paid but takes no
share of, which the older share-only reading dropped even though it is the plainest credit
they have. With "Everyone" selected there is no sign at all: a shared cost has no direction
from the group's point of view. The `+` and the minus carry the meaning and the accent and
danger colours only repeat it, which is the balances panel's treatment rather than a second
visual language.

**Settle up is one column at every width.** A transfer reads as a sentence ("A pays B $30")
and sentences side by side are harder to scan than a list, so the auto-fill grid that gave a
phone one column and a desktop three now gives every width one.

---

## 4. Cross-cutting Technical Design

### 4.1 Time zones (first-class)

- Store every timestamp as **UTC** _and_ keep the Location's **IANA zone**
  (e.g. `Asia/Shanghai`).
- Render in the **place's local time**, with an optional "your local time" overlay.
- Use **Luxon** (or `@date-fns/tz`) everywhere; never do naive `Date` math.
- Travel legs that cross zones (e.g. flight) recompute local arrival correctly.

### 4.2 Travel time

A leg is **derived** from who is going where (M3.1). This section is about how
long it takes.

**The routing ladder**, in order, stopping at the first answer:

1. The user's own `mode` / `mins` on the leg. Always wins, forever, including
   over a later provider answer. Somebody who has been there knows better.
2. The provider, via `routeLegs`, cached by `(from, to, mode)` in `cache.ts`.
   Google Routes answers walk, cycle, drive and transit when the server key is
   configured. OSRM is the keyless fallback for drive and transit labels only,
   because asking it about a walk would return a driving time wearing a walking
   label.
3. `fallbackEstimate`: straight-line distance times a crow-flies factor, at a
   speed per mode, with **flight above 500 km**. An eight-hour drive block drawn
   across a day is a worse lie than a flight with airport time added, so the
   fallback changes mode rather than reporting a number nobody would believe.

**Routing happens in the API route, not in persistence** (`dayLegs` in
`apps/api/src/routes/schedule.ts`), for two reasons: a write should not wait on a
provider before it is allowed to succeed, and a read that cannot reach one should
still answer, with the straight-line estimate. So persistence plans and stores
structure, and the route fills in durations on the way out.

**Google has two keys because the trust boundary has two sides.** The browser
map receives `GOOGLE_MAPS_KEY`, which is public by design and can only be
protected with an HTTP referrer restriction. Server-side Places, photo proxying
and Routes calls use `GOOGLE_SERVER_KEY`, which is secret and can be restricted
to the EC2 instance IP. Routes must not fall back to the browser key when the
server key is missing, because that would make an exposed credential useful for
billable server APIs again. During the production env migration,
`GOOGLE_PLACES_KEY` remains a warned compatibility fallback for
`GOOGLE_SERVER_KEY` only.

**Reads re-plan rather than reading structure back** (`legsForDay`), because
placing a leg needs the times of the two events it joins, and those change more
often than the leg does. A planned leg with no stored row is skipped: a read
racing a write shows one fewer journey for a moment, rather than inventing an id
the client would immediately try to edit.

Legs that cross zones recompute local arrival correctly.

### 4.3 Maps

- **Mapbox GL JS** (or Google Maps JS). Day-scoped route + numbered pins.

**`GoogleMap` reconciles its overlays; it never rebuilds them.** Callers build
the `tracks` array inline in their render, so it is a new object every time. The
draw effect used to depend on that array and to clear every marker and construct
them again, which meant dragging a block on the schedule board, which re-renders
at pointer rate, tore down and rebuilt the whole map many times a second: the
pins visibly blinked for the length of the drag. The effect now keys off a
**content signature** of the tracks, so identical data redraws nothing at all,
and when the data does change it walks the existing markers and tells them their
new position, icon and title. A marker that is removed and replaced flashes; one
that is updated does not. Renumbering pins after a reorder is the common case and
is now a `setIcon`, which is invisible. Measured during a 24-step drag: **zero**
markers constructed, against one full rebuild per pointer move before.

### 4.4 Realtime collaboration

- WebSockets via a small Node hub, or a managed backend (Supabase Realtime).
- Optimistic UI + last-write-wins per ScheduleItem; presence indicators.

### 4.5 Currency

Rates come from the keyless `open.er-api.com` daily USD table, held **in memory**
in `providers/fx.ts` (not Redis), refreshed in the background when older than 12
hours and seeded from a static fallback so a conversion never blocks on the
network. Every pair converts through USD, which is the only column the feed
publishes.

**The list of currencies is the fallback rate table**, in
`@trippy/core/currency`, and both the home-currency picker and `fx.ts` read it
from there. They used to be typed separately and disagreed in both directions:
the picker offered ZAR and BRL, which the table had never heard of, and omitted
five it did carry. That mattered because `perUsd` answered `1` for an unknown
code, which is indistinguishable from a correct conversion, so a trip created in
ZAR before the first live refresh landed folded every foreign expense into its
total at par, silently, in a number people settle real money against. A currency
now exists exactly when it can be converted with the network down, and an
unconvertible code **throws** rather than defaulting: a bug about money should be
loud.

Store the original currency and amount; convert only for display and settlement.

**A recorded expense is locked to the rate it was entered at.** Balances used to
be rebuilt from today's rates on every read, which meant a euro dinner was worth
a different number of dollars each time the page loaded, and a trip that had been
settled to zero could drift back out of balance months later without anybody
touching it. Every expense tool locks the rate to the transaction, and so does
this one: `expenses.fx_rate` holds units of home currency per unit of the
expense's own currency at the moment it was written, and `expenses.fx_home`
records which currency that rate targets.

`fx_home` exists because a trip's home currency can be changed after the fact. A
stored rate is only trusted while it still matches the trip's current home
currency; when it does not, the reader falls back to a live conversion and the
next edit re-locks it. Editing an expense keeps its rate unless the currency
itself changed, so correcting a typo cannot revalue the line. Rows written before
these columns existed carry NULL and read live, as they always did.

**Estimates deliberately do not lock.** `cost_items` and lodging prices are
forecasts of money not yet spent, so they should follow today's rate; freezing a
budget to a stale one would be the bug, not the fix.

**One conversion, one read path.** The expenses endpoint builds every row's
home-currency figure from `expenseShares`, the same division the balances are
built from, rather than converting the amount a second time on the way out.
Converting again would silently use _today's_ rate for the row while the
ledger underneath it used the locked one, so a euro dinner's "≈ $X" and the
trip's total spend disagreed with the balances they were supposed to explain.
The only rows that still convert live are those with no stored rate to use.

**The currency field is a typeahead, not a dropdown.** The offline table is
twenty codes, but every field is filled from whatever the server sends, and once
live rates land that is roughly a hundred and sixty. A `Select` over that many
unlabelled three-letter codes can only be scrolled, so all five currency fields
(expense, estimate, stay price in both the add and the edit dialog, and the
trip's home currency) are `CurrencyPicker`, a thin wrapper around the existing
`SearchDropdown`. It needed one prop there, `openOnEmpty`: a local list is
complete, so an empty query is all of it rather than none, which is the opposite
of what a remote search wants. Rows carry the code and its English name and a
query matches either, so "yen" and "jpy" find the same row. The names live in
`apps/web/src/lib/currencies.ts` rather than beside `FALLBACK_RATES`, because
they are display labels and they cover codes that table has never heard of,
which must not read as currencies the app can convert offline. A code with no
name shows as the code alone: a guessed name is worse than none, since half the
point of it is to be searched for. The input shows the chosen code whenever it
is not focused and becomes the query while it is, with the code as the
placeholder behind it, so the field never hides what is selected.

**Changing a password signs the other devices out.** A session here is a bearer
credential with a 30 day life and no link back to the password it was issued
against, so without this the usual reason to change a password (somebody else
may know it) would not be addressed by changing it. The device that made the
change keeps its session; being logged out by your own action reads as failure.

**Failed attempts back off, and the backoff is counted twice.** Verifying a
password is scrypt, deliberately slow so a stolen `users` table is worth little.
Unthrottled, that cost points the wrong way: every guess is free to send and
expensive to serve, so the endpoint is both a password oracle and a way to pin
the process at 100% CPU from a laptop. `infra/throttle.ts` gives five free
attempts, then doubles the wait per failure up to fifteen minutes, and forgets
everything on a success or after an hour of quiet.

Failures are counted against the email _and_ against the caller's address,
because either key alone leaves an obvious hole: count only the email and a
spray tries one common password against every account in turn without tripping;
count only the address and a botnet grinds one account from a thousand of them.
A blocked request is refused before the key derivation runs, which is the whole
point, and does _not_ extend its own block, so a third party cannot keep an
account locked out by hammering it. Login, register and the password-change
endpoint all go through it; register counts successes rather than failures,
since one person signing up is one account. State is in memory and lost on
restart, which is the honest trade here: a persistent counter would mean a disk
write per failed guess, handing the attacker a cheaper lever than the one being
defended against.

**An invite is addressed to an email, not to an account.** So changing your
profile email consumes any invites waiting at the new address, the same way
registering does. Without it, somebody invited at their work address who then
corrected their profile would simply never appear in the trip.

### 4.6 Outbound email

Two providers, Amazon SES and Resend, both over plain `fetch`. SES is preferred
when both are configured: `AWS_ACCESS_KEY_ID` may be in the environment for
unrelated reasons, but a `MAIL_FROM` on a domain SES has verified is not an
accident.

**SigV4 is hand-rolled** in `infra/sigv4.ts` rather than reached through
`@aws-sdk/client-sesv2`. The SDK brings a credential-provider chain, a retry
strategy and a middleware stack to do what this app needs four HMACs and a
string for, and the mail module's whole premise is a provider it can talk to
with no dependency and no socket to keep alive. The cost is that a signing bug
is indistinguishable from a wrong secret, since both come back as an opaque
403, so `sigv4.test.ts` checks the signer against AWS's own published vectors
(`awslabs/aws-c-auth`, `tests/aws-signing-test-suite/v4`) rather than against
what the implementation happens to produce. The signer deliberately covers
headers only, one string body and no query string, and throws on a query string
rather than canonicalising it the wrong way: every unsupported case is a case
that cannot be silently wrong.

The `host` header is derived from the URL rather than accepted from the caller,
because a host header that disagrees with where the request actually goes is
the one mismatch AWS cannot catch, seeing only the header.

**With no provider configured, sending is skipped rather than failed.** A trip
works end to end without email, so a missing key must not turn inviting
somebody into an error. This is load-bearing beyond convenience: it is what
lets the E2E suite and a fresh clone register accounts without an SES identity.

### 4.7 Emailed links: confirming an address, and forgetting a password

Both flows are one credential in two requests, and both keep that credential in
`infra/tokens.ts`: 32 random bytes, base64url, compared by SHA-256 and stored
only as that hash. A table of live links is a table of ways into accounts, so
it holds nothing that can be replayed if it is read.

**Registration confirms before it creates, not after.** The attempt is parked
in `pending_registrations` and no `users` row exists until the link is spent.
The alternative, an account marked unverified, writes a real row holding an
address its owner never agreed to, and `users.email` is UNIQUE, so that row
denies the real owner the account permanently. An unproven address should cost
a row that expires and nothing else.

Consequences the code has to carry, and does:

- The password is hashed at the _first_ step, so the plaintext never outlives
  the request that carried it.
- Asking twice replaces the first attempt rather than adding a second, and
  voids its link. Two live links to one address is one more than anyone needs.
- The address can be claimed by somebody else while the link is in the post, so
  `completeRegistration` re-checks and refuses. The pending row is already
  deleted at that point, because retrying could never succeed.
- Confirming signs them in. They proved the address and typed the password
  minutes ago; a login form here would ask them to prove it twice.

**Resetting drops every session, not just the other ones.** Whoever is resetting
is not holding a session, which is why they are here, so there is none worth
keeping, and the person this defends against may well have one. For the same
reason a reset does _not_ hand back a session: the link arrived by email, and
signing in from it would undo the clear-out in exactly the case it exists for.
Resets live one hour against registration's twenty-four, because this one opens
an account that already exists.

A link is spent whether or not it turns out to be in date, so a stale one
cannot be retried and a live one cannot be replayed. Every refusal is the same
sentence, "That link is no longer valid. Ask for a new one.", because wrong,
spent and stale are the same thing to the person holding it, and telling them
which would let somebody probe for links that once existed.

`/auth/forgot` always answers 200 with the same message. Anything else is a
membership oracle for any address a stranger types. It is throttled by address
as well as by caller, because it sends mail to somebody who did not ask for it,
and an unthrottled one is a way to use us to pester a third party.

Expired rows are pruned when a link is issued rather than on a timer: the
tables only grow when somebody asks for a link, so that is when it is worth
looking, and it keeps the server free of a background task whose only job is
deleting rows nobody can use.

**Registration still creates the account outright when no provider is
configured.** See §4.6: the E2E suite and a fresh clone register through this
route, and a deployment that cannot send mail should not be one where nobody
can sign up.

### 4.8 Who is on a trip

A person on the trip is a **display name**, and an **email only if they are
going to use the app**. The address used to be the whole of an invite, which
meant every name on the roster was guessed from the local part of an address
("Jamie Lee" out of `jamie.lee@`) and somebody not using the app could not be
represented at all, even though the money almost always involves them.

Three outcomes, because there are three kinds of person being named:

| Result    | What was typed                       | What happens                                                                                                                  |
| --------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `added`   | an address with an account behind it | membership only; the typed name is discarded, because their name is their account's and is shared with every trip they are on |
| `invited` | an address with no account           | placeholder member plus a `trip_invites` row, waiting for them to register                                                    |
| `created` | a name and nothing else              | placeholder member, no `trip_invites` row                                                                                     |

A `created` person is a full member id: they can pay, owe, be assigned, be
voted for and be settled with. They carry no "invited" tag, because there is no
address and so nothing is being waited on.

**Nobody is emailed.** An invite email was built and then scrapped. The address
on a person is a **key, not a notification**: it is the thing a later
registration is matched against, so whoever signs up at it arrives as
themselves rather than as a stranger the organizer has to reconcile with the
placeholder they already made. The mail added nothing to that, and it added a
failure mode (a message the app claims to have sent, to somebody who never
asked, at an address the organizer may have mistyped) to a step that otherwise
cannot fail. Groups that plan a trip together already have a way to tell each
other about it. `providers/mail.ts` now sends only the two messages that belong
to signing in, verification and password reset, and neither is optional.

The consequence worth knowing: **adding a person is silent to that person.**
They find out they are on the trip when they register, or when somebody tells
them. If that ever needs fixing, the fix is a share link, not a mail: one URL
the organizer sends however they like, which is both cheaper and the thing they
were going to do by hand anyway.

**The organizer, and only the organizer, can set the address of somebody who
has not registered.** For anybody else the address is their own account's: it
is how they sign in and it belongs to every other trip they are on. A seeded
sample companion is excluded for the opposite reason, that it is not a person.

Saving an unchanged address does nothing, and the dialog does not send it.
While the mail existed, saving the same value again was how an invite was
re-sent, so it deliberately did fire; with nothing to re-send, a write that
changes no row and a notice reporting it are both noise.

The address lives in two places, `trip_invites.email` and the
`placeholder:<email>` password hash, so `setMemberEmail` moves both in one
transaction. A row where the two disagree is an invite that cannot be revoked,
or one a registration will never consume.

Attaching an address that already has an account is refused rather than merged.
The two would be one person with two member ids, and the ledger has no way to
say which of them owes what; the organizer removes the placeholder and adds the
real person instead, which merges nothing and loses nothing.

### Bounds on what a member may type

Twelve people were put through the app at once with instructions to break it.
Almost everything they broke came back to the same omission: a field that was
checked for being blank and for nothing else. The rules below are the answer,
and they live in `packages/core/src/validate.ts` so the API, the client and any
future client state them identically.

**Amounts are bounded to a hundred billion major units.** An expense above
`Number.MAX_SAFE_INTEGER` cents stored perfectly well, and then `node:sqlite`
threw `RangeError` on every subsequent read of that column. One row took the
whole Expenses page to a 500 for all twelve members, permanently, with no screen
left from which to delete it. The bound is far below the safe-integer limit on
purpose: whole cents stay exact up to that limit, but the display path divides
cents into a double, which stops being cent-exact somewhere above seventy
trillion major units. A hundred billion keeps arithmetic and rendering both
exact and still clears any real trip by orders of magnitude.

**A settlement may not exceed the debt it settles.** The idempotency token is
looked up _first_, before the debt is checked. Settlements count toward the
balance, so once one is recorded the debt is gone; checking the debt first would
make a repeated press fail the bound rather than return `duplicate: true`.

**Links are checked before they are stored and again before they are drawn.**
`javascript:` and `data:` URLs were accepted and rendered into a real `href`,
which is a script that runs when somebody else clicks the card. Only `http` and
`https` survive, a scheme-less string is treated as a host, and anything without
a dot in the host is not a link at all. It is re-checked on render because rows
written before the check exist in the database.

**Names are capped at 200 characters.** A single unbroken run of five thousand
characters is not a long name, it is a layout attack: with no break opportunity
it sets the minimum width of whatever draws it and pulls the page out to several
thousand pixels. The stylesheets now break anywhere, which contains the damage;
the cap stops the input, because a name nobody can read is not worth storing.

**Days and times must land inside the trip.** An event could be created on a day
the board does not offer, which put a block somewhere nobody could navigate back
to; a missing trip start meant the fallback day came out as 1900-01-01. Times are
refused rather than clamped when they describe an event that ends before it
begins: the store still clamps as a last resort, but a clamp shows the organizer
a time they did not choose and explains nothing.

**A place must be near the city it is filed under.** The radius is 150km, which
is deliberately generous: a city list is a list of places to go _from_ a city,
and that includes the day trip and the out-of-town airport. What it catches is
the search still showing one city's results after the dropdown moved to another,
which lands hundreds of kilometres out. It refuses only when it can know: a city
the geocoder never placed, or a place typed by hand with no coordinates, passes.

### Deleting something other people can see

Two rules, both learned the same way.

**A delete takes its dependents with it.** `poi_id` and `lodging_id` are both
`ON DELETE SET NULL`, which left the calendar holding blocks that pointed at
nothing and said nothing about why. Places were given an explicit cascade first;
stays now match them, in one transaction, and the confirmation is told the count
beforehand so the question names what is about to go.

**A 404 on a write says who did it.** In a trip several people are editing, by
far the commonest way to reach one is that somebody deleted the row while this
dialog was open. "Could not save that task." describes the outcome and hides the
cause, and members retried a save that could never work. The message now names
the cause, and `useMutation` resyncs the section on any 404 so the list stops
drawing a row that no longer exists.

### Events are versioned like everything else

Expenses and tasks were given a `version` column after lost updates were watched
happening. Events were the last collaborative row without one, so an event save,
which writes the whole record back, silently erased whatever the other person had
just saved. Dialog saves now carry the version they opened on and are refused
with a 409.

Drags and resizes are deliberately left unversioned. They carry exactly one
field each, so there is nothing stale riding along to overwrite, and holding a
gesture to a version the board refetches constantly would refuse perfectly good
drags whenever somebody else touched an unrelated event.

---

## 5. Architecture & Stack

| Layer         | Choice                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| Frontend      | **React** (Vite + React Router). See 5.0; SvelteKit is being retired                      |
| Styling       | Tailwind CSS                                                                              |
| Server API    | Standalone JSON API (`apps/api`), consumed by web and native                              |
| Validation    | Zod (shared client/server schemas)                                                        |
| Auth          | Lucia (or Auth.js for SvelteKit)                                                          |
| ORM           | Drizzle ORM (production target)                                                           |
| Database      | Local dev: Node built-in `node:sqlite`. Production target: PostgreSQL + **PostGIS** (geo) |
| Cache         | Redis (directions, FX)                                                                    |
| Maps / Places | Mapbox GL + a Places provider                                                             |
| Dates         | Luxon                                                                                     |
| Realtime      | WebSocket hub / Supabase Realtime                                                         |
| Testing       | Vitest (unit) + Playwright (e2e)                                                          |

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

| Workspace       | Contains                                                      | Ported to native?     |
| --------------- | ------------------------------------------------------------- | --------------------- |
| `packages/core` | Types plus pure logic: settlement, split, tz, layout, cover   | Yes, unchanged        |
| `apps/api`      | JSON API over the `node:sqlite` modules; owns the Google keys | Yes, shared over HTTP |
| `apps/web`      | Vite + React + React Router + Tailwind                        | No, web only          |
| `apps/svelte`   | The original app                                              | **Deleted at parity** |
| `apps/mobile`   | Expo / React Native (not yet created)                         | n/a                   |

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
React scaffold listed nine sections and landed `/trips/:tripId` on the schedule.
The app has **five** tabs, in the order discover, preparation, schedule,
expenses, people, and the bare trip URL lands on **discover**. `settings` has no
page at all: it is the organizer's edit dialog in the trip header. `nav.ts` is
now the single source for all of this, and `App.tsx` generates both the tab
routes and the redirects from it, so adding a section cannot leave the router
and the tab bar disagreeing.

**Every slug is the label, lowercased.** Two were not: the tab reading
"Schedule" lived at `/calendar` and the one reading "Preparation" lived at
`/pretrip`, both left over from earlier names for those pages. A slug is the
name of a page as much as the label above it is, and two names for one page is a
thing to explain rather than a thing to read: it also meant nobody could guess a
URL, and a reader of the code had to hold a translation table.

The argument for keeping them was that a URL's whole job is to keep pointing at
what it pointed at. `REDIRECTS` settles that, so the rename cost nothing. It
holds four entries of two kinds, handled identically because a visitor cannot
tell them apart: `costs` and `lodging` were **folded** into the tabs that
absorbed them, and `calendar` and `pretrip` are the **old spellings** of tabs
that were renamed. An e2e test walks all four, because the redirect is the
load-bearing half of the rename.

These are the _page_ slugs. The API keeps `/trips/:id/pretrip`, which is a
different namespace nobody reads off a screen, and the Expo client keeps its
file-route names for the same reason.

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
and unreachable forever. `deleteTrip` sweeps up any placeholder the trip leaves
behind, in the same transaction.

The confirmation is the shared `ConfirmDialog`, and deleting closes the edit
dialog rather than opening on top of it: two stacked modals mean two scroll
locks and two Escape handlers. Cancelling reopens the edit dialog, so a change
of mind does not also close the thing you were editing.

**Every confirmation says one sentence: "Are you sure? This action cannot be
undone."** Each of the six delete flows used to explain its own blast radius,
some of them with live counts. The result read as six different voices arguing
for the same decision, and the longer bodies were the ones people skipped. The
name of the thing being destroyed carries the specificity instead, so it moved
into the title: _Delete Kyoto in Spring?_, _Delete Sam?_, _Delete Hotel
deposit?_. `ConfirmDialog` therefore takes no `body` prop at all, which is what
stops the explanations growing back one page at a time.

**The verb is always "Delete", on the button and in the title.** The buttons had
drifted apart: a person was "removed", a place with linked events said "Delete
and 3 events", a trip said "Delete trip". Three verbs for one act meant a reader
had to decide each time whether they meant different things. `useDeleteAction`
no longer takes a `confirmLabel`, so a caller cannot reintroduce one, and
`common.remove` is gone from `copy`. Detail that used to ride on a button rides
in the title, the one place detail is allowed: _Delete Acropolis and 3 events?_.
The single exception is **Leave**, which sits beside Delete on a trip and is a
genuinely different act: you stop taking part, the trip does not end.

The cost is real and was accepted deliberately: the dialog no longer names what
a removal moves. The rule that the wording is identical everywhere was judged
worth more than the one screen where a warning helped. The
`GET /people/:userId/removal-impact` endpoint, its client type, and the
`removalImpact` query that fed those counts are gone with the copy; the cascade
they documented is now recorded on `removeMember` itself, which is where it
actually happens.

**A placeholder who is named on an expense is kept as a tombstone, not
deleted.** Removing an invited-but-never-registered member used to delete their
`users` row outright, and that row is what `expenses.payer_id` and
`expense_participants.user_id` point at. Both cascade, so removing someone
deleted the whole expense they had paid for and silently moved everyone else's
balance: real money left the trip with a name. `removeMember` now asks first
whether that person appears anywhere in the ledger, as a payer or as a
participant. If they do not, they are deleted as before. If they do, they are
treated exactly like a registered member who leaves: the membership goes, the
`users` row stays, and the expenses stand. The invite row is deleted either way,
so the address can always be invited again.

Keeping the row costs nothing elsewhere. A placeholder's email is the synthetic
`placeholder-<uuid>@waypoint.invalid`, so a tombstone never occupies the real
address and never blocks that person registering later. It has no invite row
left, so `consumeInvites` will not quietly re-add them on registration, which is
the correct reading of a removal. `deleteTrip`'s placeholder sweep now looks for
placeholders by membership **or** by ledger presence, because a tombstone has no
membership and would otherwise be the one row a deleted trip left behind.

**A flagged expense shows a sign, not a word.** An expense whose payer or
participant is no longer a member is flagged `needsReview`, which `listExpenses`
derives rather than stores: a tombstone is exactly what makes it light up. The
flag used to render as a `Tag` reading "check", which competed with the
description for the same line and read as a label on the expense rather than a
problem with it. It is now a warning triangle beside the description, with the
explanation on `aria-label` and `title` so the sentence is available on hover and
to a screen reader without being printed on every flagged row.

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
container. The two classes it does carry, `max-w-full h-auto`, are standard
utilities and exist only as a floor: they let the drawing shrink, keeping its
ratio, if it is ever handed less than its 220px.

**One empty state, one size, on every page.** The block was already identical
everywhere (`py-12`, one 280px drawing, one caption), but the panel behind it
was not, because each caller framed it differently: Discover and Preparation put
it inside a `card px-5 py-5` and Expenses and the estimates inside a `card p-0`,
so the same panel measured 354.8px on two tabs of a trip and 314.8px on two
others, and the trips index had no card at all, which left the drawing's
surface-filled body as white cut-outs on the page background. Moving between
tabs the drawing jumped.

The rule that removes it: **the empty state is the whole panel.** It carries its
own `px-5 py-12`, and a caller hands it a `.card` with no padding, so nothing
about the page it is on can change its size. Padding stays on the cards that
hold real rows, which is why the two Expenses tabs and the Preparation task card
set it only when there is something in them.

The drawing went from 280px to 220px at the same time. At 390px it sat in a
300px column with ten pixels to spare, which is an advert for a fly rather than
a quiet note that a list is empty.

**The two computed states in Expenses keep the caption and drop the drawing.**
"Everyone is even" and "Nothing to settle" are answers the app worked out, not
lists you have failed to fill, and the fly with nowhere to go is the wrong
picture of a settled ledger. They are the same component with `graphic` off, so
they are centred with the same padding in the same unpadded card and only the
drawing is missing; before this they were left-aligned and a third of the
height, which made one page show two unrelated-looking empty treatments.

**An empty panel starts at the same y on every section of a page.** The sizing
above made the panel the same shape everywhere; it did not stop it moving.
Narrow, Preparation rendered its header row on the estimates whether or not
there were any estimates to head, and an empty flex row is not free: it carries
`mb-4`, so at 390px the empty card on Estimated costs began 16px below the
identical card on Tasks and Packing and the panel stepped down as you switched
sections. Expenses had the same shape of bug and a bigger number, 53.6px, from
its figure band plus that margin above an empty ledger while Balances and Settle
up opened straight onto their card.

The rule both now follow: **narrow, a header row is rendered only when it has
something in it.** Wide, both pages still reserve the band, because the Add
button lives in it there and reserving is what keeps the sections aligned.
Discover needed nothing: its header holds the type filter, which is the same
control on all four views.

Note this was a page bug, not a component one. `EmptyState` measured 340 x 273.8
on all three Preparation sections before and after; only its y moved.
 It is a first-run page rather than
a hole in a list: it has a heading, a sentence and the trip's single call to
action, and it is the only thing on the screen. Folding it into `EmptyState`
would mean opting out of the drawing, the centring and the caption-only shape,
which is the whole component.

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
what the fallback is _for_, so nothing looked broken, and a type-check cannot see
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
as the _default action_ of the Escape keydown, not by listening for the bubbled
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
_needed_ an owner. It is a `MultiSelect` rather than a grid of checkboxes: the
grid was fine for three people and unreadable for twenty, and the dropdown is
already how the row itself asks who has finished.

**Packing takes no roster at all, because the list is already one person's.** A
task is work handed out; a packing item is your own bag, so asking who it is for
is a question with one answer. The dialog for one is a single field, the row
carries no menu, and the item keeps one tick, which is yours.

A packing list is **private**, not the trip's. A shared list of twenty people's
socks is nobody's list: it is unreadable, and what you pack is nobody else's
business. `trip_tasks.owner_id` says whose row it is, null meaning the trip's
own, which is what a task stays. `listTasks` scopes packing to the caller, and
`addTask`, `updateTask`, `toggleTask` and `removeTask` all refuse a row owned by
somebody else, so no client can read or write another person's bag. Nobody lost
anything in the change: the migration hands each item from the shared era to
every member as their own copy, carrying the tick it already had, and the first
member keeps the original row so its id survives. Seeded trips give the packing
list to the account looking at the trip; the sample companions pack off-screen.

The rule that a packing item takes no roster is enforced in `addTask` and
`updateTask` rather than in the form, so no client can put one back on.

**"Assigned to me" takes the whole row out of the list.** The full list is sorted
by what is outstanding across everyone, so your own two jobs can be anywhere in
it. The block answers the question most people open the tab for. It holds the
real row, roster menu and pencil and bin included, and those rows leave the list
below rather than being repeated in it: the same task in two places is two boxes
to reason about, and one ticked while its twin sits unticked a few pixels down
reads as a bug. It is the same `TaskList` with the same props, so a row behaves
identically whichever card it is sitting in; only which rows land in which card
differs. An earlier version gave the block's leading box a different meaning,
ticking your own row where the list's ticks the whole task's. Two boxes that
look the same and do different things is worse than the scrolling it saved. The
lists are titled only while the tab is actually split, and the lower card is not
drawn at all when everything is yours. It is tasks only. Packing is already a
list of your own things.

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
the _format_ is not obvious.

**The estimates are folded by category, not listed flat.** The question people
open the section with is "what is the lodging going to run to", and a flat table
made that something you answered by reading every row and adding it up yourself.
Each category is a section whose header carries its own subtotal, so the answer
is there before anything is expanded, and the detail folds away once it has been
read. The four categories are a fixed vocabulary, so an empty one is still
listed, at zero, as a line of text rather than a caret that opens onto nothing:
its absence would read as a category that does not exist rather than one nothing
has been put in yet.

**The subtotals replaced a row of category chips.** The chips said the same four
numbers a few pixels above the same four categories, and they could not be acted
on. Putting the number in the header it belongs to costs no space at all.

**The two figures moved onto the "+ Add" row.** They are the answer the section
exists for, and a band of their own above the card only pushed them further from
the rows that add up to them. The row is shared by all three sections and keeps
its height, so switching sections never shifts the card below.

**A line with nobody on it is the whole trip's; a line with people on it is
split between exactly those people.** That single rule is enough to express the
things a real budget has, one person's single supplement, the three people doing
the day trip, without a second concept, and it makes the common case, an
estimate for everybody, the one that requires no input. It lives in
`pretrip/shares.ts` so the list, the section subtotals and the header stat can
never disagree about what somebody owes.

**"View as" sits on the table, not in the header.** It changes what the table
says, so it belongs where the change happens. Set to a person it drops the lines
they are not on, swaps every amount for their share, and turns the second stat
and the card's foot from "Per person" into "<name>'s share": the average is a
useful number for the organizer and the wrong number for anybody asking what the
trip will cost _them_. A departed member is dropped from a line by joining
`memberships` when the roster is read, so a removal cannot leave a phantom head
dividing the amount.

**Estimates round plainly.** `shareOf` divides by the head count and rounds,
where the expense ledger walks the remainder so the cents sum exactly. Nothing
is settled from an estimate, so a cent of drift across a category costs nothing,
and the simpler rule keeps a share readable in isolation.

**An estimate no longer names a city.** The field was on the row from the first
version and was never used for anything: it did not group, filter or total, and
most lines of a trip budget (flights, insurance, the car) are not a city's at
all. Splitting a stay per city is what the per-night lodging estimate is for.

**An estimate is stored in the currency it was typed in.** A hotel abroad is
quoted in the local currency, and asking someone to convert it by hand before
writing it down throws away the only number they can check against the booking,
and bakes today's rate into the record forever. `cost_items` carries a
`currency` beside `amount_cents`, and `getItemizedBudget` derives a `homeCents`
per line through `convertCents`. Every figure that gets summed or compared, the
section subtotals, the grand total, the per-person share, `shares.ts` in its
entirety, is the converted one, because a euro added to a yen is not a number.
This is the same division the expense ledger already makes; the difference is
only that an estimate is never settled, so it rounds plainly.

An empty currency means "the trip's home currency" rather than the home
currency being copied in at write time. Every row written before the column
existed was typed in the home currency, so that is already the honest reading of
them, and it keeps following the trip if the organizer later changes it, which
is what someone who never picked a currency would expect. `lodging_options` has
read its own currency column this way since it was added.

**A converted figure is marked "≈", underneath the figure it came from.** The
estimates row is the ledger's row: label above a muted line saying who it is
for, and an amount block on the right that stacks the headline figure over the
one it was derived from. That is the whole reason it holds its height, since the
label already gives every row a second line for the converted amount to sit on,
and it is why the two tables read the same way. Whole-trip view puts the amount
as typed on top with "≈ home" beneath it; read as one person, the share takes
the headline and "of <line total>" goes underneath, exactly as `ExpenseRow`
does.

An earlier attempt put the converted amount in extra columns of its own, with
the "≈" in a fixed-width slot. It kept the heights equal but it did not read as
one column, and the estimates stopped looking like the ledger they are a
forecast of. The lesson is recorded because it is the obvious first move: a
second currency belongs on a second line, not in a second column.

**The subtotals reserve the row's hover gutter.** A row keeps the width of its
pencil and bin to the right of its amount, so without a matching spacer every
subtotal and the grand total sat that much further right than the numbers they
are the sum of, which read as two columns. `ActionGutter` holds the space open
on the lines that have no actions. The section headers and the grand total also
take the tinted band the ledger's footer uses, which is what separates them from
the rows: on a plain background a subtotal was just another number in the
column. The grand total shares that tint, so it is set apart by weight and
height instead.

**"View as" is one component, shared with the ledger.** `components/ui/ViewAsBar`
and `components/ui/Stat` are used by both Preparation and Expenses, so the two
money screens cannot drift into two different answers to the same question. The
bar hides itself on a solo trip, where the only person to read a list as is you,
and is not drawn above an empty list.

### 5.0.5 Discover: places, stays and the search

**One grid, ordered by votes, in every view.** The server already returns each
pool in vote order, but the grid drew all the stays and then all the places, so
under **All** a stay nobody wanted still sat above the most popular thing in the
city. That made the ordering look arbitrary in the one view where it carries the
most meaning: All is what you open to see what the group actually wants. Stays
and places are now merged into a single list sorted by votes descending. The sort
is **stable** and the pools are concatenated in server order, so ties keep the
meaning they already had: a stay ahead of a place, and a locked stay ahead of the
other stays.

**Voting reorders the grid, so the reorder is animated.** The list is ordered by
the very thing the button changes, which means acting on a card reshuffles the
page under you. Cards are placed by an `auto-fill` grid rather than by
coordinates the app controls, so there is nothing to hang a CSS transition on:
the browser simply paints them somewhere else. `hooks/useFlip.ts` does FLIP
instead. It records where each child was, lets the browser lay the new order out,
then offsets every child back to where it came from and animates the offset away,
so the layout is never fought, only the paint.

Two details are load-bearing. Children are keyed by **identity**
(`data-flip="poi:<id>"`), not by position, or a card would animate into the slot
of whichever card now stands where it used to. And positions are measured
**relative to the container, not the viewport**: `getBoundingClientRect` is
viewport-relative, so a scroll between two renders shifts every child equally and
FLIP reads the whole grid as reshuffled. Scrolling and then voting slid all
eighteen cards across the screen until the measurement was made container-
relative; it now animates the two that actually swapped. `FlipGrid` is the thin
component around the hook, which exists because Discover derives its order after
the loading and empty branches have returned, and a hook cannot be called there.

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

**A stay is editable, and clicking it is how you edit it.** Places had an editor
from the start and stays did not, so the only way to fix a wrong price or a
typo'd name was to delete the stay and propose it again, which threw away
everyone's votes over a spelling. `PATCH /stays/:id` writes the whole set of
things a proposer typed (name, the one free-text line, nightly price, link and
the night range) in one go, so clearing a price or a link is expressible;
a patch of named fields cannot say "no price".

The editor deliberately does not touch votes, the lock or the photo. A corrected
price is the same stay, so re-opening the vote every time somebody tidies a name
would make the board unusable, and the photo is provider-derived and refreshed
from the provider, as on places. Currency _is_ editable, and sits beside the
price on the way in as well as on the way back: a stay abroad is quoted in the
local currency, and converting it by hand before typing it loses the number you
would check the booking against. The column has existed on `lodging_options`
since the table was written; only the form was missing. Any member may edit, on
the same reasoning as deleting
and as setting the nights: a stay is a shared proposal, not one person's
property.

The night range is on this form even though the calendar can also set it
(`PATCH /stays/:id/dates`, which predates this and stays), because the nights
are what a nightly price multiplies out against. The affordance is the card
itself rather than a pencil, matching the place card exactly: cover, title and
meta are one button, and the vote, open and remove controls sit outside it so
the card never nests one interactive element inside another.

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
_not_ named as deleted, because they are not: their FK is `ON DELETE SET NULL`,
so a block keeps its title and slot and only loses the link back to the place.
That is worth saying, because deleting a single place _does_ take its calendar
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

**The corner of the footer says whether the thing is on the calendar.** A place
already knew how many scheduled events pointed at it, and said so in a line of
its own: "🗓 On the calendar ×2", above the controls. That is a whole line of a
small tile spent on a fact most cards do not have, and it pushed the footer of
every card that did have it out of line with the rest of the grid. It is now the
calendar glyph alone, in the corner the footer row leaves empty, with the count
kept as its accessible name and its tooltip: the same trade `WarnMark` makes.
A stay now answers the same question, which it could not before: the query in
`cityLodging` counts the stay bands booked into it, mirroring the `linked` count
`cityPois` has always returned for a place.

**Booking one is one picker with two lists.** `events.lodging_id` was a real
column with a real index that only the seeds ever set, so a stay card carried
the mark on a seeded trip and never on a trip somebody built by hand. The place
field now follows the block's type: a stay picks from the stays the city is
voting on, everything else from Discover's saved places. It stays one field
because it is asking one question either way, which of the things we already
shortlisted is this, and `placeLabel` had said "Stay" for a stay block since
long before there was anything to pick.

Three consequences, all of them load-bearing:

- **The two links are exclusive.** `editEvent` writes `poi_id` and `lodging_id`
  together, never one alone, because retyping a block from activity to stay has
  to release the museum as it takes the hotel. Otherwise both Discover cards
  would count it.
- **An edit's type may be changing in the same request**, so which list the
  picked id is resolved against has to follow the type the block is _ending up_
  as, not the one stored. Hence `editedType`, and `currentType` exported for it.
  The dialog clears the picked id when the type crosses that line (`keepsPick`),
  so a place id never survives into a stay block to be silently dropped.
- **`lodging_options` gained `lat`/`lng`.** The stay band is where the morning's
  first journey starts, so booking into a lodging option with no coordinates
  would have quietly broken the planning that picking a place used to supply.
  The provider already returned them; `POST /discover/stays` was throwing them
  away.

**Icons are inline SVG with `currentColor`.** That is what the app already did
for the one icon it had (`Modal`'s close button), so no icon dependency was
added for four small glyphs.

### 5.0.6 Calendar: the board, crews and the port's one plain stylesheet

**The calendar is the only page with its own stylesheet, and that is deliberate.**
`calendar.css` is plain CSS rather than Tailwind utilities because the board is an
absolutely positioned time grid whose geometry _is_ the layout. A block's `top`
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

**So is the gesture itself, for both a drag and a resize.** `dragRef` and
`resizeRef` hold the truth and the state beside each is only the copy that
renders. Pointer moves are continuous, so React may not have committed the
pointer-down that started the gesture by the time the first move arrives: a
handler reading through its closure sees `null`, a quick flick does nothing, and
a fast press-and-release can leave the gesture standing. The resize kept the
closure version for a while after the drag was fixed, which is the sort of
asymmetry that survives precisely because it is only wrong when the hand is
fast. Both paths now write through one `put…` that sets the ref and the state
together, and every handler reads the ref.

**A drag or resize only writes when the snapped value actually changed.** Live
position snaps to five-minute steps so the label never shows decimals, and a
resize will not go below `MIN_EVENT_MINS`, which is the same floor the dialog
and the server use rather than a fifteen repeated by hand. Pressing and
releasing without moving therefore costs no request, which is what makes
click-to-open and drag-to-move able to share one pointer sequence.

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
the app pretend it knew which city every day belonged to. The board uses the first
city as the trip-wide default and lets `events.city_id` be the only explicit
override. It deliberately does not slice the trip range across cities in sort
order, because that would fabricate the schedule this change removes.

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

**Superseded: each row shows the day the money moved.** The paragraph above is
kept because its reasoning about ordering and about the year still holds, but
its premise does not. `expenses.spent_on` and the API's `parseSpentOn` both
landed afterwards, and the form never asked for the day, so every expense was
stamped with the date it was typed in: a trip whose receipts are entered on the
flight home was dated wrong on every row, and re-saving an old expense dragged
it forward to today. "Nobody is asked to date an expense they are typing in
now" is exactly right for the common case and is why the field defaults to
today; it is not a reason to have no field.

So the form carries a date, beside the description, on the line above the money:
what it was and when it was, then how much, in what, and by whom. It is not
`required`, because an empty box is a defined answer on the wire (the server
keeps the stored day when editing and uses today when adding), and a native
constraint would block the submit before the server could say so. It opens on
the stored day when editing, which is what stops an edit from re-stamping a
backdated row, and it is sent on every save so that the day on screen is the day
that is stored.

The ledger, and a settlement's dialog, print `spent_on` rather than `created_at`.
The two are the same on almost every row, and the rows where they differ are
precisely the ones somebody backdated on purpose. The day is read in the
reader's own zone, not a destination's: "which day did this money go" is a fact
about the person who spent it, which is the same reasoning `formatTimestamp`
carries, and the default of today is taken from the reader's calendar rather
than from UTC so that nobody in Auckland is offered yesterday all morning.

Its label is the one string on that form not yet in `@trippy/copy`; it is
written inline with a `COPY:` note naming the key it wants.

**The ledger opens with the same header the estimates do.** Its two figures,
the trip total and either the per-person average or the viewed member's share,
sit in line with "+ Add", and the hint sentence that used to occupy that row was
dropped: it repeated a note the add dialog already carries. What is spent
excludes settlements. A payment between two members moves money that was already
counted, so adding it would make the trip look more expensive every time
somebody paid a friend back.

**"View as" reads the ledger as one person.** Every row shows what it charges
that member, with the whole amount underneath it, and rows that charge them
nothing drop out, plus the payments they made. A row somebody else paid and did
not split with them costs them nothing, and a column of zeroes is not an answer.

The per-row shares come from `expenseShares`, which is also what `balances` is
now built from, so the number a row says you owe and the number your balance is
made of cannot disagree. It keeps the existing rule, convert to the home currency
first and split the converted total, so the shares still sum to the expense
exactly and the balances still net to zero. Settlements keep showing their full
amount rather than a share: a transfer is not a cost anybody divided.

### 5.0.9a The People tab

**Renaming is offered only to people who cannot log in.** An invited placeholder
is named after the local part of the email it was invited with, and a seeded
sample companion was named by the seeder, so both names are the trip's to fix. A
registered member's name is their account's: it is theirs to change in Account,
it follows them onto every other trip, and no organizer of one trip should get to
rewrite it. The alternative, a per-trip nickname on `memberships`, was rejected
because every query that reads a name would then have to resolve two of them.

`renameMember` refuses anything else: a non-organizer caller, a member of another
trip, a blank or over-long name, and any user whose `password_hash` is neither a
`placeholder:` nor a `seed:` marker. It republishes members, expenses, schedule,
places, lodging, tasks and estimates, because the name is drawn on rows all over
the trip and not just on the roster.

**The row controls are the drawn pencil and bin the rest of the app uses,** on
the row's hover, replacing a text "Remove" link. On a two-column roster that link
read as the row's main action, which removing somebody is not; the weight belongs
in the confirmation, which still spells out what is destroyed.

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

### 5.0.12 The mobile client

`apps/mobile` is an Expo / React Native app that talks to the same `apps/api`
the web client does. It is the port the whole monorepo restructure was for, so
most of the decisions below are about _not_ re-deciding things the web app has
already settled.

**Expo SDK 57, and nothing that needs a custom build.** Every native module used
is one Expo Go already bundles, so previewing the app is a QR scan rather than a
signed development build. That constraint is worth keeping until there is a
feature that genuinely needs a custom module.

The SDK version is not a free choice. The app was first written against SDK 56
and Expo Go refused to open it: the App Store build only accepts the newest one
or two SDKs, and 56 had already aged out. So the floor is set by whatever Expo Go
currently ships, and it moves. Expect to be forced upward roughly every SDK
release for as long as previewing through Expo Go matters, and treat that as a
standing maintenance cost rather than a one-off. Pin by hand when upgrading:
`npx expo install --fix` asks for patch versions Expo has not published yet
(57.0.19 wants `expo@~57.0.21` and `expo-router@~57.0.20`, neither of which
exists), so it fails on a tree that is actually fine.

**Metro keeps hierarchical resolution, with the React packages pinned.** The
obvious monorepo config sets `resolver.disableHierarchicalLookup = true` to stop
a root-hoisted copy of React being loaded alongside the app's own. It does stop
that, but it also stops Metro finding a dependency nested inside another package,
and SDK 57 relies on nesting: `@expo/metro-runtime` keeps its own `@expo/log-box`,
which npm cannot hoist because the root holds a different version. With the walk
disabled the bundle fails to resolve it at all.

`metro.config.js` therefore leaves the walk on and solves the narrower problem
directly: a `resolveRequest` hook re-resolves `react`, `react-dom` and
`react-native` as though the importer sat in `apps/mobile`, so the app's copy wins
no matter which package asked. Nested dependencies still resolve normally. The
root genuinely does hold a second React (the web app's), so this pin is load
bearing, not defensive.

**`packages/copy` holds the strings and the formatters.** `copy.ts` and
`lib/format.ts` moved out of `apps/web` verbatim, and the web app kept one-line
re-export shims so no import there changed. The reason is not tidiness: both
clients render the same money and the same dates, and a formatter that
disagreed between them would be a visible bug that no type checker would catch.
`cap()` followed the same way once the mobile cost list needed it.

**Auth is the same session row presented two ways.** A browser gets an httpOnly
cookie, which is the right answer there and the one thing script cannot read. A
native app has no cookie jar worth relying on, so it gets a bearer token. The
client opts in by sending `x-trippy-client: native`; only then does the response
body carry `token`, and only then is the cookie skipped. `sessionId(c)` reads
`bearer ?? cookie`, so logout, expiry and revocation are one code path rather
than two. A web client that never sends the header cannot be made to leak a
token it could store.

The dev-only CORS block exists purely for Expo's _web_ preview, which is
genuinely cross-origin on Metro's port. A native app sends no preflight.
Credentials are deliberately not allowed, so the allowance cannot be used to
ride a browser's cookie session.

**The trip id comes from context, not from the route.** `useLocalSearchParams`
reads the params of the _focused_ route, and a tab that has been navigated to
but not yet focused reads them as `undefined`. That produced requests to
`/trips/undefined/...` on every tab except the initial one. The `[tripId]`
layout always sees the segment, so it reads the param once and provides it
(`src/trip-id.tsx`).

**Dialogs became bottom sheets.** That is what a phone user expects of a form
that appears over the page, and a sheet anchored to the bottom keeps its fields
next to the keyboard instead of behind it. The body scrolls under a height cap
because the tallest form, the expense split, grows with the roster; without the
cap the save button is pushed off the screen on a large trip.

**Controls diverge from the web where the shape of the screen argues for it,
and only there.** Assigning people is a dropdown of checkboxes on the web and a
row of chips here, because a phone has the width to show the whole roster at
once and chips cost no tap to open. A list too long for chips gets a searchable
sheet instead (`ListPicker`, used for the several hundred IANA zones). The tab
bar carries the same five destinations in the same order as `apps/web/src/nav.ts`
so that knowing one client is knowing the other.

**The header has room for one control, so the avatar owns all three
destinations.** The web app puts All trips in the header and the rest in a
dropdown; here All trips, Account settings and Log out share the avatar menu.
The menu is a `Modal` rather than an absolutely positioned view because a native
header clips its children and a popover drawn inside it would be cut off at the
header's own bottom edge.

Calendar is deliberately an empty tab. A redesign is planned, and porting the
board before that lands would be work done twice.

### 5.0.13 Live location on mobile (design only, not built)

A phone is the only client that can answer "where is everyone right now", and
that question has a real use here: the calendar already splits a trip into
tracks, and a track that has drifted is exactly what the organiser cannot see
today. This section records the design so the feature can be built later
without re-arguing it. **Nothing below is implemented.**

**What it is for.** Showing trip members roughly where each other are, during
the trip, on a map. It is _not_ a history feature and it is not attendance
tracking. Auto check-in against scheduled stops falls out of the same signal
and is worth having, but it is a consequence, not the goal.

**Why it cannot be built on Expo Go.** Background location needs
`expo-location`'s background permission and an `UIBackgroundModes` entry, so
the app has to become a custom development build. That is the reason to keep
every _other_ native dependency out of the app for as long as possible: the
first feature that forces a custom build should be one that earns it.

**Battery: never poll.** The whole design is that the app asks the OS to wake
it on an event and otherwise runs not at all.

- iOS: significant-location-change (roughly a cell-tower move, a few hundred
  metres) plus a geofence per scheduled stop for the current day. Both wake a
  suspended app, both are served from location the OS is already computing for
  other apps, and neither turns on GPS on our account.
- Android: the fused provider at balanced-power priority with a long interval,
  plus the geofencing API, inside a foreground service with a persistent
  notification (which Android requires and which is honest anyway).

A trip member walking around a city produces on the order of tens of updates a
day, not thousands. Continuous or high-accuracy tracking is explicitly
rejected: it would cost battery all day to improve a number nobody reads to the
metre.

**Consent is per trip, and it expires by itself.** Sharing is off by default,
turned on per trip rather than per account, and time-boxed to that trip's date
range. It ends when the trip ends without anybody remembering to turn it off,
because a sharing switch that outlives its reason is how this kind of feature
becomes something people regret agreeing to. Turning it off deletes the stored
position rather than freezing it.

**Store one row per member, not a trail.**

```
trip_location_sharing(trip_id, user_id, enabled, expires_at)
trip_locations(trip_id, user_id, lat, lng, accuracy_m, at, source)
    -- primary key (trip_id, user_id): the row is upserted, never appended
```

Keeping only the latest fix means there is no history to leak, no retention
policy to get wrong, and no growth to manage. `source` records whether the fix
came from a significant-change wake or a geofence crossing, which is what makes
auto check-in possible without a second table.

**API sketch.**

```
PUT   /trips/:id/location            { lat, lng, accuracyM, at, source }
GET   /trips/:id/locations           -> [{ userId, lat, lng, accuracyM, at }]
POST  /trips/:id/location/sharing    { enabled }
```

`GET` returns only members who are currently sharing, and returns nothing at
all to a caller who is not sharing themselves. Reciprocity is deliberate: a
member who can see where everyone is while remaining invisible is the shape of
this feature that people object to.

**Web sees it read-only.** The web client can render the same map from the same
`GET`, because a member on a laptop in the hotel still wants to know where the
others are. It never writes.

### 5.0.14 What two people doing the same thing at once does

A group trip is planned by several people at once, often on the same screen in
the same room. Everything below was reproduced against a running server before
it was fixed, and is pinned in `packages/server/test/concurrency.test.ts`.

**None of it was SQLite.** The API is one process holding one synchronous
connection, so writes cannot tear or interleave mid-statement. Every defect
found was _logical_: two well-formed requests, each correct alone and wrong
together. Most of them reproduce by calling the functions in sequence, which
means concurrency did not cause them, it only made them easy to hit.

**Intent, not action.** Ticking a box used to send "flip", which applies the
caller's _action_ rather than their _intent_. Two people ticking the same box
left it unticked, and both were told it worked. A double tap did the same thing.
`toggleTask` now takes the state the caller wants and writes that, skipping both
the write and the event when it already matches. Omitting the state still flips,
so a client that has not been updated keeps working.

**Refuse a stale save; do not merge it.** `PUT` replaced the whole row from the
client's copy, so whoever saved second silently erased the first edit and got a
200 for it. Tasks and expenses now carry a `version`, and a save quoting an old
one is refused with 409. Merging was rejected: the roster of a task and the
split of an expense are _sets_, and "both edits applied" is undefined for a set
that two people rewrote differently. `isStale` treats a missing version as "not
tracking", so the protection is opt-in and no client can be locked out by
sending nothing.

**The settlement token is derived from the balances, not from the transfer.**
Pressing "mark paid" twice wrote two payments and inverted the debt: `-50` and
`+50` became `+50` and `-50`, and the app then suggested paying the money back.
A key over `(from, to, amount)` cannot fix this, because it cannot tell a
double press from two genuine identical payments. The token is instead a hash of
the whole balance vector plus the transfer, so two people looking at the same
screen derive the same one and their presses collapse; once a payment lands the
balances move, so a later identical payment carries a different token and is
recorded normally.

**Money does not leave with the member.** Removing somebody deleted only their
`memberships` row, and `balances()` iterated current members, so their share
dropped out of the total and the ledger quietly stopped summing to zero. What
should happen depends on how the expense was split, because only some modes
carry enough information to answer:

- `even` and `shares` are _proportional_: what each person owes is derived from
  the weights of whoever is on the expense. The leaver's row is dropped and the
  same total re-divides across the people who remain.
- `exact` is _stated_: each person owes a number a human typed. There is no
  honest way to reassign 40.00 of a 100.00 dinner without someone deciding who
  absorbs it, so the expense is left alone and marked for review. Guessing here
  moves real money between real people.

An expense the leaver _paid_ is untouched whatever its mode: the debt is owed to
them, and only the group can write it off.

`needsReview` is derived per request rather than stored, so it clears by itself
when the expense is edited or the person is re-invited; a stored flag would go
stale. Departed members with a non-zero stake are still shown in the balances,
tagged as having left, because a row nobody can explain is a better failure than
a total that is quietly wrong.

**What already held up, and stays tested:** the SSE bus delivers correctly under
concurrent writes, the duplicate-city and duplicate-invite guards hold, and a
write into a trip being deleted returns a clean 404.

### 5.0.15 The schedule board: stays, journeys, the agenda and the map

**A stay is a block, not a span across midnight.** It used to be one row reaching
from check-in on its own evening to checkout the next morning, so `end_min <
start_min` was normal and the board drew it twice: its own evening, plus a
striped "tail" over the following morning. The model broke on the thing the
board exists for, which is a group that divides. A span across the night is a
statement about the night, and a trip where half the group is in an apartment in
Plaka and half in a hotel by the airport needs two of them, each carrying its own
people. A block already carries people, so a stay is now an ordinary block: it
starts at 21:00, runs three hours by default, and clamps like anything else.
It can be dragged and resized from the board, which the old model could not
allow, because the edge under the pointer belonged to a different day.

The migration repairs existing rows with `UPDATE events SET end_min = 1440 WHERE
type = 'stay' AND end_min <= start_min`. Midnight is the honest answer: the row
says somebody slept there that night, and nothing in it survives about the
morning after.

**What was lost, and why it did not matter.** `incomingStay` still exists
server-side: the previous day's last stay is where the next morning's first
journey starts. Only the _drawing_ went, along with the `incoming` field on the
board payload. `planLegs` now normalises that origin to midnight, because a stay
no longer records a checkout and inventing one would be a guess with a number on
it.

**Journeys share the event columns.** Travel used to live in a fixed lane down
the right-hand side, on the reasoning that it is a consequence of the day rather
than part of it. In use that reads as the opposite of the truth: an hour on a
ferry is an hour you cannot be anywhere else, and drawing it beside the day left
the gap it fills looking free. Legs are now `LaneItem`s fed into `layoutDay`
beside the events, so they take real columns and contend for width like
everything else. A leg and a hand-entered `travel` event describe the same act
and now look the same: same colour, same chrome, same name on the front.

A leg keeps one difference, and it is a fact about the leg rather than about
where it came from: it cannot be dragged, because its place on the clock is the
gap between the two events it joins, and moving it would mean moving one of
them. Every journey is drawn, hung under the event it arrives at (below).

**Journeys can be named.** `travel_legs.title` is nullable and the board falls
back to `<Mode> from <origin>`, or to the bare mode where there is no room for
the origin or no departure event to name; resetting a leg to its automatic
estimate leaves the name alone, because "use the router's number" and "forget
what I called this" are different requests.

**The now line is gone, and so is the clock.** A red line at the current time is
information about the reader, not about the plan, and the plan is almost never
today. The toolbar's city clock followed it for the same reason: every time on
the board is already destination-local, so a live clock beside them was a second
reading of the same fact that changed every thirty seconds while nothing on the
day moved. Where the zone genuinely matters, which is a flight arriving on
another offset, the event says so.

**Journeys hang under the event they arrive at, and the board draws no lines.**
This replaced a connector system, and the history is worth keeping because the
same mistake is easy to make again.

The board used to hand journeys to the same packer that places events, then
reject any whose middle did not fall under both of the events it joined. It
asked a question it never tried to make true: the packer puts a journey wherever
a column happens to be free, which is rarely under either endpoint. On the
densest day that rejected 17 of 24 journeys, and each rejection became a line.
Three rounds of work went into making those lines read well, curves to right
angles, then shared channels and one arrowhead per arrival, then dotted and
drawn over the blocks. They were the best available version of the wrong idea:
35 marks on one day, of which 7 carried any information.

Anchoring each journey to its arrival removes the question. A bar is under the
event it leads into by construction, so there is nothing for a line to explain,
and `flowArrows`, the channel routing, the count pills and the multi-pass
demotion loop all went with it. Every journey is now a block that names its mode
and duration, and the rejoin case that the connectors handled worst, five groups
converging on lunch, is the case the bars draw best: a funnel across the lunch
block.

The measured argument, the alternatives considered, and the two cases where this
is weak (a group splitting is not drawn, and an impossible journey between
overlapping events still looks ordinary) are in `docs/notes/travel-decision.md`.

A short hop is drawn as a one-line rule carrying its mode and duration, floored
to a height a pointer can hit, and the floor grows upwards into the waiting time
before the journey: downwards is the block it arrives at, and covering that
block's top edge to make a three-minute walk clickable is a poor trade. Journeys
are also drawn before events for the same reason, so where the floor does have to
reach back past the block it left, the block stays on top. One line rather than
two whenever the true height is under `TWO_LINE_H`, which is what a name plus a
meta row actually needs; below that the second line clips rather than shrinks.

A bar names its **origin**, not its destination, and only while it has the width
for it. Its position already says where it lands, so naming the arrival would
repeat the drawing; the origin is the one fact the drawing gave up when the lines
went. Below `TINY_W` the bar gives up its padding and drops a type step instead
of its duration, because in the people view a bar is about thirty pixels wide
and "10m" is worth more than "1...".

**An edit is drawn on the board while it is typed.** A dialog that covers the day
makes the reader guess: a 20-minute nudge or a type change could only be judged
after saving and looking. `EventDialog` reports its draft upward and `Schedule`
patches it into the board memo, so the block retitles, recolours and moves as the
fields change, and Escape puts it back.

That needs the board left legible, so the dialog **peeks**: it takes a narrower
panel and drops the dim, leaving the page readable and scrollable behind it.
Below 1100px there is no room to leave uncovered, so it dims and holds the page
still like any other dialog; the preview is still computed, and the board is
right the moment the dialog closes. Which edge it stands at is the one not
showing the day being edited (`dockSide`). If the edit takes the block off
screen, the board scrolls to keep it, computed from the draft's own minutes
against the lane's rect rather than from the block: `.block` transitions `top`,
so measuring it straight after a change reads where it was, not where it is
going, and `scrollIntoView` then does nothing because the stale rect is still on
screen.

**A block that moves takes its journeys with it.** A journey is anchored to its
arrival, so its place on the clock is the gap in front of that block. Whenever
the board is showing an event somewhere the server has not agreed to yet, under
the pointer during a drag, during the write that follows, or in an edit preview,
the arriving journeys are shifted by the same minutes (`shiftLeg`); otherwise
they are left drawn under empty track. Their duration is untouched, because
moving an event later does not make the walk to it shorter.

Two limits are deliberate. The event columns are still packed from the stored
times, since re-packing under the pointer would move every other block on the day
while one is being nudged. And a change of type or of people drops the affected
journeys rather than shifting them: those decide whether a journey exists at all,
which is the server's answer to give, not a guess the board can draw.

**An event can be linked to a saved place after the fact.** Adding one offered a
Discover place from the start; editing one did not, so a block typed by hand
could never be given coordinates and stayed off the map and out of the travel
chain forever. The edit dialog now offers the same picker, and the server's
`edit` op takes `poiId`: absent leaves the link alone, empty unlinks it. The
coordinates travel with the link and are resolved by the route, because the
chain is planned off the event's own lat/lng and a link without them would put
an event nowhere while claiming a place.

Both dialogs gate the picker on `isLocatedType`, which now admits `travel` as
well: only free time is deliberately nowhere. On a journey the field is labelled
**Ends at** rather than **Location**, because a journey's address is where it put
you and asking "where is this flight" has no answer. The field is called
"Location" everywhere else, and its empty option "No location". "Place" was the
internal word for a Discover row leaking into the UI: a member reading the dialog
is saying where something is, not which database row it points at.

**An event is asked for as a start and an end, not a start and a length.** The
pair matches how the board draws it and how people say it ("two to four", not
"two for two hours"), and it removes the arithmetic from the common edit, which
is moving the far end. Both pickers step by fifteen minutes, the shortest event
the server allows, and the end list starts one step after the start, so an event
that finishes before it begins cannot be described and there is no refusal to
word. Moving the start carries the end with it and keeps the length, because
that edit is far more often "this happens later" than "this runs longer".
`withCurrent` still carries a time off the grid, which is what dragging and
resizing produce.

The dialog's wording follows the rest of the app rather than the schema: the
title is **Edit event** beside Add event, Edit place and Edit cost, and the
first field is **Name**, which is what a place, a stay, a task and a journey all
call theirs. Its fields sit on the same twelve-column grid the expense and cost
dialogs use, so a field keeps its width whether or not the one beside it is
showing: Mode comes and goes with the type, and the old flex row re-flowed the
whole form each time it did.

Every control on that grid is `--control-h` tall. The people picker was not: its
trigger sized itself from its chips and came out four pixels short, so "Who" sat
off the baseline its neighbour shared with every other field in the app. Height
belongs to the control, not to what it happens to be holding.

**A journey is edited where it arrives, in the event's own dialog.** A leg is
not a thing anybody creates: the server plans one for every pair of consecutive
events a set of people attends, so it has no life apart from the block it leads
into. Giving it a dialog of its own said otherwise, and made the common edit,
"we will need longer to get here", two panels instead of one. "Getting here" is
now a section at the foot of the event dialog, and `TravelDialog` is gone.

It is a list, not a field, because an event can have several approaches: one per
group of people converging on it, and the densest day of the Athens trip has six
arriving at lunch. Each journey is a card: who is on it reads above the fields,
and the name, mode and minutes sit on one line under it. The origin is the
card's
placeholder rather than a label, since it is only ever a fallback name, and the
board's bar falls back the same way when the previous event is not loaded: the
first journey of a day starts at the night before it.

Only the rows actually touched are written. A leg is unpinned by default, so
sending every row back on Save would pin a whole day's travel as the price of
renaming one event. The comparison is against the values the dialog opened with,
and it includes the reset: handing a journey back to the router is a change like
any other. They are written after the event, and matched by key rather than by
id: an edit to who is going is what makes journeys exist, so the row a journey
lands in may only arrive once the server has replanned off the people just
saved.

**The add dialog asks the same question, because adding is when journeys
appear.** The section used to belong to the edit dialog alone, which meant
describing a new block, naming who was going, and saving a day whose travel had
been planned and never shown, then reopening the block to see it. The board
already draws the new block under a draft id and replans the day around it, so
the journeys arriving at it exist while it is still being typed; both dialogs
now render the same `useJourneys` section off the same replanned list. What the
reader said is keyed against the draft id and re-pointed at the real one after
the create returns, which is `rekeyLeg` in core, next to where the key is built.

The id survives a failed save. The event is written first and the journeys
after, so a journey that will not write leaves a block that already exists; the
new id is kept, and pressing Add again finishes the save rather than adding the
block a second time. The add dialog reads its draft journeys before "view as" is
applied, unlike the board behind it, because a dialog about who is coming has to
list everyone who is.

**Changing the mode rewrites the minutes.** The number beside the mode is an
answer to a question the mode asks, so leaving the old one in place when the
mode changes states a duration nobody believes: a walk and a taxi over the same
ground are not the same twelve minutes. Picking a mode now re-estimates, and
picking the planned mode back at its own estimate leaves the journey unpinned
rather than pinning a number that happens to agree.

**Each mode carries its estimate in the menu, not on the card.** The reader
choosing between walking and the metro wants the two durations side by side, and
before this they had to pick one to find out. The menu now reads "Walk 26 min",
"Transit 20 min", and the chosen duration becomes the value in the box beside
the picker. The hint is a menu-row affordance only: the closed trigger still
reads "Walk", because once a mode is chosen its duration is already in the next
field and saying it twice on one line is noise.

**Automatic is derived, not flagged and not labelled.** The edit state used to
carry an `auto` boolean and the card a line reading "Pinned" or "Automatic" with
a link back to the estimate. All three said the same thing the fields already
said: a journey sitting at its own mode and its own estimate is not pinned, and
typing that estimate back is how it is handed to the router. The flag is gone,
the note line is gone, and the save compares the edit with what the day would
have worked out anyway. The comparison accepts the straight-line guess as well
as a bought answer, because a routing reply can land between the pick and the
save, and a journey nobody meant to pin should not be pinned by the provider's
timing.

The estimate is arithmetic, not a purchase. The routing provider answers for one
mode, which is the one the server planned, so offering a bought answer for each
of six modes would mean six routes to display one. `minsByMode` in
`packages/core/travel.ts` turns the straight-line kilometres into minutes at a
pace per mode, with a fixed overhead and a floor, and `guessLeg` picks the mode
the same way the server's fallback did. The server now calls the same function,
so the number the dialog shows for the planned mode is the number the server
would have fallen back to, and the two can never drift. It costs `km` on the leg
wire shape, which the board was already computing.

**A time is typed, not picked.** The start and end were dropdowns of every
quarter-hour, which is 72 rows: setting 2:45 PM meant opening a list, scrolling
most of the way down it and hitting one row among seventy, and the reader
already knew the answer before they opened it. `TimeField` is the macOS shape,
segments in one box: digits replace, arrows step, and the caret moves on by
itself once a segment can take no more, so "245p" lands on 2:45 PM. Segments
rather than a free text box because a free box has to parse what it is given and
can be wrong ("2pm", "1430", "half two"), while a segment holding one thing has
no input to refuse. It carries minutes past midnight, the unit the board and the
server already speak, so nothing parses a clock. The value runs to 24:00 rather
than wrapping to 0, because midnight is the end of the board and not the start
of it; what that end reads as on a twelve-hour clock is under "The typed time
fields read twelve hours" below.

Each segment is a fixed width, wide enough for two of the widest digits, and
that is the whole of what holds the colon still. It used to be a floor rather
than a fixed width, propped up with `tabular-nums`, and neither worked: "23"
outgrew the floor and shunted the colon along, and the tabular figures made the
one number the reader types read as a different typeface from every other number
on the same page. Tabular figures earn their place in a column of data, which is
what the agenda times and the money totals are. A clock in a box is not a
column.

The pair is one field labelled "When", since a start without an end is not an
answer. A typed end can be behind the start for as long as it takes to press the
second key, so nothing is refused while the field has focus; the shortest event
the server accepts is what it settles on when focus leaves. Moving the start
still carries the end.

**A journey is marked, not filled.** The card for the journey the reader
pointed at takes a rule down its edge rather than an accent fill: lunch has six
arrivals, and six filled cards are a wall of colour where the mark only has to
answer "which one".

**Pointing at a journey opens its arrival.** The bar on the board is still
clickable, and it opens the same panel, scrolled to that journey's row with the
row marked and its minutes focused. A block with six approaches would otherwise
open a form the reader has to search.

**An unchanged place is never sent.** `poiId` is absent-means-leave-alone and
empty-means-unlink, and the dialog used to send the picker's value every time.
For an event that holds coordinates without a saved place, and the whole Athens
seed is like that, the picker reads "No location" the moment it opens, so a
reader who came to move the end time and pressed Save silently wiped the spot
the day was planned around, and every journey to it with it. The field is sent
only when it differs from what was loaded.

**The place picker is grouped by city, nearest first.** A trip through four
cities has a picker four times longer than the reader wants, and the place they
mean is almost always in the city they are looking at. `placeOptions` sorts the
day's own city to the top and labels each run with its name; `Select` grows an
optional `section` on an option and draws a heading wherever it changes, which
is the pattern `MultiSelect` already used for crews. Sections are an order plus a
name rather than a second structure, so there is nothing to keep in step. A place
whose city has since left the trip is offered under "Elsewhere" rather than
hidden: it still exists and still has coordinates.

**Event length steps by fifteen minutes.** The old list was eight hand-picked
durations that jumped from two hours to three to four, so a 2h30 dinner had to be
typed as something else. Fifteen minutes is already the granularity of the start
picker and the shortest event the server accepts, and twelve hours of them is
forty-eight rows, which is the same order as the 72-row start list. `withCurrent`
still carries a value that came from a drag and does not land on the grid.

**The automatic estimate is a link, not a button.** It sat in the footer beside
Save, at the same weight, which read as one of two equal ways to leave the dialog
when it is neither: it is a reset of two fields. It now sits in the muted line
under the journey it belongs to, next to the number it would set, and it only
appears as a link when a pinned value is actually overriding the router. When
nothing is pinned the line states the estimate in use, and when the router has no
answer it says so.

**Double-clicking the day creates an event there.** Adding used to mean the
toolbar button and a 9:00 default, which is a guess that is wrong most of the
time and has to be corrected by hand. A double click on empty track opens the
same dialog with the start snapped to the fifteen minutes nearest the pointer,
and on that path picking "stay" no longer overrides the start: a time the reader
pointed at is a better guess than ours. Clicks landing on a block or a journey
tag are ignored, because those open their own dialogs and a second one over the
top would be a trap.

**The grey fact strip left the event dialog.** It restated the start, the end and
the city, all three of which the fields above it already say, and the restatement
went stale the moment a select changed. What the travel dialog's strip carried
that no field did, the two events a journey joins and who is on it, is now the
muted line under each journey row.

**The agenda replaces the travel list.** The panel under the map used to list the
day's journeys. It now appears only while "view as" names one member, and shows
that person's whole day in order, events and journeys together. For the group the
same list is every track at once, which the board already draws better; it is one
person's thread through a divided day that columns make hard to follow.

**The map shows everything that was considered.** Every place saved in Discover
is a pin: grey for the ones this day does not visit, green for the ones it does.
A day is then read against the full field rather than against a blank one.

Green pins are numbered only when the day is a sequence, because a number on a
pin is a claim about order. Two tests, both about honesty. Nothing may overlap,
since two things at once have no first. And every event must carry the same
people, since a day that splits has one order per track and none overall; people
with nothing scheduled do not break this, as they are simply absent from every
list. Reading the day as one person drops the second test: their own thread is a
sequence however the rest of the group divides.

The same test gates the route line, for the same reason and more strongly. A
number on an out-of-order pin is a small lie; a line through pins from two tracks
draws a route nobody takes, hopping between groups that never met. So the day's
polyline appears exactly when the numbering does, and a split day gets pins only.

**The camera answers to coordinates, not to edits.** `fitBounds` used to run on
every redraw, because the draw effect keyed on the whole track list. Retitling an
event, nudging it an hour or changing who is on it all threw away the reader's
pan and zoom, and with the live edit preview (5.0.15) it happened on every
keystroke. Both maps now derive a separate key from the pin coordinates alone and
refit only when that changes, so moving the camera is something the reader does
and something new places do, not something typing does. `TripMap` also keys its
draw on a serialised copy of the tracks rather than on the caller's inline array,
which was a new identity on every render.

**A pin says more when you point at it.** The browser's own tooltip arrived after
a delay, held one line of unstyleable plain text and closed with the pointer, so
a pin could give its name and nothing else. Hovering now opens a card: which
track the pin is on, the place, then what kind of thing it is and when, then who
is going and how they get there. A grey pin gives its city, which is the one thing
neither its colour nor its track name says. Both maps do it, `GoogleMap` through
a single reused `InfoWindow` and
`TripMap` through Leaflet's popup, and the card is built as DOM rather than
interpolated into markup, because every line of it is typed by trip members.

**The card is drawn by the app, not by the map.** Both libraries offer a bubble,
and both draw it inside the map element, anchored above the pin, with no idea
that anything is in the way: a pin near the top of a 420px panel opened a card
with its first lines cut off, and a pin near a side lost its edge. Google's cure
is to pan the map, which slides the pin out from under the pointer and closes
what it just opened, and padding the camera to leave room only worked until the
reader panned. So `createCardLayer` puts one fixed-position layer on the body,
outside every scroll box and every map frame, placed from the pointer and
clamped to the window, flipping below the pointer when there is no room above.
It never takes pointer events, so it cannot steal the hover that opened it.

It opens on click as well as on hover, since a phone has no hover and a tap is
the only way to read a pin there. A tap on the map behind puts it away. It is
also closed whenever pins are dropped: a marker removed from under the pointer
never fires its `mouseout`, and the card would otherwise stand on the page with
nothing under it.

The card's content is read out of a ref by marker index rather than captured in
the hover listener, so a pin that keeps its slot through a re-layout shows its
new times without its listeners being rebuilt.

**The card ranks its lines rather than stacking them.** Four lines of identical
weight are a list, and a reader hovering a pin is not reading a list: they want
the name, and then, only if the name was not enough, the rest. The card now has
four levels down it. An eyebrow carries the track name in the track's own colour,
because that colour is the only thing tying a card to the pin underneath it and
nobody should have to learn a legend to use a map. The name follows in ink. Under
it, one muted line of what and when. Under that, the facts: who is going, and how
they get here.

**How you get here is the question a map is being asked**, so a day pin names its
arriving journeys: mode, where from, how long. They are taken from the legs
already on the board, so they answer for whoever is being viewed rather than for
the group in the abstract, and they stop at two. A day that splits can have a
journey per group, and six of them turn a hover card into a timetable; the board
itself is where the full list belongs. A grey saved pin has no journey and no
time, so it gives its city and its vote count instead, which are what a saved
place is read for.

Both maps build the card through one shared `mapCard` in
`apps/web/src/components/map-card.ts`. A reader with a Maps key and a reader
without one are reading the same trip, and the keyless fallback drifting into a
card of its own shape is a difference nobody asked for.

**One pin per point, not one per thing.** Several things can be at one address:
a venue saved twice from the same provider result, or five escape rooms run out
of one building. Drawn a pin each they land exactly on top of each other, so the
stack reads as a single pin and only the topmost one can be hovered or tapped.
The others are invisible and unreachable, which is what was reported. Both maps
now collapse the items of a track onto one pin per point, through one shared
`groupColocated` in `apps/web/src/components/map-groups.ts`, and the card lists
everything that pin stands for.

**Grouped on exact coordinate equality, with no distance tolerance.** The trips
in hand hold exactly one co-located set of saved places, three sharing a pair of
doubles to the last digit, and not one pair of non-identical places within 60m of
each other; the day tracks show the same, nine sets of bit-identical event
coordinates. So the duplicates being complained about are literally the same
numbers, which is what saving the same provider result twice produces. A radius
would buy nothing against that data while risking the thing a radius always
risks: merging two real venues that share a doorway. If near-duplicates ever do
turn up, that is the moment to decide what a distance means, with the data to
decide it on. Grouping is per track, because a pin can only be one colour, and
the board already keeps a scheduled place out of the saved track.

**The count goes in a badge, not in the pin.** The body of a pin is where the
order number goes, so a count written there would be read as one. The things
sharing a venue are not always consecutive stops. A day can visit a place, leave
and come back, so no single number is true of the pin: a grouped pin drops the
number and carries a small count badge at its corner instead. A pin standing for
one thing is drawn exactly as it was, down to its size and its anchor. The badge
never takes the pointer, because it overhangs its pin's box and a clickable
badge swallowed clicks meant for the pin next to it.

**A clicked card is held open; a hovered one is not.** A card that leaves the
moment the pointer leaves its pin is right for a glance and useless for a pin
holding nine things, which cannot be read, let alone scrolled, if it vanishes on
the way to it. So a click holds the card and gives it the pointer back, and a
click on the map, a hover onto another pin, or a redraw that takes its pin away
puts it down. The list scrolls at 18rem rather than growing, so a busy venue
cannot make a card taller than a phone.

**A travel problem is a mark, not a sentence.** A leg that does not fit its gap
used to be labelled "does not fit the gap" wherever it showed, which spends a
line of a crowded card on a phrase the colour had already said. It is now the
warning triangle, `WarnMark`, with the phrase kept as its accessible name and its
tooltip. The same mark appears on the agenda row, on the journey card in the
event dialog, and on the map card.

**The phrase itself was about the wrong thing.** "Does not fit the gap" describes
the gap, but the mark sits beside a _person_ in the "view as" menu and beside a
_journey_ on the board, so it read as a remark about them that had lost its
subject. It now says "Not enough time to get there", which is true of whoever or
whatever it is pinned to, in all four places it shows.

**The mark also reaches people who are not looking.** The "view as" menu carries
it beside anybody whose day does not join up, and beside "Everyone" when anybody
at all is caught, which is what puts it on the closed control. Reading it off the
filtered board would have defeated the point: the warning would vanish the moment
you looked at somebody else, so it would only ever reach the person who already
knew. The board memo is therefore split in two, `planned` before the "view as"
filter and `board` after it, and the warning is read from `planned`.

#### The day scrolls inside the board, not the page

**The complaint was losing your place, not being unable to reach the evening.**
The day grid is a pixel a minute over a window that opens at six, so an ordinary
day is around 1150px tall and every screen is shorter than it. Nothing was
clipped and nothing was unreachable: the page scrolled, and the whole board went
with it. What went with it was the day's title bar, its stepper and the lodging
band, so reading 22:00 meant no longer being able to see which day it was 22:00
on, or to step to the next one without scrolling back. A calendar keeps the
labels and moves the hours.

So the hours move on their own. `.boardscroll` is a box between the lodging band
and the bottom of the screen; the grid scrolls inside it, and the stepper and the
band stand outside it and stay. The hour gutter is inside, because it is the
axis: pinning it would pin the times to rows that had moved away from them.

**The agenda is in the same box.** It was left out at first, on the reasoning
that a list of the day's rows is short by construction and boxing a list only
makes two scrollbars out of one. That held for the seeded days and not for a real
one: a full day is forty rows, and the owner hit a day where the agenda ran past
the bottom of the screen and took the day's title and stepper with it, which is
the complaint the box was built to answer. So both boards now render inside one
`.boardscroll`, with the same measured height, the same 320px floor and the same
`70vh` fallback: one mechanism, not two. A `list` modifier drops the 12px of
head room the hour labels need, since a list has no label hanging above its first
row, and adds a little air under the last one. Nothing is imposed on a short
agenda, because the box is a `max-height`: a nine-row day measures 321px tall in
a box that would allow 500, so it does not scroll and shows no bar at all.

**The height is measured, not stated.** The box's top depends on a toolbar that
wraps at narrow widths and a lodging band that may hold nothing or three stays,
so no `calc()` of viewport units can name it. It is measured in document
coordinates, `rect.top + scrollY`, which is where the box sits whatever the page
has been scrolled to. Reading the viewport-relative top instead would have fed
back: scrolling the page would grow the box, growing the box would grow the page,
and the page would scroll further. A floor of 320px keeps a short screen with a
usable window rather than a slot, and the CSS carries `70vh` for the render
before the measurement lands.

**A scroll container is where drag maths usually dies**, because a gesture
measured against the page is suddenly happening in a box that moves under it.
This one is delta-based (`clientY - pointerStartY`), so the pointer arithmetic
survived untouched; what had to move was everything that compensated for the
board moving _by itself_. Two things do that, and they are now one number,
`glue`, applied to the box's `scrollTop` as a difference per layout pass:

- **The window opening.** Dragging a block earlier than the window's first hour
  grows the grid upwards, which slides every minute already drawn, including the
  one under the pointer, down by the amount opened. This used to be cancelled
  with `window.scrollBy`; it is now the box that scrolls, by the same amount and
  in the same pre-paint layout pass.
- **Travelling at an edge.** A pointer held against the top or the bottom of the
  box keeps changing the block's time without moving, so the hours have to run
  past it. `creep` is that distance in minutes, and the box scrolls by the
  negative of it so the block stays put and the day moves.

They net out when both happen at once, which is exactly the case of opening the
window while already at the top of the box: the growth and the travel are the
same growth.

**Both edges travel now, where only the top used to.** On a page the size of the
day, dragging downwards had the rest of the document to travel through; in a box
a few hundred pixels tall it would have run out in a couple of hours. Pushing
against the bottom therefore runs the day on towards midnight at the same rate
the top runs it back, and `creep` carries a sign rather than gaining a twin.

**The block is held inside the box.** A viewport has edges the page did not: a
pointer carried above the top of the box wants its block drawn above it, where it
would be clipped and the gesture would be happening somewhere the reader cannot
see. Staying visible is worth more than the last few pixels of glue, so the block
pins to the edge it is pushing against while the hours keep running past, and the
start wins over the end, since a block taller than the box cannot show both and
the time it begins is the time being set. This is the one place the "stays under
the pointer" contract gives way, and the e2e test now says so: glued inside the
box, pinned at its edge.

**Scroll chaining is left on.** A flick that reaches the end of the day carries
on into the page, which is how the map under the board is reached on a phone,
where the box is most of the screen. `overscroll-behavior: contain` would have
made the board a trap at exactly the width with nowhere else to swipe.

**Nothing at the root was touched.** The reserved scrollbar gutter that made the
full-bleed header stop short of the right edge (see "The header reaches the right
edge") stays gone; this box is a descendant, and the page keeps the browser's
default gutter behaviour.

#### What the box cost, and what it was not

Three reports arrived together once the box was live: the drag had gone slow, the
scrollbar looked bad, and the time was cut off. They are three separate things,
and only two of them are the box's fault.

**The slow drag was not forced layout.** The obvious suspect was the box being
measured per pointer move, `getBoundingClientRect` and `scrollY` read in the same
frame as a style write. Measured against the running dev server, it was not: the
drag read a rect about 1.5 times a move and spent roughly 0.3ms each in Layout
and Recalc Style. What it did instead was commit a render of the entire page on
every move, because the drag lives in the page's state: 41 blocks, twenty legs,
the axis, the toolbar, the router links and the map's track assembly, about
10ms of script per move and 13.5KB of `JSON.stringify` per move on the map's
account alone. The board is therefore split into `memo` components at module
scope, each taking primitives or identity-stable props (`left` and `width` rather
than the layout object that is rebuilt every render, a member count rather than
the member array, precomputed strings for a leg), the map's tracks are a
`useMemo`, and the handlers they are given are `useCallback`s so the memo holds.
A move now costs about 5.4ms with a p95 move-to-commit of 8ms, down from 18ms.

**The ref stays the truth, and state is a frame behind it.** Pointer moves write
`dragRef` synchronously and mark the board dirty; the edge-travel rAF loop makes
the single `setDrag` for the frame. Coalescing state is safe only because nothing
that has to be exact reads state: pointer-up, the click-versus-drag guard and the
resize all read the ref, so a resize with one move between down and up still
lands on the minute it was released at.

**The scrollbar is the page's, not the platform's.** Inside a card, the native
bar arrived with stepper arrows and a white track hard against the card's edge. It
is now a 6px pill inset in a 10px bar, `--color-ink-faint` at 55 percent and full
strength under the pointer, on a transparent track. It does not fade, because in a
card with no other edge to read it is the only thing that says the hours go on.
The standard `scrollbar-width` and `scrollbar-color` are quarantined in an
`@supports not selector(::-webkit-scrollbar)` block: a browser that has both
prefers the standard pair and drops the `::-webkit-` rules, and Chromium's `thin`
bar brings the arrows back. Firefox, which has no `::-webkit-` scrollbar, takes
them instead. The root gutter decision is untouched.

**The time was cut off at the top, and the gutter was innocent.** An hour is
written across its own rule rather than under it, so `.hourline span` sits at
`top: -0.6rem` and the first label of the day hangs about 9.6px above the grid.
The old page did not clip and the box does, so the first hour came out sliced in
half lengthways: 8.8px of it, measured, at every width. The gutter was never the
problem, since "6 AM" measures about 29px inside its 48px box, so the gutter is
unchanged and the scroller leaves 12px above the first hour instead. The padding
is on the scroller rather than on `.daygrid`, because the grid's children are
positioned against its padding box and would not have moved, and because the grid
carries an inline pixel height. `BOARD_PAD_PX` repeats it in `Schedule.tsx`, where
the drag's clamp has to add it to keep the held block inside the box.

**Both midnights are named.** The closing rule of the day used to be left bare, on
the reasoning that a board dragged fully open would otherwise carry two "12 AM"s,
one under the other. Measured, they are a day and 1440px apart with twenty-three
named hours between them, and the box is capped at 70vh, so a screen has to be
over about 2050px tall before both are even on screen at once. What the bare rule
cost was paid on every ordinary board instead: the day ran 11 PM, blank, and
stopped without saying where. Each midnight is true where it sits, one opening the
day and one closing it, so both are written. The closing label is not what was
being clipped: it sits 7px clear of the bottom of the box, inside the 16px the
grid already carries past its last rule. Top clipping and the missing label were
two bugs, not one.

**The schedule toolbar has two rows on a phone, and they are chosen ones.** The
row carries three things: the `Day | Agenda` pills, the "View as" person filter
and `+ Add`. Measured, they hold one line down to 484px and wrap at 480px, and
what the wrap produced was not two rows so much as two leftovers: the pills alone
with 200px of nothing beside them, then the filter with `+ Add` jammed against
it. Below 480px the row is therefore laid out on purpose as a two-column grid.
The pills take the top left and `+ Add` the top right, which keeps the
convention that a section's action sits on the section's own row; "View as"
spans the second row with its select stretched to the full width, which is the
one control here that gains from being wide, since it holds people's names. The
breakpoint is the measured one, so no width that fits today is broken in two.
`.tools`, the wrapper that grouped the filter with the button, is
`display: contents` at that width: it carries no styling of its own, so it loses
nothing by not generating a box, and its children become grid items directly.

**One height, and the page's air belongs to the board.** The next report was
that the board and the map could both be taller. Measured at 1280x900 before
anything changed: the box started 458.5px down the page and came out 417.5px
tall, the map was a flat 420px in a 422px card beside a 557px column, and the
document was 989px against a 900px screen. So the box's formula was not the
conservative one it looked like. Above the box sit the page header, the trip
title and dates, the tabs, the toolbar, the day title and the lodging band, and
under it the card's padding; all of that is real, and only about 24px of the
total was guesswork. Two other things were wasting the screen. The page keeps
96px of trailing air under its last section, which on a page built to end at the
bottom of the screen only bought a second scrollbar around a board that already
has its own. And the map was a fixed 420px in a column 135px taller than itself.

The derivation is now shared and stated once: **screen height, less the box's own
top in document coordinates, less the card's measured tail, less 8px of air,
floored at 320px**. The 8px is the whole of the guess; the card's tail and the
page's tail are measured rather than assumed, and `VIEW_AIR` replaces the flat
24px gap that stood in for both. The day grid, the agenda list and the map all
take that one number: the first two because they are the same box, the map
because the split stretches its column and the map fills it. `.board`'s bottom
padding went from 1rem to 0.5rem on the principle that a pixel kept there is a
pixel of the day not drawn.

The page's air is handed back through `--tailpull`, a negative bottom margin on
`.sched` measured in the same pass that sizes the box. It is bounded by the air
that is actually there and floored at zero, so a board too tall for the screen
still scrolls the page down to its last row rather than losing it; and because
both the overflow and the air are read with the current pull already applied,
one pass lands on the fixed point instead of creeping toward it. It is written
straight onto the node rather than held in state, so it cannot start a render
loop. Below 901px it is off: the map sits under the board there, the page is
meant to scroll, and pulling the tail up would only crowd it.

After: the box is 424.5px, the map card 557px on the day board and 489px on the
shorter agenda card, and the document is 900px against a 900px screen, so the
second scrollbar is gone. The board gained 7px, which is honestly all the slack
there was at that size; the map gained 135px, and that is the visible win. At
390px nothing moves: the 320px floor binds, the map keeps its 420px under the
board, and the page still scrolls, which is correct on a phone where the map is
the next thing down rather than the thing beside.

**Leaflet has to be told.** The fallback map caches its container size, so a
container that grows under it leaves the new space blank until something fires a
window resize. Measured with the observer removed: growing the card from 383px
to 828px left the tiles ending 356px above the bottom of the box, six tiles for
a box that wants twelve. A `ResizeObserver` on the map element calling
`invalidateSize` closes it, and the same growth then fills the box with tiles
past its bottom edge. The Google map, which is what runs when a maps key is
configured, watches its own container and needs no equivalent.

## The board reads its clock as AM/PM

**The board was the only 24-hour surface left in the app.** Discover already
showed a venue's hours the way the provider gives them, "9:00 AM - 5:00 PM", and
the schedule next to it said "19:00". That is one trip described two ways on two
tabs, and the owner read the board as the one that was wrong. So every wall-clock
time the board draws is now twelve-hour with a meridiem: blocks, their accessible
names, journey legs, the agenda, the hour gutter and the map card.

**Through `Intl`, not through arithmetic.** A hand-rolled twelve-hour clock is
four lines and gets both ends of the day wrong: `h % 12` prints "0:00 AM" for
midnight and "0:00 PM" for noon, and neither is a time anyone writes. The
formatter is asked for `hour12` and it answers "12:00 AM" and "12:00 PM", which
is the only reason this is worth a helper rather than a template string.

**The minute is already local, so the format is done in UTC.** The board's unit
is minutes past midnight in the destination's own zone, which the API has already
resolved. Letting `Intl` apply the reader's zone on top of that would shift a
time that is in the right zone already, so a fixed UTC instant is built from the
minute and formatted in UTC. The conversion stays where it belongs, and this
stays presentation.

**One helper, three shapes**, all in `pages/schedule/shared.ts`:

- `clock(min)` is a single time, "7:00 PM".
- `clockRange(from, to)` says the meridiem once when both ends share it, so a
  block reads "9:00 - 11:00 AM" rather than spending a third of a narrow line
  repeating a word that has not changed. A range that crosses noon or midnight
  keeps both, because there the meridiem is the information.
- `hourLabel(h)` is an hour line, "6 AM". Minuteless because an hour line is
  always on the hour, and ":00" under every one of them is nineteen repetitions
  of nothing. It is also what keeps the gutter still: "6 AM" is no wider than the
  "6:00" it replaces, so the 56px gutter and its 48px label did not move and the
  grid did not reflow.

**`en-US` is named rather than inferred**, the same way `dayLabel` and core's
date helpers already name it. This is the deliberate part: for an app whose whole
premise is crossing time zones, a hard-coded twelve-hour clock is a parochial
default, and it is recorded here as one.

**What it would take to make it a preference.** The account already stores a
`homeTz` and nothing else about how times are shown, so a clock preference is a
new column, a new field on the profile form, and a way for these three functions
to read it. The functions are the easy part: they are the only place on the board
that decides what a time looks like, so a preference reaches the whole board by
being threaded into one module. The work is the setting, not the formatting, and
the honest version of it is locale-aware rather than a two-value toggle: a reader
who wants a 24-hour clock generally wants their own date order and their own
wording with it, which is a decision for the app's copy as a whole and not for
one page. Until that is wanted, `undefined` in place of `'en-US'` is the smallest
step and it is one line.

**The typed time fields read twelve hours.** `TimeField` is three segments now,
hour, minute and meridiem, because the board around it reads twelve: a block
saying "2:45 PM" that opened an editor saying "14:45" was the one place the app
spoke a different clock from itself. The value is unchanged and deliberately so.
It is still minutes past midnight, so this is how a time is read and typed
rather than what it is, and no caller of the field moved.

The rules the segments follow:

- The hour is 1 to 12 and unpadded, the minute is always two digits: "9:30 AM",
  never "09:30 AM". That is the pair `clock()` already prints on every block, so
  the editor and the board are written the same way rather than nearly the same
  way.
- Both midnights read 12, which is why the hour is computed around the wrap
  rather than as `h % 12`. A hand-rolled twelve-hour clock prints a bare "0:15
  AM" and the mistake is invisible until somebody is standing outside a closed
  door.
- "1" and "0" are the only digits that wait for a second one, since only they
  can still be the front of an hour; everything else stands alone and moves the
  caret on, so "2", "4", "5", "p" is the whole of 2:45 PM.
- A or P is taken from whichever segment has focus, because "2p" is how anyone
  says two in the afternoon and stopping to aim at a third segment for one
  letter is the work a typed clock exists to avoid. Setting the meridiem it
  already has is a no-op rather than a toggle, which is what stops a stray "A"
  from moving a time.
- **The end of the day stays 24:00 and reads "12:00 AM".** The board ends at
  midnight, an event may end there, and that value is the one the board and the
  server already hold, so it was not given up to make the twelve-hour reading
  tidier. It reads as the same "12:00 AM" `clock()` prints for it, and it is
  only ever seen as the far end of a span that started earlier the same day.
  Typed digits resolve the other way: "12" with AM is the start of the day,
  because digits alone cannot tell the two midnights apart and the start is the
  one a reader typing a time means. The end of the day is then reached by
  stepping the hour up from 11 PM, where the existing clamp holds it, or simply
  by leaving a block that already ends there alone.

**The event dialogs have no name field.** Names are derived server-side from the
place, the first non-blank line of the notes, then the type's own noun, so the
field was asking for something the reader had already said by picking a place or
writing a line about it. With it gone, the dialogs stop sending `title`
altogether rather than sending an empty one: absent means "leave the stored name
alone", so a block somebody deliberately named keeps its name through an edit
that only moved it, while an empty string would have re-derived one underneath
them. The wire contract is untouched; the client just has nothing to say about
the name.

Two rows were re-laid out around the hole it left, since the grid is 12 columns
and a row with one control in it reads as a mistake. Free time has no place
picker, so its Type moves down to share the clock's row, with the people running
full width underneath. A journey's Mode takes the rest of the second row the
people used to share, for the same reason. Every one of the five types now fills
every row it draws.

**The clock is sized by its content, and the row is sized around the clock.**
The field's three segments cannot shrink, so the box holding them must not
either: `.tfield` is `flex: none; width: max-content`. Without that it was a
flex item with `min-width: 0` inherited from `.input`, free to be squeezed by
the grid cell it sat in, and at 1280px a half-column cell gave it 101.8px for
107px of clock. The overflow came out of the last segment, so the focused
meridiem's highlight ran into the right border, which is what "the AM and PM
goes a little outside the input box" was. Shrinking the type or the segment
widths would have paid for the layout with legibility; the box is the thing that
should hold its ground.

The pair then has an honest intrinsic width: two 107px clocks, an 8px gap either
side of "to", 242px in all. Six of twelve columns is 232px in a 512px dialog, so
the clock takes **seven** columns and whatever shares its row takes five. That
is a 7/5 split rather than 6/6 because one side is a fixed measurement and the
other is elastic: a picker of avatars or a Mode select reads the same at 191px
as at 232px, and the clock does not. `.tfpair` also wraps rather than clips, so
a cell that is somehow still too narrow puts the end time on a second line
instead of cutting a digit off it.

Below `sm` the clock takes the whole row and so does whatever shared it. The
meridiem made the pair wide enough that half of a 390px dialog clipped the end
time mid-digit, which reads as a different time rather than as a truncation. The
content-width fix does not make that stacking unnecessary: at 390px the full row
is 313px, comfortably over the 242px the pair needs, but half of it would still
be 152px.

## Shared UI conventions

These exist so five pages don't each invent their own version. Reach for them
before adding page-local CSS.

**One type scale, eight steps, named for their role.** The app had accumulated
27 distinct font sizes in JSX alone, four of them within 0.01rem of each other:
`0.9`, `0.92`, `0.93` and `0.94` were all "the title of a row", and `0.84`
through `0.88` were all "the grey line under it". Nobody chose those
differences; they are what happens when each component picks a number in
isolation. The design system had tokens for colour, radius, shadow and control
height but none for type, so type was the one axis with nowhere to put a
decision. `@theme` now defines `--text-hero / title / heading / section / lead /
body / meta / micro`, and the rule is the same as for colour: no arbitrary
`text-[Nrem]` at the point of use. The names are roles rather than sizes so that
retuning a step does not turn its name into a lie. `calendar.css` is exempt
pending that page's redesign.

**`Avatar` and `Tag` are the person-circle and the status-pill.** There were
four hand-rolled avatars at 28, 30, 30 and 34px across three colour schemes,
and two of them disagreed on whether to uppercase the initial, so the same
member appeared as `A` on one page and `a` on another. Three hand-rolled pills
had the same story. Both now have one implementation.

**`useListbox` owns the dropdown keyboard.** `Select` and `MultiSelect` had
about seventy identical lines each: open state, the active index and its
mirroring ref, the outside-click and scroll-into-view effects, and the whole
Escape / arrows / Home / End / Enter / Space handler. Two copies of a keyboard
contract drift, and the drift is invisible until somebody tries the key that was
only fixed in one of them. What is left in each component is what genuinely
differs: `Select` starts on the current pick and closes when you choose,
`MultiSelect` starts at the top and stays open because picking four people out
of twenty should not be four trips through the trigger.

`SearchDropdown` is deliberately left out. It is a combobox, not a listbox: the
trigger is a text input, the caller owns `open`, rows can be disabled and
skipped, and the highlight has to survive the result set changing underneath it.
Folding it in would produce a hook that is mostly branches, which is worse than
the duplication it removed.

**A number field carries one stepper, not two.** The shares box in the expense
split dialog had explicit `−` / `+` buttons _and_ the browser's own spin arrows,
which is two answers to the same question on one control. The labelled buttons
win and `.input.stepped` suppresses the native pair: the native arrows are a few
pixels tall, unlabelled to a screen reader, drawn differently per browser, and
invisible until the field is hovered or focused, so they are worse on every axis
that matters here. The rule is per-field, not global: a plain number box with no
stepper beside it keeps its native arrows, since removing them would leave no
way to step at all.

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

**Wording rules that follow from that.** They are individually small and matter
only because the app is read as a whole, so they are written down rather than
re-derived:

- A confirm button repeats the title's verb, bare: "Delete Athens?" is answered
  by **Delete**, not "Delete city". The title already named the thing, and the
  button that has to restate it is a button in a dialog that failed to say what
  it was about. `ConfirmDialog` therefore defaults its label and callers pass
  one only when the verb genuinely differs, which now means Leave alone.
- A button whose section heading already names the thing says **Add**, with no
  noun after it. "Tasks / + Add Task" says task twice.
- An empty list renders `EmptyState` with the shared graphic and "Nothing added
  yet", with no full stop and no action button: it is a label, not a sentence,
  and the section's own Add button is always visible above it.
- A busy label ends in an ellipsis, because it names something still happening.
- No em dashes anywhere.

**Two faces, and the display serif never renders data.** Fraunces for headings
and the wordmark, Inter for everything else. The split is not only taste:
Fraunces ships no `tnum` feature, so its figures cannot be made to share a
width, and `1` measures two thirds of `0`. A headline total set in it shifts on
the line every time the number changes, and two of them side by side never line
up. The `Stat` figure on Preparation and Expenses was the one place this
happened; it is sans and `tabular-nums` now, which also matches the section
total further down the same page. Every other money figure in the app already
set `tabular-nums`. If a number wants emphasis it gets size and weight, not the
serif.

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
keystroke. Placeholders are for _format_ only, where the shape of the value is
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
said anything new: `addPerson` creates a placeholder member for any address with no account, so a
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
trapping, Escape-to-close, background inertness and top-layer rendering (immune
to z-index and `transform` clipping) for free. The one thing
`<dialog>` does _not_ do is lock body scroll, so the component does that
explicitly; that was the actual cause of the double-scrollbar bug.

**A dialog sits in the middle, unless it is previewing what it covers.** Docking
every dialog to an edge was tried and reverted. The argument for it, that a
dialog edits something on the page behind it and a centred panel covers exactly
that, is only worth anything when the page behind is actually being looked at,
and behind a dimmed backdrop it is not. What it cost was real: a panel pinned to
one edge of a wide screen reads as an accident rather than a decision, and it
made the app look unsure where its own dialogs live.

So `peek` is now the only thing that moves a dialog. It gives up the dim,
narrows the panel to 40vw and stands it at the edge `dock` names, for a dialog
whose edits are drawn live on the page (5.0.15), where dimming or covering the
preview would defeat the point. It is also the one case where the page stays
scrollable while a dialog is open. Docking being a consequence of peeking rather
than a setting of its own is what stops any other dialog from drifting back to
an edge.

**Focus restore is the app's job, not the browser's.** The native restore only
fires when the dialog is closed while still in the document, which covers the
always-mounted shape (`ConfirmDialog`, which toggles `open`) but not the
conditionally-mounted one: most edit dialogs are simply removed from the tree,
so `close()` never happens and focus falls to `<body>`. The keyboard user loses
their place on the page every time they cancel an edit. `Modal` therefore
records `document.activeElement` immediately before `showModal()` and puts
focus back itself.

Two details make it work, and both were found the hard way. A **mount-scoped
effect calls `close()` on unmount**, because a modal `<dialog>` makes the rest
of the document inert: calling `focus()` on the trigger while the dialog is
still open is silently ignored. And the restore is **deferred with
`queueMicrotask`**, because React runs effect cleanups before it removes the
DOM, so focusing at cleanup time aims at a node that is about to be detached.
The close effect is declared before the restore effect so it runs first; that
ordering is load-bearing. The restore is guarded on `isConnected`, since a
trigger that unmounted along with its row has nowhere to give focus back to.

Layout contract for consumers:

| Slot class    | Role                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `.mform`      | Optional `<form>` wrapper spanning body + footer                             |
| `.mbody`      | The **only** scrolling region. Never nest another `overflow: auto` inside it |
| `.mfoot`      | Pinned action row, primary button last                                       |
| `.mfoot-note` | Left-aligned hint text in the footer                                         |

`.mform` is a **descendant-styling hook**, not a layout class; it wraps `.mbody`
and `.mfoot`, so giving it `display: flex; gap` inserts a gap above the pinned
footer. Stack fields with a `.fields` wrapper _inside_ `.mbody` instead; `.mbody`
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

#### Every dialog says the same kind of thing

The dialogs had each been written to their own taste. Titles were variously a
verb phrase (`Edit cost`), a noun (`New trip`), a verb with an article
(`Add a task`) and a location (`Add to Athens`); submit buttons said `Add`,
`Add cost` and `Create trip` for the same act; and the cost dialog asked its
questions in prose (`What is it?`, `Who is it for?`) where every other form used
a noun. Nothing was wrong on its own, and together they read as four different
products. Three rules now hold, and they are worth keeping because each removes
a decision rather than adding one:

- **Title is `Add <thing>` or `Edit <thing>`**, lower case after the verb, no
  article. Where the thing sits inside something the user needs named, that
  context is the `subtitle`, never part of the title: `Add place` / _Athens_,
  `Add city` / _trip name_. Confirmations keep their own shape, `Delete <name>?`.
- **Submit says `Add` or `Save`, and nothing else.** The title already names the
  thing, so repeating it in the button is noise. Busy text is `Adding...` or
  `Saving...` to match the verb the button actually took.
- **Field labels are short noun phrases**, never questions, and they come from
  `Field` / `FieldShell` rather than hand-written `<label className="field">`.
  Three dialogs still wrote that markup themselves and had drifted to a
  different input width for it.

The estimate dialog and the expense dialog are both a money line, so they now
lay out on the same 12-column grid with the same fields in the same order:
description across the top, then amount / currency / who.

Two further rules fell out of the person dialogs, which arrived later and drifted
in exactly the ways the first three had not covered:

- **A hint under a field is a fragment, not a sentence**, so it takes no full
  stop: `At least 8 characters`. A hint that needs two sentences is a hint that
  is saying too much, and it never says `Optional` either, because the label
  already carries that in the muted suffix described above. The only hints left
  in the app are the three password rules; the person dialogs had one on the
  email field explaining what the address was for, and it went, because a field
  labelled `Email (optional)` under a dialog titled `Add person` has already
  said everything the organizer has to decide.
- **`required` carries an empty field; the submit button is not disabled for
  it.** A greyed-out button states no reason, and the user is left comparing
  fields to guess which one it is waiting on. Pressing it and being told what is
  missing is both louder and more specific. `EditExpense` was the last holdout,
  disabling on its own copy of every rule the route already enforces, including
  the cross-field one; the route says `Amounts add up to 40.00, but the total is
50.00.`, which names both numbers, so the disabled button was hiding the better
  message. The only `disabled` left on a dialog footer is `AddCityDialog`, where
  the control is a search result rather than a field and there is no request to
  make until one is picked.

The hint rules are asserted against `packages/copy` itself in
`tests-e2e/ui-consistency.spec.ts`, walking every string rather than the handful
of dialogs a spec happens to open, so the next dialog is held to them without
anyone having to remember they exist.

#### One voice for a rejected dialog

Every dialog body is a `ModalForm`, and `ModalForm` exists for one attribute:
`noValidate`. Ten of the eleven dialog forms had left native validation on, so
pressing the primary button with a required field empty produced the browser's
own bubble: the OS voice (_Please fill out this field._), OS styling, anchored
to the input, gone again on its own. The eleventh, the trip dialog, had switched
it off on purpose and let the server answer, so its refusal arrived in the
footer in the app's voice (`Pick a start date.`). One kind of mistake was being
reported two entirely different ways depending on which dialog you were in.

Every route already validates what it writes and words the refusal to the rules
below, so turning the browser off everywhere costs a round trip and buys one
voice, in one place, saying the same kind of sentence. The inputs keep their
`required`, which is what assistive technology reads; `noValidate` suppresses
only the browser's own UI. Making it a component rather than a prop on each form
is the point: the next dialog cannot forget.

The two calendar dialogs are the deliberate exception. They still write their
own `<form>` and still pop native bubbles, because the schedule view is due a
redesign and nothing there is worth converting twice.

#### Every validation message says the same kind of thing

The 4xx messages had drifted into four competing voices: imperatives
(`Add a description.`), imperatives with the noun invented rather than taken
from the label (`Describe the task.` for a field labelled _Name_), bare fragments
(`Unknown city`, `Track not found.`) and diagnostic guesses
(`Check the city and the name.`). Six rules now hold:

- **One sentence, ending in a full stop.** No fragments, no two-sentence
  messages except where the second sentence is genuinely actionable
  (`Try again.` after a network failure, `You can leave it instead.` after a
  permission refusal that has an alternative).
- **The verb matches the control.** A text field the user types into gets
  `Enter a <label>.`; a select or a date picker gets `Pick a <label>.` This is
  the rule that removes the most decisions, because the writer never has to
  invent a verb.
- **The noun is the field's printed label, lower-cased.** The task dialog's
  field says _Name_, so its error is `Enter a name.`, not `Describe the task.`
  A message naming something the user cannot see on screen sends them looking
  for a field that isn't there.
- **A malformed value takes `valid`**: `Enter a valid email address.`,
  `Pick valid dates.` A rule spanning two fields states the rule instead:
  `Check-out must be after check-in.`
- **Nothing the user can fix by typing takes the declarative**
  `Could not <verb> that <thing>.` Server-side failures, conflicts and
  not-founds all live in this family, which is why `Track not found.` became
  `Could not find that track.`
- **No diagnostic hints.** `Check the city and the name.` guesses at a cause the
  server already knows it cannot name, and reads as an accusation when the
  input was fine and the provider was down.

Two consequences worth recording:

**The invite message was un-merged.** It read `Enter a valid email address.
Only the organizer can invite.`, with a comment claiming the merge stopped a
prober from telling a bad address apart from a permission refusal. It protected
nothing: `People.tsx` only renders the add button when `data.organizer`, and
the roster tags the organizer publicly, so anyone could already tell. What it
did do was tell the organizer their own correct address was malformed.
`addPerson` returns a distinct `'forbidden'`, which the route answers
with 403 and its own sentence.

**A missing cost description is now checked in the route.** It previously fell
through to the persistence layer and surfaced as `Could not add that item.`, a
declarative for something the user could fix by typing one word.

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
an optional badge counting what is _outstanding_ (unfinished tasks, people not
square) or simply how many are there (places, stays). It collapses to a
horizontal scroller under 860px. The page wraps it in a `.layout` grid
(`190px minmax(0, 1fr)`) with a `.panel` column, and renders modals _outside_
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

- _Horizontal._ The Svelte `app.css` reserved the scrollbar gutter on `html`
  with `scrollbar-gutter: stable` and an `overflow-y: scroll` fallback, to stop a
  page-height change from removing the scrollbar and sliding the centred layout
  sideways by ~15px. The React port reverses that decision: reserving the gutter
  left the full-bleed sticky header a scrollbar-width short of the right edge,
  which matters more than the recentre, so the reservation is gone. See "The
  header reaches the right edge".
- _Vertical._ A section header (`.phead`) is a one-line hint plus an optional
  action button. Sections without a button would be ~12px shorter and the panel
  below would jump, so `.phead` sets `min-height: var(--phead-h)`, a token in
  `:root` matching `.btn`'s height. Keep summary blocks and stat rows _out_ of
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
keeps the gutter reserved, so a fixed constant would _create_ a jump in three of
those four cases. The lock is reference-counted so overlapping dialogs can't
unlock each other.

**Journeys are edited where they arrive, and the dialog replans them live.**
The server plans travel from the events themselves: a journey exists for every
pair of consecutive events a given set of people attends, which is why nobody
creates one and why they are edited inside the event dialog rather than in one
of their own. The consequence is that changing who is going is not a detail on
the side: it is the thing that makes journeys appear, merge and vanish. A
dialog that showed the journeys it loaded with would be stating last minute's
plan while the reader edits this one.

`planLegs` lives in `packages/core`, so `apps/web/src/pages/schedule/replan.ts`
runs exactly the planner the server runs, over the day's events with the draft
applied. The board and the dialog read the same replanned list, so ticking a
name redraws both. The board payload carries `incoming` (last night's stay) for
this reason alone: without it the client drops the first journey of every
morning, because the thing it leaves is not on the day being drawn.

**Journey edits are keyed by leg key, not by row id.** A journey the reader
sets up may have no row yet: the row only exists once the server replans off
the people just saved. `leg_key` (`from>to>sortedPeople`) is computed the same
way on both sides, so the dialog holds edits under the key, and the save reads
the day back afterwards and matches. That also reorders the save: the event and
its people go first, then the journeys, which is the reverse of the old order.
The old order existed to write journeys "while the ids still mean what the
reader saw"; keys do that job now, and they do it for journeys that did not
exist when the dialog opened.

Only touched journeys are written. A journey is automatic by default, and
sending every one back would pin a whole day's travel as the price of renaming
one event.

**Journeys from the same place merge into one card.** Six groups converging on
a lunch is six cards, but several of them commonly leave the same building, and
setting the same twenty minutes six times is work the reader should not be
doing. Journeys are grouped by origin coordinates rounded to five decimals
(about a metre); a group whose journeys already agree reads as a single card,
and editing it writes through to every journey under it. Split and Merge are
links on the card's meta line, and both are dialog-session state: nothing about
the plan changes, so there is nothing to store. Merge copies the card's values
across the group, because merging is an answer about the group and not just a
change of layout.

**`.sched .grid` was colliding with Tailwind.** The board's clock gutter was
`padding-left: 56px` on `.sched .grid`. Dialogs render inside `.sched`, so every
twelve-column dialog form, which uses Tailwind's own `grid` utility, inherited
that indent and stood 56px off its own labels. Renamed to `.daygrid`. Worth
remembering as a shape: a plain utility name under a page-scoped ancestor will
eventually be claimed by the framework.

**The board's window is a floor, not a wall.** It ran a fixed 6:00 to midnight,
and anything outside was clamped onto the edge: an escape room booked at 4:55
was drawn at 6:00, reading as a block that starts two hours after it does. Full
24 hours on every day was the other extreme, spending a third of the column on
track nobody schedules and making two days harder to compare, not easier.
`windowStart` decides it per day instead, from the minutes the day actually
holds: six in the morning unless something is earlier, in which case the window
opens back to the hour that holds it.

The window that moves while you are moving something has to move _exactly_
right. The first attempt grew it towards the pointer in whole-hour steps and
compensated with a `window.scrollBy`: an hour is 60px at a pixel a minute, so
the board lurched 60px sideways of the hand, and the compensation lurched with
it. Clamping the drag to the window instead killed the lurch and took the
feature with it, since a block could then only be dragged to hours the board was
already showing.

What was wrong was the granularity, not the idea. `boardStart` is now driven
straight off the dragged block, to the minute, so the window opens at exactly
the speed of the hand and never steps. The grid grows downwards from a top edge
that stays put, so opening it by _n_ pixels pushes everything already on the
board, including the block under the pointer, down by _n_. `Schedule` scrolls by
the same _n_ in the `useLayoutEffect` of the same render, before the browser
paints, and the two cancel: the block is welded to the cursor, the hours simply
appear above it. There is always somewhere to scroll to, because the document
grew by precisely the distance being scrolled. Dragging back down closes the
window again on the way, symmetrically, so a gesture cannot leave the board
further open than the time it settled on. Measured drift over a 360px drag that
opened the window three hours: zero pixels.

Dragging alone runs out at the top of the screen, and on a page already scrolled
down it runs out early, so a pointer held within `EDGE_PX` of the top carries on
opening under its own power at a rate set by how far past that line it is: a
crawl at the threshold, about two hours a second at the very top. It stops dead
when the pointer leaves the zone, which is what makes it possible to stop on a
minute.

The compensation is only for gestures. A board opening for a time typed into a
dialog is not being held onto by anyone, and that one is better read as the
board opening than hidden by sliding the page under it, so it gets no scroll and
keeps its transition: `.daygrid`'s height and `.hourline`'s top share
`--sched-settle` with the blocks, so a settle reads as the board opening rather
than as an axis jumping out from under its own events. The two mechanisms must
not overlap, and `.still` is what keeps them apart: while a pointer owns the
window the transitions come off, because an animation chasing a per-frame target
is a board trailing its own cursor.

**The place field takes the event's noun, and the menu counts votes.** "Location"
said nothing the reader did not know; "Activity", "Food" and "Stay" say which
list is about to open, and a journey gets "Ends at" because its place is where
it puts you rather than where it is. The menu is sectioned by city with the
current one first, and each place carries its vote count as a hint: the group
has already said what it wants, and the picker is where that is worth knowing.

**Ticks go before the label.** `Select` drew its tick after the option, pushed
right, which left the labels aligned but the ticks wandering with the text.
`MultiSelect` already drew its box first. `Select` now matches, with the tick as
a fixed 16px slot so every label starts on the same edge.

**Both schedule dialogs dock, and both preview.** Adding an event covered the
page while editing one stood at the edge with the board drawn behind it. Same
question, same board, two different-feeling answers, which reads as a bug
rather than as a distinction. `EventDraft` now carries `day` and coordinates as
well, so a draft whose id is not on the day is a block being added and is
inserted into it rather than overwriting anything; `applyDraft` in `replan.ts`
is the one place that decides which. The add dialog reports its draft under the
id `draft` and is docked and peeked by the same props the edit dialog gets.

Coordinates on the draft also mean picking a place moves the block, the map pin
and the day's journeys while the picker is still open, which they did not
before: the preview used to keep the saved location whatever the reader chose.

**A stay is a range of nights, not a block on a clock.** It was an ordinary
event sitting from 21:00 to midnight on one day, which meant a three-night
booking was three separate events to enter and three to correct. It now carries
`end_day` on `events` and covers `[day, end_day)`: arrival inclusive, checkout
morning exclusive as a _night_, the same reading
`lodging_options.check_in/check_out` has always had. One object, one write.
`end_day` is on every event rather than on a
stay table of its own, and NULL means "begins and ends on its own day", which is
true of everything else.

**Stays are bands again, and this time several can share a night.** The board
used to derive a lodging band from the votes in Discover, which could only ever
name one hotel for the whole group; that is why stays were turned into blocks in
the first place. A stay is now an event with people on it, so a night holds as
many lodgings as the group splits into, each naming who is in it, and the
vote-derived band and `lodgingForDay` are gone. Clicking any band opens the
ordinary event dialog, on any day the stay covers: the thing being edited is the
stay, not the night, so editing it from its third morning is the same edit.

**The planner takes several origins.** `planLegs` used to be given one incoming
event; it now takes a list and each person leaves from whichever origin they are
on. That is what lets two halves of a group wake up in different buildings and
get two different journeys to the same breakfast.

**A stay is a destination with no hour, so the walk home is anchored to its
departure.** Every other journey is anchored to its arrival, because the fixed
point is the thing you are trying not to be late for. Tonight's lodging has no
such point: it is a date, and nobody can be late to their own bed. It first
entered the plan re-anchored to `STAY_CHECK_IN`, which put the walk home at
20:47 on a day that finished at 18:05, as though the group stood outside waiting
for the hotel to open. The stay now enters at midnight, mirroring the morning
where last night's stay is an origin at midnight for the same reason, and
`PlannedLeg.openEnded` carries the fact through to `placeLeg`: you leave when
the day finishes, you arrive when you arrive, and the leg is never tight because
there is no gap to overrun. Both ends anchor it identically, since `planFor` and
`replanLegs` pass the same minutes into the same core function.

**A write touches a span, not a day.** `touched` now takes any number of days
and recomputes every day from the earliest to one past the latest. A ranged stay
changes many days' travel at once, and moving one has to cover where it was as
well as where it is now, or the morning it used to feed keeps a journey out of a
hotel nobody is in.

**Nights and days are different questions, so there are two answers.** A stay is
slept in over `[day, end_day)`, but it is _had_ over `[day, end_day]`: you are
still in the room on the morning you leave, and that morning is where the day's
first journey starts. Ending the band the evening before left the departure day
looking like nobody had anywhere to sleep, on one of the days most likely to be
read. `staysCovering` therefore answers for the nights, which is what the
planner books journeys against, and `staysOnBoard` answers for the days, which
is what is drawn. Keeping them apart is what stops a journey being planned back
to a room that has already been vacated.

**A checkout and a check-in on the same morning are one chip when the room does
not change.** Once the band runs to checkout, a stay booked night by night draws
twice on every day in between: the night ending and the night beginning, the
same room named twice. `staysOnBoard` drops the checkout when the same people
are booked back into the same place that night, and keeps both when they are
not, because changing hotel that morning is exactly the thing the band should
say out loud.

**Both stay paths refuse a non-positive night count.** A stay covers at least
one night: a checkout on or before the check-in day is a stay of zero or
negative nights, which is not a thing a traveller can mean. Two paths set a
stay's dates, and they used to disagree. The schedule stay path (`stayEnd` in
`schedule.ts`) has always coerced a missing or backwards range up to one night,
so it never stored a non-positive stay. The lodging path (`setDates` in
`lodging.ts`, behind `PATCH /stays/:optionId/dates`, and the add / edit stay
routes) validated the range only at the route, and only with a strict "checkout
before check-in", so it let an equal pair (zero nights) through and did nothing
at all when `setDates` was called directly. That meant the same trip could hold
a stay one path would have rejected. Both paths now enforce the same rule:
`setDates` refuses `check_in >= check_out` at the persistence layer, and the
three discover stay routes refuse it at the edge with the existing
`Check-out must be after check-in.` ("after" is strict, so an equal pair is
refused too). The guard bites only when both ends are set; a half-filled range
is undated, not invalid.

**The schedule's header is two zones, not one.** It had grown into a single row
carrying trip-level controls and the day stepper together, which meant the thing
that changes the whole page and the thing that steps one board sat side by side
looking equally important, and on a narrow screen they wrapped into each other.
The page toolbar now holds only what applies to the trip: `Day | Agenda` on the
left, `View as` and `+ Add` on the right, which is the same filter-left,
action-right shape Discover uses. The day stepper moved inside the board as its
own centered title bar with a rule under it, because the day is what the board
_is_, not a setting applied to it. The `Day | Agenda` switch had also been
clipping rather than wrapping: `.pills` sets `overflow: hidden` to clip its own
rounded corners, and per spec that makes its automatic minimum size resolve to
zero, so it was free to shrink to nothing. A breakpoint was never the fix.

**The brand mark is a tree of choices, not a glyph.** The header used to sit a
Unicode `◍` next to the wordmark and the tab still shipped the SvelteKit logo
in Svelte orange, both leftovers from the port. A text glyph is drawn by
whichever font the platform has and is not really a mark at all, so it is
replaced by a drawn one: a dendrogram laid out horizontally, growing left to
right. One root on the left forks into an upper and a lower branch, and the
upper branch forks again, so a single origin fans out to three terminals at
three heights. That picture is chosen over a pin or a map because it names the
one thing the app does that a generic map app does not: a trip plan is a tree of
choices, and a group that splits can split again.

An earlier pass tried the split as two mirrored arcs bowing above and below a
line, and that is the note worth keeping so nobody re-derives it: two mirrored
arcs always close into a lens, and a lens flanked by dots is unmistakably an
eye, at any size. The tree escapes that because it is inherently asymmetric and
cannot collapse into a symmetric glyph.

Orthogonal elbows, not curves, and that is a 16px decision rather than a
stylistic one. Straight horizontal and vertical runs land on the pixel grid at
tab size, where diagonals and arcs antialias into grey mush, which is exactly
what sank the earlier curved attempts. Orthogonal branching is also the
universal language for a tree, seen in file explorers, org charts and git
graphs, so it reads as branching at once. A filled node marks every meaningful
point: the two forks, the three terminals and the root. A node is where a path
arrives or divides, the decision points of the plan, so marking them all says
that every stop is a choice, and centred on a fork it has the riser and both
horizontals meet inside it, so the corner reads as deliberate rather than as an
antialiasing artefact. A node has to be clearly bigger than the stroke or it
reads as a pinch in the line rather than a node, but too big and the discs
dominate and the branching reads second. Two and three quarter times the stroke
was tried and read too heavy, the discs coming before the lines; dropping the
disc to just over twice the stroke while the stroke stayed at four read too heavy
again. Shrinking the discs further only threatened to lose the nodes into the
round joins, so the fix was the other lever: lighten the whole mark by thinning
the stroke rather than starving the discs. The header and the PNGs now draw the
tree on a stroke of three with discs a shade over twice that, so the branching
leads and the nodes are punctuation on it. The 16px favicon does not follow the
stroke down. It keeps the heavier stroke of four with its two junction discs
larger still, because at tab size a stroke of three drops below a pixel and
washes out to grey and a small disc merges back into it, which is the failure the
divergence exists to avoid. The favicon is a size-adapted variant already, two
junction nodes rather than six, so carrying a heavier stroke as well is the same
decision taken one step further: at 16px legibility wins over matching the
header's exact weight, and the two are never seen side by side at one size. Rings, a knockout disc with an
accent centre, were tried and dropped: the accent centre fills in below about
32px and the ring
reverts to a plain disc, so it bought nothing at the sizes that are hard and only
added noise at the sizes that are easy. The tree's footprint is pulled in from
the tile edges too, and the branch heights spread to sixteen grid units apart, so
the three now sizable terminal discs neither collide with each other nor crowd
the rounded corners a platform will clip.

Six nodes only survive when the mark is drawn large, and that forces one split.
Below a pixel the terminal and root discs turn to mud, so the 16px `favicon.svg`
drops to the two junction nodes alone; rendered at true 16px, the extra four discs
were invisible and only thickened the lines. That is a deliberate size-specific
simplification of one tree, not a second mark: same geometry, same colours, same
badge, same stroke, just fewer discs at the size where legibility is scarcest.
The full six-node set lives where there is room for it: the header badge and the
app-icon PNGs, which always render large. An earlier pass put the nodes only at
the junctions and dropped the terminals for the same small-size reason, before
the owner asked for every point marked; the favicon is where that earlier
instinct still holds. `favicon.svg` is the mark knocked out of a solid accent
tile in the off-white background colour, because a bare stroke on transparent
vanishes against a dark browser tab and the platforms clip and round a favicon
anyway, so it wants a solid field under it. The apple-touch and maskable PNGs
carry the full six-node tree; the maskable one scales the tree in a little so its
outermost discs stay inside the centre safe circle that some launchers crop to.

The header renders that same badge, not a bare glyph, and that is deliberate: the
mark in the tab and the mark in the header should be one object, so someone
glancing between them sees a single thing. `Logo.tsx` draws the accent rounded
square with the tree knocked out in the background colour by default, and takes a
`bare` prop that drops the tile and paints the tree in `currentColor`, the way
the row glyphs in `icons.tsx` work, for anywhere the two-colour badge does not
belong; both share the one set of path data rather than drawing the tree twice.
The badge sits a little taller than the wordmark cap height, since a filled tile
needs more room to breathe than the bare glyph it replaced. Making the whole
header bar green was considered and rejected: the bar is a translucent off-white
with a blur and a hairline that every page is designed against, and going solid
green would force a rethink of the nav links, the avatar pill, the accent "Start
planning" button and the focus rings, which is a redesign, not a logo change.

## Results go to a corner, the page keeps its validation

**The red and green blocks pushed into the page are now toasts.** A result the
app owes the user after an action ("Saved.", "Could not change your password.")
used to be a tinted block inserted above the form that caused it. Three things
were wrong with that. It moved the page under the reader's hands, so the button
they had just pressed jumped. On a scrolling page (Preparation ticking a box
near the bottom, Discover voting on a card) it appeared somewhere off screen, so
the refusal of a write was reported to nobody. And the one that had to survive
the save could not: saving a new email remounts the Account profile form by key,
which threw its own confirmation away before it could be read, and the page had
to hold the flag on the form's behalf to work around it. A toast lives above the
router, so the result outlives the page that raised it.

**What did not move.** Two kinds of message stayed exactly where they were.

- **A refused submit belongs to the form that was refused.** `ModalFooter` and
  `ConfirmDialog` print the server's refusal beside the button that failed, and
  `SettleRow` prints its own beside the row. These are read where the correction
  is made. "Pick a start date." in the corner while the empty date field sits
  unmarked in the middle of the screen is worse than the same sentence under the
  button, not better. These are a coloured line beside a control, not a tinted
  pill, which is the shape the ruling was about.
- **The confirmation pages are pages.** `AuthNotice` in Verify, Forgot, Register
  and Reset is the whole screen saying the flow now continues in the reader's
  inbox. There is nothing else on it to be transient over.

**A failed load became two things, not one.** The banner on a page whose GET
failed was doing two jobs: saying why, and leaving something on the screen. A
toast alone only does the first, and a corner popup floating over a blank page
explains itself and then takes the explanation away. So `LoadError` splits it.
The server's sentence goes to the corner, where it does not expire, and the page
keeps an `EmptyState` reading "Could not load this page." The panel deliberately
does not repeat the server's wording: the same sentence twice on one screen
reads as two separate failures. It uses `EmptyState` without its drawing, since
the fly is a joke about a list nobody has filled in and a joke over a server
failure is the wrong tone.

Two pages, Account and the trip list, can hold an error while still showing
content, because a reload that fails leaves the previous data in place. There
the failure is only a result, so `panel={false}` sends the reason to the corner
and leaves what is on screen alone.

`LoadError` announces once per distinct reason, guarded by a ref. A re-render is
not a second failure, and React's development mode mounts every component twice,
which without the guard put the same sentence in the corner two times over on
the live dev server.

**The auth card raises its own.** The log in, register, forgot and reset pages
each call `toast.error` in their own catch rather than handing a string to
`AuthShell`, and the shell no longer has an error slot. A prop holding one
message cannot report the same wrong password twice: the state does not change,
so nothing fires, and the second attempt would look like it was ignored.

The rule: a _result_ goes to the corner, a _refusal attached to a control_ stays
beside the control. `useMutation` supports both at once through `onError`, which
reports the resolved message without taking it out of `error`.

**Errors do not expire; successes do.** A success repeats something the user
just watched happen, so it costs nothing to lose after 4.5 seconds. An error is
the only account of why something did not happen, it frequently carries wording
the server chose, and it can arrive while a modal is open, where it cannot be
dismissed at all (see below). A timer there deletes the answer before the reader
can reach it. Errors leave on a click, or when a fifth toast pushes the oldest
out. The stack is capped rather than scrolled: a corner holds the last few things
that happened, and a column tall enough to scroll is covering the page it reports
on.

**The viewport is a popover, because dialogs are in the top layer.** Every
dialog in the app is a native `showModal()` dialog, which puts it in the top
layer, above any z-index a stylesheet can name (the app's ceiling is 40). A
toast raised by a dialog's own save would be painted behind it. The viewport
therefore carries `popover="manual"`, the other door into the top layer. The top
layer is ordered by entry, so a viewport promoted at startup still sits under a
dialog opened later: each new toast closes and reopens the popover, which moves
it back to the front, and a `MutationObserver` on the `open` attribute does the
same for toasts that were already up when a dialog opened. Watching for that
centrally beats asking each dialog to announce itself, because the dialog that
forgets is a message nobody sees. Measured in Chrome on the live app: promoted
before the dialog it is invisible, re-promoted after it, it paints on top.

**The stack pauses while it is under the pointer or the caret, and unsticks
itself.** Hovering or tabbing into the corner holds every clock, so a message
cannot expire mid-sentence while it is being read. That state is re-read after
each removal rather than trusted from the last event: dismissing a toast
destroys the element that had focus, an element removed while focused never
fires a blur, and a stack stuck paused would keep everything under it on screen
for good.

**A toast over an open modal can be read but not pressed.** `showModal()` makes
the rest of the document inert, and inertness reaches into the top layer, so the
dismiss button does not take the click while the dialog is up. That is the right
end of the trade rather than a defect to route around: focus belongs to the
dialog, a toast must never pull it out, and an error simply waits, still there
and now pressable, once the dialog closes. It also means the corner is a safe
home for a refusal raised from inside a dialog, which is what the API rejecting
an event with nobody on it will need.

**Politeness follows tone, as it already did inline.** A success is a
`role="status"` and waits its turn; an error is a `role="alert"` and interrupts.
The viewport is opened once and left open for the session rather than opened
with its first message, so messages are inserted into a container that is
already rendered instead of one that appears with them, which is the usual way
to have a live region announced by nobody. Empty, it paints nothing and takes no
clicks.

**The server's own sentence is the message.** `api()` already lifts `error` out
of the `fail()` envelope every route uses and throws it as `ApiError.message`,
`useMutation` passes that string to `onError` untouched, and `toast.error` shows
it. Nothing on the path adds a preamble or substitutes house copy, because the
route is the only thing that knows why it refused. The longest of these written
so far, the 400 for an event whose named people are none of them on the trip
("Nobody in that list is on this trip. Pick from the trip's members.", 66
characters), is the width fixture: measured in Chrome it wraps to two lines in a
384px toast at 1280px and a 366px one at 390px, clips nothing, and leaves the
dismiss button in its corner.

**The picker note stayed in the menu.** The refusal in `PeoplePicker` ("An event
with no names on it means everyone, so this cannot be emptied") was considered
for the corner and deliberately left where it is. It is not a result of an
action the app took; it is an answer to a tick, and the reader is looking at the
row they just ticked, inside a menu that is itself fixed above the dialog. The
corner would put the answer as far from the question as the screen allows. It
also fires while a modal is open, which is exactly where a toast cannot be
dismissed.

**The schedule's board writes toast; its load failure does not.** The day board
has one write path, `act`, and the gestures go through it: a drag that
lands, a resize that lands. It used to set a `notice` string drawn as a line
above the board, which is the wrong place twice over. The line was above the
fold only by luck, since the board is now a scroll box that fills the screen; and
a refusal usually arrives while the reader is looking at the block they just
moved, not at the top of the page. It is `toast.error` now, which also puts it in
the top layer, so a dialog opened afterwards cannot bury it. The load failure
that `useApi` reports is deliberately left inline: it is not the result of an
action, it is the whole of the page's content when it fires, and a corner popup
over a blank screen explains itself and then leaves nothing behind. The two
event dialogs keep showing their own save failures in their own footers, which
is beside the form that caused them and already above the board.

## The header reaches the right edge

The sticky header is full-bleed and its centred `.container` holds the content,
so the bar itself should touch both edges of the viewport. It did not: on a page
with no scrollbar it stopped a scrollbar-width short on the right and left a
visible strip. The cause was in `styles/index.css`, an intentional pair of rules
that reserved the scrollbar gutter permanently, `overflow-y: scroll` with a
`scrollbar-gutter: stable` upgrade, so the centred layout would not jump sideways
by the scrollbar width when navigating between a page taller than the viewport
and one shorter than it. Reserving the gutter narrows the root scroll area on the
inline-end side even when no scrollbar shows, and the header is a child of that
area, so it stopped short. Measured, the right gap was exactly the scrollbar
width and the left gap was zero. The reservation is removed: the header reaching
the edge wins over preventing a sub-scrollbar-width recentre, and that recentre
only ever showed on classic non-overlay scrollbars and only between a scrolling
and a non-scrolling page. The fix is confined to the gutter; the `overflow-x:
clip` that lets a transformed page clip its own transform during a navigation is
untouched, and there is still no horizontal scrollbar at 390px.

## Navigation motion

There are two gestures and, after a redesign, two mechanisms. A tab change pages
the whole section like a carousel: the outgoing page travels out one side while
the incoming page travels in behind it, the two moving together as adjacent
frames of one strip. A day step on the schedule moves only the calendar board in
place. They looked alike enough to share one hook once, but they answer different
questions (which way did the reader move along the tabs, versus which day is the
board drawing) and they now have different implementations. `usePageTransition`
owns the tab carousel; `useSlideIn` owns the board day step.

**The tab change is a carousel, because that is what "continuous, like a page"
means.** The earlier tab motion slid only the incoming panel in from the side and
let the old one vanish, so there was a beat with nothing behind the arriving
page. A reader described that as not seeing the page slide at all. A carousel has
no such beat: something is always on screen travelling, so the reader feels they
moved sideways along a filmstrip of tabs rather than that a panel was swapped.

**A View Transition, not two live React trees and not a cloned snapshot.** React
Router renders one route at a time, so showing both pages at once needs something
to hold the outgoing one while the incoming one mounts. Three ways were weighed.
Mounting the old route alongside the new inside a two-pane track gives the most
control but runs a second copy of a section's effects, its data fetch and its
slice of the trip's live event stream for the length of every move, and doubles
the focus and scroll bookkeeping. Cloning the outgoing pane into a travelling
image is cheaper but a clone taken mid-fetch captures whatever half-rendered
state was on screen. `document.startViewTransition` snapshots the old and new
panels into the browser's top layer and animates between them, which is exactly
this effect and costs neither a second live tree nor a hand-built clone. Because
the snapshots live in the top layer, their displacement never reaches the
document, so paging two page-widths of content sideways still grows no horizontal
scrollbar at a phone width, and the snapshots are gone the instant the move ends,
so nothing is left holding a transform at rest.

**The move is driven by hand rather than through React Router's own
`viewTransition` flag, because the arriving page needs holding.** A View
Transition captures the "new" snapshot the instant the DOM updates, and a section
renders nothing until its own fetch resolves (often a hundred milliseconds or
two, since `useApi` starts empty on every mount and there is no shared cache).
Captured at that instant the incoming pane would be snapshotted blank and slide
in empty, the same dead frame the old design had, only now on the incoming side.
So the update callback is `async`: it navigates with `flushSync`, scrolls the
incoming pane to its own top, and then waits for the panel to actually hold
something before returning. The browser keeps the outgoing snapshot frozen and on
screen for the whole of that wait, so when the two panels finally travel they are
both populated and the viewport is never empty. Router's built-in flag commits
the snapshot synchronously and gives no place to await readiness, which is why
the transition is started directly instead. This is the same readiness idea the
old incoming-only slide used, now spent on holding the outgoing page rather than
on delaying an empty one.

**Only the section below the chrome pages.** The pane is given a
`view-transition-name` of `trippage` for the length of the move only, and
everything else (the trip header, the tab strip, the background) is the
transition `root`, whose old and new snapshots are given `animation: none` so
they swap in place with no travel and no fade. The name is set inline when the
move starts and cleared when it finishes, so at rest the pane carries no
`view-transition-name` and establishes no stacking context, which matters because
a lingering one would make the pane the containing block for the fixed dropdowns
and dialogs anchored against the viewport and break their positioning.

**Direction comes from a rank the caller supplies, because only the caller knows
what forward means.** `usePageTransition` takes a `forward` flag, set from tab
order (`i > currentIndex`), and writes it to a `data-page-nav` attribute the
stylesheet reads to pick the keyframes: forward sends the old page out to the
left and brings the new one in from the right, back reverses both. The board day
step keeps its own rank on `dayRank(day) * 2 + viewIndex`, which puts a day step
and a Day/Agenda switch on one line and stops the two being confused.

**A full pane width, always one, on a symmetric curve.** The snapshots translate
by `100%` of their own width, so the outgoing and incoming panes are edge to edge
and the seam between them crosses the viewport as the strip slides; a fixed pixel
nudge (the 64px the board step still uses) reads as a panel twitching and
vanishing, not as one long strip moving past. The magnitude is one pane width
whatever the rank gap, so jumping from the first tab to the last slides one page
rather than flying through the tabs between; only the direction comes from the
rank. The curve matters as much as the distance here, and it is deliberately not
the board step's `cubic-bezier(0.22, 1, 0.36, 1)`. That easing front-loads so
hard that over a full pane width the incoming page is all but arrived by the
halfway point, leaving the second half of the move a near-still drift that the
eye reads as a snap, which is what "not carousel enough" meant. A symmetric
ease-in-out (`cubic-bezier(0.5, 0, 0.5, 1)`) spends the distance evenly, so at the
temporal midpoint the two panes are each genuinely half in view with their edges
meeting at the screen's centre, and the strip is seen to travel the whole time.
The duration rises to 420ms from the board step's 380ms because a full pane width
is a far longer trip than 64px and the extra time keeps the faster mid-move speed
from turning into a flick. The two snapshots share one duration and one curve and
the browser starts them on the same frame, so their eased progress is identical
at every instant and the seam stays exactly adjacent (old right edge at the new
left edge) throughout, with no gap and no overlap: they are locked without a
hand-built shared track.

**Nothing fades.** The panels are being moved, not replaced, so their snapshots
carry transform-only keyframes and the default cross-fade the browser would apply
is overridden. A panel that dimmed on the way in would say something had happened
to its contents rather than to the reader's place in a sequence.

**A stalled fetch is waited out, but only so far.** The readiness hold keeps the
old page frozen while the new one fills, which is right until a fetch never
resolves to anything at all: a section that renders no content and no error would
otherwise freeze navigation on the page just left. `READY_CEILING_MS = 2000`
caps the wait, after which the move plays regardless, which at worst is the rare
empty arrival the hold exists to avoid and never a wedged UI. A section that
errors renders its banner, which is content and ends the wait at once; the empty
state ("Nothing added yet") is content too, with real children, so a genuinely
empty section travels rather than being mistaken for one still loading.

**Rapid input during a move is absorbed, and the end state is always clean.**
While the snapshot overlay is on screen it sits in the top layer and a click
lands on it rather than on the live tab beneath, so tabs mashed faster than a
move completes are ignored until it ends rather than queued: a burst of clicks
lands on the first tab reached, not the last, but never on a half-played or
stale one. Every move clears its own name and direction only if it is still the
current one (`active.current`), so a change that does slip in during a move (a
keyboard activation, or a click at the seam) ends the running transition and
navigates straight there instead of stacking a second one, and the older move
finishing never strips the newer of its name. Browser Back and Forward change the
route without going through the hook, so they swap instantly with no carousel,
which is correct: the history buttons are not a step along the tab strip.

**The board day step still scripts a 64px slide of the board alone.**
`useSlideIn` is unchanged and still the schedule's, driven by `element.animate()`
rather than a React `key` (which would remount the board and flash a wrongly
sized grid until the ResizeObserver caught up) or a CSS class (which cannot
replay itself, so a second step the same way would be still). Left unfilled the
animation holds no transform afterwards, so the board never becomes a containing
block for fixed overlays. Stepping to the next day changes what the calendar
draws and nothing else, so the toolbar and the sticky map beside it stay put; the
`.slidein` panel that wraps the board is `overflow-x: clip` (not `hidden`, which
would make it a scroll container and steal the map's stickiness) so the board's
64px travel grows no scrollbar. The panel no longer travels in the document on a
tab change, so the gutter class that used to reserve room beside it was removed.

**The tab strip's underline travels with the page.** It is one bar positioned
against the scrolled tab row, sized in JS to whatever width the browser laid the
label out to, and it is given its own `view-transition-name` so the browser
carries it from the old tab to the new one over the same move as the page rather
than leaving it to jump. It lands without animating the first time and after a
resize, since neither is a tab change.

**Reduced motion is honoured on both paths.** `usePageTransition` checks the query
and skips the View Transition entirely, so the tab change becomes an instant swap
with no snapshot and no travel; `useSlideIn` checks it too and does nothing; and
an explicit reduced-motion block zeroes every `::view-transition-*` animation as a
backstop for anything that reaches one anyway, alongside the underline and pill
backgrounds, listing its selectors one by one so any newly animated selector has
to be added to it by hand.

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
- **Athens escape marathon** (`packages/server/src/seeds/seed-athens.ts`): **twenty** people,
  one city, four days. Escape rooms seat four, so twenty people means _five rooms running
  simultaneously_, which is precisely the case the layout engine exists for. Teams are
  reshuffled between slots (a one-person cyclic rotation on day 2, a full redraft on day 3)
  and the group repeatedly collapses back into one full-width block for meals. On day 2 the
  board goes 5 columns → 5 columns → 1 → 4 → 1 in a single day. Every one of the 46
  events carries an
  explicit attendee list, and three of them are nights at the locked lodging, which is what
  gives each morning's first journey somewhere to start from.

  `npx tsx scripts/seed-schedule.ts [tripId]` re-seeds just the schedule into a trip that
  already exists, and is idempotent. It is separate from `seedAthensTrip` because the move
  from tracks to events dropped every scheduled block in the database: the demo trip kept its
  people, POIs, votes and expenses and lost only its board, so rebuilding the whole trip would
  have cost far more than it restored. Attendees are matched to the sample's roster slots by
  name, and a trip whose roster has drifted fills the rest from whoever is spare.

- Trips are real and per-user: list and create from the database, guarded by auth.
- Minimal-transaction settlement runs from `$lib/settlement.ts`.
- The schedule is persisted as **events** (`events`, `event_people`) with derived
  `travel_legs`. The organizer can drag a block to reschedule (5-minute snap, duration
  preserved, clamped to the day). Moves go through a JSON endpoint with membership
  checks and persist across reloads. Changing who is on an event re-plans that day's
  travel.
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
  bar is _overlaid_ on the input's lower edge, so the header row is exactly as tall on
  Places as on Stays and starting a search adds no height.

  Results render as an **anchored dropdown**, not an in-flow list; they are a
  transient overlay, so finding a place must not push the pool of places you already
  have down the page. It opens **on focus**, not only once results exist: "add
  manually" is the answer to "the provider doesn't have my place", and you often know
  that before typing a character, so the footer is reachable from an empty field. With
  the field empty the footer is the _only_ content: a line telling you to search the
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
  Parises. Coordinates are deliberately _not_ the test: they come from whichever
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

- **What a place _is_ comes from the place, not from the tab it was found under.**
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
  resolves the _text_ it is given, so `museum Nashville United States` returns
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

  Two holes the stored cache did not close, both since fixed. A cold grid mounts a
  dozen images at once, so every one of them missed simultaneously and each paid its
  own Google call: the endpoint now keys fetches in flight by the same `name|width`
  and lets a burst share one promise, measured at ten concurrent requests and one
  upstream call. And a reference that fails is not cached at all, so a revoked photo
  or a place whose photo ids changed was re-bought on every page load forever;
  failures are now remembered for five minutes, measured at 234ms for the first ask
  and 2ms for the second. Five minutes rather than longer because the other cause of
  a failure is a transient upstream error, and that must not turn into a permanently
  broken picture.

  The search debounce went from 350ms to 600ms in the same pass. At 350ms a normal
  typist pays for two or three prefixes of the word they are still writing. The
  three-character minimum was already enforced on the server, where it is a cost guard
  rather than a UX choice.

  header search box and the same dropdown, with `kind=stay` restricting Google to
  `includedType: 'lodging'`, verified to cover hotels, hostels, resorts and the
  apartment listings people actually book, and to return _nothing_ for a landmark
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
  _part_ of the card rather than the whole `<article>`: Vote, Open and Remove live in
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
- Schedule editing (`/trips/[tripId]/schedule`, `schedule.ts` `resizeEvent` / `editEvent`):
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
- Travel-before buffers: superseded. A per-event lead time was a second, hand-kept copy
  of a fact the travel planner now derives, and the two could disagree. Legs are
  computed from who is going where (M3.1) and anchored to their arrival (4.2).
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
- Schedule views: a Day / People switcher with previous/next day navigation.
  Day keeps the full interactive board plus the map; People transposes it into
  one row per person. Week, Agenda and 3-day were all dropped in turn: Week was
  3-day with more squeezing, Agenda was a read-only restatement of Day that
  nobody opened, and 3-day cost a second clamp, a second layout and a third of
  the width for one arrow press.
- Crews (`crews`, `crew_members`): a saved selection of people, offered in the people
  picker. The tracks/parties model they replaced (`parties`, `party_membership`,
  `party_day`, `tracks.party_id`, time-segmented membership, crew-per-day cities, the
  split/rejoin flow and the auto travel bridge) is **gone**; see M3.1 for why an
  event's own people made all of it unnecessary.

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

GET    /api/trips/:tripId/schedule?day=&view=          board for the visible days
POST   /api/trips/:tripId/schedule/events
PUT    /api/trips/:tripId/schedule/events/:eventId/people
POST   /api/trips/:tripId/schedule/events/:eventId/op  move|resize|edit|cycle|delete
PATCH  /api/trips/:tripId/schedule/legs/:legId         mode/mins override, or reset
POST   /api/trips/:tripId/schedule/crews
PATCH  /api/trips/:tripId/schedule/crews/:crewId
DELETE /api/trips/:tripId/schedule/crews/:crewId

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
resource.** `GET /schedule` returns the whole board: the visible days, their
events with people, the placed travel legs, the crews and the maps key. That is
one round trip instead of six. The cost is that it is shaped for a screen rather
than for reuse, which is the right trade while there is exactly one consumer.

**`GET /schedule` computes travel on the way out**, which is the one read in the
app that talks to a provider. See 4.2 for why routing sits here and not in
persistence.

**One `/op` endpoint for the four event mutations** (move, resize, edit, delete)
rather than four REST verbs. The board fires all of them from one drag handler
and the ownership check is identical, so splitting them would spread that check
across four places for nothing.

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

**Known gaps, inherited rather than introduced.** `getBudget` / `setBudget`,
`toggleSave` and `linkedItemCount` exist in `packages/server` but no UI ever
called them. They are deliberately not exposed: the API mirrors the app that
exists.

---

## 6. Data Model (Drizzle-style sketch)

```ts
users(id, email, passwordHash, displayName, homeTz, createdAt)
trips(id, organizerId, name, startDate, endDate, homeCurrency)
memberships(userId, tripId, role)                 // organizer | member
locations(id, tripId, name, tz, lat, lng)
pois(id, tripId, locationId, name, category, lat, lng,
     openHours jsonb, priceLevel, url, source, addedBy)
events(id, tripId, day, title, type, startMin, endMin,
     poiId, lodgingId, cityId, lat, lng, notes, travelMode, createdAt)
event_people(eventId, userId)
travel_legs(id, tripId, day, legKey, fromEventId, toEventId, people,
     autoMode, autoMins, mode, mins)         // unique (tripId, day, legKey)
crews(id, tripId, name, color, sort)
crew_members(crewId, userId)
lodgings(id, locationId, name, pricePerNight, currency, url, lat, lng)
votes(id, tripId, targetType, targetId, userId, rank)   // targetType: poi|lodging
expenses(id, tripId, payerId, amount, currency, description, splitRule, createdAt)
expense_splits(expenseId, userId, share)                // shares/exact/percent
```

A day is a local date string, and a time is minutes from its midnight, rather
than a UTC instant. The board is a grid of local days, so storing an instant
would mean converting on every read and back on every drag, and a block would
move when a city's zone was corrected. The zone lives on the city and is applied
when rendering (4.1, 7.3).

`people` on a leg is the denormalised, sorted member list, because it is half of
the leg key and re-deriving it on read would let the two disagree.

Enums: `role`, `event_type` (see 2.2),
`travel_mode (walk|cycle|transit|drive|ferry|flight)`.

**Booking status is gone.** Events once carried `booked | tentative | unbooked`,
cycled by clicking the pill on a block. It was removed as an interaction nobody
wanted: the pill was the only thing that ever wrote the column, so the status
was a state you could set and then do nothing with. Nothing derived from it, no
view filtered on it, and it competed with the clock for the one line of space a
narrow block has. The `booking` column stays in `db.ts` unread, because
migrations here are additive and dropping a column rewrites the table for
nothing.

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

A leg is placed by its **arrival**: `start = B.start - mins`. If that lands
before `A.end`, the journey does not fit, and the leg is returned `tight` and
drawn filling the gap rather than shrunk to it (4.2, `placeLeg`). Shrinking it
would make an impossible day look fine.

### 7.3 Time-zone rendering

Persist a local `day` + `startMin` and take the zone from the event's city.
Display = `DateTime.fromISO(day, { zone: city.tz }).plus({ minutes: startMin })`.
Optional viewer overlay = `.setZone(user.homeTz)`.

---

## 8. Delivery Phasing

- **MVP (Phase 1)**: accounts, trips + locations, POI discovery pool, a schedule
  board with map + travel ETA.
- **Phase 2**: events carrying people (so a split needs no authoring), lodging
  voting, cost rollup, full time-zone rendering.
- **Phase 3**: Splitwise settlement, pre-trip checklist, realtime multi-editor,
  cross-trip references.

---

## 9. Open Questions

- Places/Directions provider choice (Google vs Mapbox vs OSM); affects cost & ToS.
- Self-host vs managed backend (Supabase) for realtime + auth.
- Offline/mobile support scope for on-trip use.
- Notifications channel (email vs push) for pre-trip reminders.
