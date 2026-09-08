<script lang="ts">
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Select from '$lib/components/Select.svelte';
	import SectionNav, { type SectionItem } from '$lib/components/SectionNav.svelte';
	import { focusOnMount } from '$lib/focus';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let active = $state(data.cities[0]?.id ?? '');
	let tab = $state('places');
	let showAddStay = $state(false);
	let showManual = $state(false);
	let editDatesFor = $state<string | null>(null);
	/** The place queued for deletion, held while the confirmation modal is open. */
	let confirmDelete = $state<{ id: string; name: string; linked: number } | null>(null);
	/** The place being edited, held while the edit modal is open. */
	let editPoi = $state<(typeof data.cities)[number]['pois'][number] | null>(null);

	const current = $derived(data.cities.find((c) => c.id === active) ?? data.cities[0]);
	const stays = $derived(current ? (data.stays[current.id] ?? []) : []);
	const staysVoted = $derived(current ? (data.staysVoted[current.id] ?? 0) : 0);

	const sections: SectionItem[] = $derived([
		{ id: 'places', label: 'Places', badge: current?.pois.length ?? 0 },
		{ id: 'stays', label: 'Stays', badge: stays.length }
	]);

	/** The city pill counts whatever section you're in, so it never reads as a
	    places count while you're comparing stays. */
	function cityCount(c: (typeof data.cities)[number]): number {
		return tab === 'places' ? c.pois.length : (data.stays[c.id] ?? []).length;
	}

	type Hit = {
		id: string | null;
		name: string;
		category: string;
		address: string | null;
		url: string | null;
		lat: number | null;
		lng: number | null;
		rating: number | null;
		ratingCount: number | null;
		priceLevel: number | null;
		hours: string[] | null;
		photo: string | null;
		source: 'google' | 'osm';
	};

	function priceStr(level: number | null | undefined): string {
		return level == null ? '' : '$'.repeat(Math.max(1, level));
	}
	function todayHours(hours: string[] | null | undefined): string | null {
		if (!hours || hours.length === 0) return null;
		// Google lists Monday-first; JS getDay() is Sunday=0.
		const idx = (new Date().getDay() + 6) % 7;
		const line = hours[idx] ?? hours[0];
		// Drop the leading weekday name for a compact chip.
		return line.replace(/^[A-Za-z]+:\s*/, '');
	}
	function parseHours(raw: string | null): string[] | null {
		if (!raw) return null;
		try {
			const v = JSON.parse(raw);
			return Array.isArray(v) ? v : null;
		} catch {
			return null;
		}
	}

	function money(cents: number | null): string {
		if (cents === null) return 'Price TBD';
		// Non-breaking spaces so the price and its unit wrap as one chunk rather
		// than leaving "night" stranded on its own line in a narrow card.
		return (
			new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency }).format(
				cents / 100
			) + '\u00a0/\u00a0night'
		);
	}

	function nightsLabel(inD: string | null, outD: string | null): string | null {
		if (!inD || !outD) return null;
		const ms = Date.parse(`${outD}T00:00:00Z`) - Date.parse(`${inD}T00:00:00Z`);
		if (!Number.isFinite(ms) || ms <= 0) return null;
		const n = Math.round(ms / 86400000);
		return `${inD.slice(5)} → ${outD.slice(5)} · ${n} night${n === 1 ? '' : 's'}`;
	}

	/** Share of the group behind an option, for the vote bar. */
	function pct(votes: number): number {
		return data.memberCount ? Math.round((votes / data.memberCount) * 100) : 0;
	}

	let query = $state('');
	let hits = $state<Hit[]>([]);
	let searching = $state(false);
	let searched = $state(false);
	/** How many times each result has been added this search: one place can be
	    added repeatedly, once per activity, so a tick alone would understate it. */
	let added = $state<Map<string, number>>(new Map());
	/** The search result whose add-detail popup is open. */
	let detailHit = $state<Hit | null>(null);
	/** The lodging result being added as a stay. */
	let stayHit = $state<Hit | null>(null);
	/** True while the clicked result's ratings/hours/photo are being fetched. */
	let detailLoading = $state(false);
	/** Error from the last add attempt, shown inside the popup that caused it. */
	let addError = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Lets a new search cancel the one before it. */
	let inflight: AbortController | undefined;

	const providerLabel = $derived(data.provider === 'google' ? 'Google Maps' : 'OpenStreetMap');

	/** Shortest query worth a billed request; mirrors MIN_QUERY on the server. */
	const MIN_QUERY = 3;

	function runSearch() {
		const q = query.trim();
		if (q.length < MIN_QUERY || !current) {
			hits = [];
			searched = false;
			searching = false;
			return;
		}
		// Without this a slow early request can land after a later one and replace
		// good results with stale ones: "acr" overwriting "acropolis".
		inflight?.abort();
		const ctl = new AbortController();
		inflight = ctl;
		searching = true;
		const params = new URLSearchParams({ q, cityId: current.id, kind: searchKind });
		fetch(`./discover/search?${params}`, { signal: ctl.signal })
			.then((r) => (r.ok ? r.json() : { results: [] }))
			.then((d: { results: Hit[] }) => {
				hits = d.results ?? [];
				searched = true;
			})
			.catch(() => {
				if (ctl.signal.aborted) return;
				hits = [];
				searched = true;
			})
			.finally(() => {
				if (inflight === ctl) {
					inflight = undefined;
					searching = false;
				}
			});
	}

	function onInput() {
		clearTimeout(timer);
		added = new Map();
		// Show the progress bar from the first keystroke that will actually search,
		// not just once the request is in flight; otherwise it only appears after
		// the 350ms debounce.
		searching = query.trim().length >= MIN_QUERY;
		timer = setTimeout(runSearch, 350);
		dismissed = false;
	}

	/**
	 * Opens the add popup and fetches the fields the search deliberately skipped.
	 * The result is merged back into the row too, so a place looked at once keeps
	 * its rating in the list.
	 */
	function openHit(h: Hit) {
		addError = null;
		if (searchKind === 'stay') stayHit = h;
		else detailHit = h;
		if (!h.id || h.rating !== null || h.photo) return;
		detailLoading = true;
		fetch(`./discover/details?id=${encodeURIComponent(h.id)}`)
			.then((r) => (r.ok ? r.json() : { details: null }))
			.then((d: { details: Partial<Hit> | null }) => {
				if (!d.details) return;
				const merged = { ...h, ...d.details };
				hits = hits.map((x) => (hitKey(x) === hitKey(h) ? merged : x));
				// Only if the popup is still showing this place; the user may have
				// closed it or clicked another result while the request was in flight.
				if (detailHit && hitKey(detailHit) === hitKey(h)) detailHit = merged;
				if (stayHit && hitKey(stayHit) === hitKey(h)) stayHit = merged;
			})
			.catch(() => {})
			.finally(() => (detailLoading = false));
	}

	function hitKey(h: Hit): string {
		return `${h.name}|${h.lat}|${h.lng}`;
	}

	/** Drops the results so the card grid comes back without reloading the page. */
	function clearSearch() {
		clearTimeout(timer);
		inflight?.abort();
		inflight = undefined;
		query = '';
		hits = [];
		added = new Map();
		searched = false;
		searching = false;
	}

	/** Results hang over the page as a dropdown, so they need the usual dismissal
	    affordances a popup has: click away, or press Escape. */
	let searchEl: HTMLElement | undefined = $state();
	let dismissed = $state(false);
	/** Whether the field has focus, so the manual escape hatch can be offered
	    before anything has been typed. */
	let searchFocused = $state(false);
	/**
	 * Open once the field is engaged, not only once there are results: "add
	 * manually" is the answer to "the place I want isn't findable", and you often
	 * know that before you type. An empty query shows the footer alone.
	 */
	const showResults = $derived((searched || searchFocused) && !dismissed);
	/** Stays and places are different searches; the results of one never apply to the other. */
	const searchKind = $derived<'place' | 'stay'>(tab === 'stays' ? 'stay' : 'place');
	/** A modal is a layer above the dropdown, not a click elsewhere on the page. */
	const modalOpen = $derived(
		!!detailHit || !!stayHit || showManual || showAddStay || !!editDatesFor
	);

	/** Switching section must not leave hotel results over the places pool. */
	$effect(() => {
		searchKind;
		clearSearch();
	});

	function onPointerDown(e: PointerEvent) {
		if (!showResults || !searchEl) return;
		// Clicking inside the add popup must not dismiss the results behind it;
		// otherwise adding one place closes the list, and adding the same place a
		// second time for a different activity means retyping the search.
		if (modalOpen) return;
		if (!searchEl.contains(e.target as Node)) dismissed = true;
	}
	function onKeydown(e: KeyboardEvent) {
		// Modals own Escape while one is open; a dialog handles it natively.
		if (e.key !== 'Escape' || modalOpen) return;
		if (showResults) dismissed = true;
	}
</script>

<svelte:window onpointerdown={onPointerDown} onkeydown={onKeydown} />

{#if form?.error}
	<p class="note error" role="alert">{form.error}</p>
{/if}

{#if data.cities.length === 0}
	<p class="muted">Add cities to this trip to start collecting places.</p>
{:else}
	{#if detailHit && current}
		{@const h = detailHit}
		<Modal open title={`Add ${h.name}`} size="md" onclose={() => (detailHit = null)}>
			<form
				method="POST"
				action="?/add"
				class="mform"
				use:enhance={() => {
					const k = hitKey(h);
					return async ({ result, update }) => {
						if (result.type === 'failure') {
							addError = String(
								(result.data as { error?: string } | undefined)?.error ?? 'Could not add that.'
							);
							return;
						}
						await update({ reset: false });
						added = new Map(added).set(k, (added.get(k) ?? 0) + 1);
						detailHit = null;
					};
				}}
			>
				<div class="mbody">
					{#if detailLoading}
						<!-- Holds the summary line's height so the fields below do not jump
						     down when the ratings arrive. -->
						<p class="hsum skel" aria-hidden="true"></p>
					{:else if h.rating || h.priceLevel != null || todayHours(h.hours)}
						<p class="hsum muted">
							{#if h.rating}
								<span class="rate"
									>★ {h.rating.toFixed(1)}{#if h.ratingCount}<span class="muted"
											>&nbsp;({h.ratingCount})</span
										>{/if}</span
								>
							{/if}
							{#if h.priceLevel != null}<span class="price">{priceStr(h.priceLevel)}</span>{/if}
							{#if todayHours(h.hours)}<span class="hrs">{todayHours(h.hours)}</span>{/if}
						</p>
					{/if}
					{#if h.address}<p class="hsumaddr muted">{h.address}</p>{/if}

					<input type="hidden" name="cityId" value={current.id} />
					<input type="hidden" name="name" value={h.name} />
					<input type="hidden" name="url" value={h.url ?? ''} />
					<input type="hidden" name="photo" value={h.photo ?? ''} />
					<input type="hidden" name="lat" value={h.lat ?? ''} />
					<input type="hidden" name="lng" value={h.lng ?? ''} />
					<input type="hidden" name="rating" value={h.rating ?? ''} />
					<input type="hidden" name="ratingCount" value={h.ratingCount ?? ''} />
					<input type="hidden" name="priceLevel" value={h.priceLevel ?? ''} />
					<input type="hidden" name="hours" value={h.hours ? JSON.stringify(h.hours) : ''} />
					<input type="hidden" name="category" value={h.category} />

					<div class="fields">
						{#if addError}
							<p class="ferr" role="alert">{addError}</p>
						{/if}
						<label>
							<span>Activity <span class="muted">(optional)</span></span>
							<input name="activity" use:focusOnMount />
						</label>
						<span class="fhint muted">
							Name the activity and it becomes the card title, so one place can appear once per
							thing you'll do there.
						</span>
						<label>
							<span>Notes <span class="muted">(optional)</span></span>
							<textarea name="notes" rows="3">{h.address ?? ''}</textarea>
						</label>
					</div>
				</div>
				<div class="mfoot">
					<button class="btn" type="button" onclick={() => (detailHit = null)}>Cancel</button>
					<!-- Submitting mid-fetch would save the place without its rating or
					     photo, and nothing backfills a rating later. -->
					<button class="btn primary" type="submit" disabled={detailLoading}>
						{detailLoading ? 'Loading…' : 'Add place'}
					</button>
				</div>
			</form>
		</Modal>
	{/if}

	{#if showManual && current}
		<Modal
			open={showManual}
			title={`Add a place in ${current.name}`}
			size="md"
			onclose={() => (showManual = false)}
		>
			<form
				method="POST"
				action="?/add"
				class="mform"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'failure') {
							addError = String(
								(result.data as { error?: string } | undefined)?.error ?? 'Could not add that.'
							);
							return;
						}
						await update({ reset: true });
						showManual = false;
					}}
			>
				<div class="mbody">
					<div class="fields">
						{#if addError}
							<p class="ferr" role="alert">{addError}</p>
						{/if}
						<input type="hidden" name="cityId" value={current.id} />
						<label>
							<span>Place in {current.name}</span>
							<input name="name" value={query} required use:focusOnMount />
						</label>
						<div class="frow">
							<label class="grow">
								<span>Activity <span class="muted">(optional)</span></span>
								<input name="activity" />
							</label>
							<label class="grow">
								<span>Link <span class="muted">(optional)</span></span>
								<input name="url" type="url" placeholder="https://" />
							</label>
						</div>
						<label>
							<span>Notes <span class="muted">(optional)</span></span>
							<textarea name="notes" rows="3"></textarea>
						</label>
					</div>
				</div>
				<div class="mfoot">
					<button class="btn" type="button" onclick={() => (showManual = false)}>Cancel</button>
					<button class="btn primary" type="submit">Add place</button>
				</div>
			</form>
		</Modal>
	{/if}

	{#if editPoi}
		{@const e = editPoi}
		<Modal open title="Edit place" size="md" onclose={() => (editPoi = null)}>
			<form
				method="POST"
				action="?/update"
				class="mform"
				use:enhance={() => async ({ update }) => {
					await update({ reset: false });
					editPoi = null;
				}}
			>
				<div class="mbody">
					<div class="fields">
						<input type="hidden" name="id" value={e.id} />
						<label>
							<span>Name</span>
							<input name="name" value={e.name} required use:focusOnMount />
						</label>
						<label>
							<span>Notes <span class="muted">(optional)</span></span>
							<textarea name="notes" rows="3">{e.notes ?? ''}</textarea>
						</label>
						<label>
							<span>Link <span class="muted">(optional)</span></span>
							<input name="url" type="url" value={e.url ?? ''} placeholder="https://" />
						</label>
					</div>
					<!-- Read-only, so it sits after the fields: the count answers "is this
					     popular?", which the card already told you. The names answer
					     "whose evening am I cancelling?", which is why you opened this.
					     Plain prose, not avatar chips: with a dozen voters the initials
					     repeat and become noise, and there is room here for real names. -->
					<p class="voters">
						<span class="vlabel">{e.votes === 1 ? '1 vote' : `${e.votes} votes`}</span>
						{#if e.voters.length}
							<span class="muted">: {e.voters.join(', ')}</span>
						{:else}
							<span class="muted">, nobody yet</span>
						{/if}
					</p>
				</div>
				<div class="mfoot">
					<button class="btn" type="button" onclick={() => (editPoi = null)}>Cancel</button>
					<button class="btn primary" type="submit">Save</button>
				</div>
			</form>
		</Modal>
	{/if}

	{#if (showAddStay || stayHit) && current}
		{@const h = stayHit}
		<Modal
			open
			title={h ? `Add ${h.name}` : `Add a stay in ${current.name}`}
			size="md"
			onclose={() => {
				showAddStay = false;
				stayHit = null;
			}}
		>
			<form
				method="POST"
				action="?/addStay"
				class="mform"
				use:enhance={() =>
					async ({ update }) => {
						await update({ reset: true });
						showAddStay = false;
						stayHit = null;
					}}
			>
				<div class="mbody">
					{#if h}
						{#if detailLoading}
							<p class="hsum skel" aria-hidden="true"></p>
						{:else if h.rating || h.priceLevel != null}
							<p class="hsum muted">
								{#if h.rating}
									<span class="rate"
										>★ {h.rating.toFixed(1)}{#if h.ratingCount}<span class="muted"
												>&nbsp;({h.ratingCount})</span
											>{/if}</span
									>
								{/if}
								{#if h.priceLevel != null}<span class="price">{priceStr(h.priceLevel)}</span>{/if}
							</p>
						{/if}
						{#if h.address}<p class="hsumaddr muted">{h.address}</p>{/if}
					{/if}
					<input type="hidden" name="cityId" value={current.id} />
					<div class="frow">
						<label class="grow">
							<span>Name</span>
							<!-- Prefilled from the result but still editable: "Athens Plaka
							     Acropolis Suites" is what Google calls it, not what the group
							     will call it in a vote. -->
							<input name="name" value={h?.name ?? ''} required use:focusOnMount={!h} />
						</label>
						<label class="pricef">
							<!-- The one thing the search cannot tell us: Google gives a $-band,
							     not a nightly rate, so it is where the cursor goes for a
							     prefilled stay. -->
							<span>Price / night <span class="muted">(optional)</span></span>
							<input name="price" type="number" min="0" step="1" use:focusOnMount={!!h} />
						</label>
					</div>
					<div class="frow">
						<label class="grow">
							<span>Tag <span class="muted">(optional)</span></span>
							<input name="tag" />
						</label>
						<label class="datef">
							<span>Check in <span class="muted">(optional)</span></span>
							<input name="checkIn" type="date" />
						</label>
						<label class="datef">
							<span>Check out <span class="muted">(optional)</span></span>
							<input name="checkOut" type="date" />
						</label>
					</div>
					<label>
						<span>Link <span class="muted">(optional)</span></span>
						<input name="url" type="url" value={h?.url ?? ''} placeholder="https://" />
					</label>
				</div>
				<div class="mfoot">
					<button
						class="btn"
						type="button"
						onclick={() => {
							showAddStay = false;
							stayHit = null;
						}}>Cancel</button
					>
					<button class="btn primary" type="submit" disabled={detailLoading}>
						{detailLoading ? 'Loading…' : 'Add stay'}
					</button>
				</div>
			</form>
		</Modal>
	{/if}

	{#if confirmDelete}
		{@const target = confirmDelete}
		<Modal open title="Delete this place?" size="sm" onclose={() => (confirmDelete = null)}>
			<form
				method="POST"
				action="?/remove"
				class="mform"
				use:enhance={() =>
					async ({ update }) => {
						await update();
						confirmDelete = null;
					}}
			>
				<div class="mbody">
					<input type="hidden" name="id" value={target.id} />
					<p class="cname">{target.name}</p>
					{#if target.linked > 0}
						<p class="warn" role="alert">
							{target.linked} scheduled {target.linked === 1 ? 'event' : 'events'} on the calendar
							{target.linked === 1 ? 'is' : 'are'} linked to this place and will be deleted too.
						</p>
					{:else}
						<p class="muted">Nothing on the calendar is linked to it.</p>
					{/if}
					<p class="muted">This can't be undone.</p>
				</div>
				<div class="mfoot">
					<button class="btn" type="button" onclick={() => (confirmDelete = null)}>Cancel</button>
					<button class="btn danger solid" type="submit">
						Delete{target.linked > 0 ? ` and ${target.linked} event${target.linked === 1 ? '' : 's'}` : ''}
					</button>
				</div>
			</form>
		</Modal>
	{/if}

	{#if current}
		<div class="layout">
			<SectionNav items={sections} bind:value={tab} ariaLabel="Discover sections" />

			<div class="panel">
				<div class="phead">
					<!-- A dropdown rather than a row of pills: the pill row grew with the
					     trip, wrapping to a second line on a five-city itinerary and moving
					     the cards down with it. A dropdown is one fixed-height control
					     whatever the itinerary. -->
					<div class="cityselect">
						<Select
							options={data.cities.map((c) => ({
								value: c.id,
								label: `${c.name} · ${cityCount(c)}`
							}))}
							bind:value={active}
							ariaLabel="City"
						/>
					</div>
					{#if tab === 'stays'}
						<span class="pstat muted">{staysVoted} of {data.memberCount} voted</span>
					{/if}
					<div class="searchrow" bind:this={searchEl}>
						<div class="searchwrap">
							<input
								bind:value={query}
								oninput={onInput}
								onfocus={() => {
									dismissed = false;
									searchFocused = true;
								}}
								placeholder="Search…"
								aria-label={searchKind === 'stay'
									? `Search hotels and rentals in ${current.name}`
									: `Search places in ${current.name}`}
							/>
							{#if query}
								<button class="clearbtn" type="button" onclick={clearSearch} aria-label="Clear search"
									>×</button
								>
							{/if}
							<!-- Indeterminate bar: the provider gives no progress, so this
							     communicates "working" without pretending to know how far along.
							     Overlaid on the input's lower edge so the header row keeps the
							     same height whether or not a search is running. -->
							<div
								class="progress"
								class:on={searching}
								role="progressbar"
								aria-label="Searching"
								aria-busy={searching}
							>
								<span></span>
							</div>
						</div>

						<!-- Anchored dropdown rather than an in-flow list: results are a
						     transient overlay, so finding a place must not push the pool of
						     places you already have off the screen. -->
						{#if showResults}
							<div class="dropdown">
								<ul class="hits">
									{#each hits as h (hitKey(h))}
										{@const key = hitKey(h)}
										<li>
											<button class="hit" type="button" onclick={() => openHit(h)}>
												<span class="hmeta">
													<strong class="hname">{h.name}</strong>
													<span class="hsub">
														{#if h.rating}
															<span class="rate"
																>★ {h.rating.toFixed(1)}{#if h.ratingCount}<span class="muted"
																		>&nbsp;({h.ratingCount})</span
																	>{/if}</span
															>
														{/if}
														{#if h.priceLevel != null}<span class="price"
																>{priceStr(h.priceLevel)}</span
															>{/if}
														{#if todayHours(h.hours)}<span class="hrs muted"
																>{todayHours(h.hours)}</span
															>{/if}
													</span>
													{#if h.address}<span class="haddr muted">{h.address}</span>{/if}
												</span>
												{#if added.has(key)}
													{@const n = added.get(key) ?? 0}
													<span class="hact" aria-hidden="true"
														>Added{n > 1 ? ` ×${n}` : ' ✓'}</span
													>
												{/if}
											</button>
										</li>
									{/each}
									{#if hits.length === 0}
										<!-- Two empty states, not three: with an empty field the footer
										     already says what to do, so a line telling you to search the
										     box you just clicked is noise. -->
										{#if query.trim().length === 0}
											<!-- nothing: the manual footer is the whole content -->
										{:else if query.trim().length < MIN_QUERY}
											<li class="nores muted">Keep typing…</li>
										{:else if searching}
											<li class="nores muted">Searching…</li>
										{:else}
											<li class="nores muted">
												No {searchKind === 'stay' ? 'stays' : 'matches'} for “{query}”.
											</li>
										{/if}
									{/if}
									<!-- Sticky footer, set apart from the results by its own tint: it is
									     the escape hatch, not another result. It also carries the
									     provider attribution, which has to sit next to the data. -->
									<li class="manualrow">
										<button
											class="btn small"
											type="button"
											onclick={() => {
												addError = null;
												if (searchKind === 'stay') showAddStay = true;
												else showManual = true;
											}}
											>Add manually</button
										>
										<span class="attrib">Powered by {providerLabel}</span>
									</li>
								</ul>
							</div>
						{/if}
					</div>
				</div>

				<div class="pool">
					{#if tab === 'places'}
						{#each current.pois as p (p.id)}
							<article class="card opt">
								<!-- The cover, title and meta are one control: clicking the place is
								     how you edit it. Vote / Open / Remove stay outside it so the card
								     never nests one interactive element inside another. -->
								<button class="oinfo" type="button" onclick={() => (editPoi = p)}>
									<Cover photo={p.photo} seed={p.name} category={p.category} />
									<span class="obody">
										<span class="otop">
											<span class="oname">{p.name}</span>
										</span>
										<span class="meta muted">
											{#if p.rating}
												<span class="rate"
													>★ {p.rating.toFixed(1)}{#if p.rating_count}<span class="muted"
															>&nbsp;({p.rating_count})</span
														>{/if}</span
												>
											{/if}
											{#if p.price_level != null}<span class="price">{priceStr(p.price_level)}</span
												>{/if}
											{#if todayHours(parseHours(p.hours))}
												<span class="hrs">{todayHours(parseHours(p.hours))}</span>
											{/if}
											{#if p.notes}<span class="notes">{p.notes}</span>{/if}
										</span>
									</span>
								</button>
								<div class="obody obottom">
									{#if p.linked > 0}
										<p class="sched">🗓 On the calendar ×{p.linked}</p>
									{/if}
									<div class="votebar">
										<div class="fill" style={`width:${pct(p.votes)}%`}></div>
									</div>
									<div class="ofoot">
										<span class="muted">{p.votes} {p.votes === 1 ? 'vote' : 'votes'}</span>
										<div class="actions">
											{#if p.url}
												<a class="btn small" href={p.url} target="_blank" rel="noopener">
													Open<span class="sr-only"> {p.name} (opens in a new tab)</span>
												</a>
											{/if}
											<form method="POST" action="?/vote" use:enhance>
												<input type="hidden" name="id" value={p.id} />
												<button
													class="btn small"
													class:primary={p.you_voted}
													aria-label={`${p.you_voted ? 'Remove your vote from' : 'Vote for'} ${p.name}`}
												>
													{p.you_voted ? 'Voted' : 'Vote'}
												</button>
											</form>
										</div>
									</div>
									<div class="orow">
										<button
											class="link danger"
											onclick={() =>
												(confirmDelete = { id: p.id, name: p.name, linked: p.linked })}
											aria-label={`Remove ${p.name}`}>Remove</button
										>
									</div>
								</div>
							</article>
						{/each}
						{#if current.pois.length === 0}
							<p class="muted empty">No places in {current.name} yet. Add one to get started.</p>
						{/if}
					{:else}
						{#each stays as o (o.id)}
							<article class="card opt" class:winner={o.locked} class:picked={o.you_voted}>
								<Cover photo={null} seed={o.name} category="stay" />
								<div class="obody">
									<div class="otop">
										<h4>{o.name}</h4>
										{#if o.locked}<span class="chip accent">Locked</span>{/if}
									</div>
									<p class="meta muted">
										{#if o.tag}{o.tag + ' · '}{/if}{money(o.price_cents)}
									</p>
									{#if nightsLabel(o.check_in, o.check_out)}
										<p class="sched">🛏 {nightsLabel(o.check_in, o.check_out)}</p>
									{/if}
									<div class="votebar">
										<div class="fill" style={`width:${pct(o.votes)}%`}></div>
									</div>
									<div class="ofoot">
										<span class="muted">{o.votes} {o.votes === 1 ? 'vote' : 'votes'}</span>
										<div class="actions">
											{#if o.url}
												<a class="btn small" href={o.url} target="_blank" rel="noopener">
													Open<span class="sr-only"> {o.name} (opens in a new tab)</span>
												</a>
											{/if}
											<form method="POST" action="?/voteStay" use:enhance>
												<input type="hidden" name="optionId" value={o.id} />
												<button
													class="btn small"
													class:primary={o.you_voted}
													aria-label={`${o.you_voted ? 'Remove your vote from' : 'Vote for'} ${o.name}`}
												>
													{o.you_voted ? 'Voted' : 'Vote'}
												</button>
											</form>
										</div>
									</div>
									<div class="orow">
										<button
											class="link"
											aria-expanded={editDatesFor === o.id}
											onclick={() => (editDatesFor = editDatesFor === o.id ? null : o.id)}
											>{editDatesFor === o.id ? 'Cancel' : 'Edit dates'}</button
										>
										{#if data.isOrganizer}
											<form method="POST" action="?/lockStay" use:enhance>
												<input type="hidden" name="optionId" value={o.id} />
												<button class="link" aria-label={`${o.locked ? 'Unlock' : 'Lock as choice'}: ${o.name}`}>
													{o.locked ? 'Unlock' : 'Lock as choice'}
												</button>
											</form>
										{/if}
										<form method="POST" action="?/removeStay" use:enhance>
											<input type="hidden" name="optionId" value={o.id} />
											<button class="link danger" aria-label={`Remove ${o.name}`}>Remove</button>
										</form>
									</div>
									{#if editDatesFor === o.id}
										<form
											method="POST"
											action="?/stayDates"
											class="datesedit"
											use:enhance={() =>
												async ({ update }) => {
													await update();
													editDatesFor = null;
												}}
										>
											<input type="hidden" name="optionId" value={o.id} />
											<label>
												<span>In</span>
												<input name="checkIn" type="date" value={o.check_in ?? ''} />
											</label>
											<label>
												<span>Out</span>
												<input name="checkOut" type="date" value={o.check_out ?? ''} />
											</label>
											<button class="btn small primary" type="submit">Save</button>
										</form>
									{/if}
								</div>
							</article>
						{/each}
						{#if stays.length === 0}
							<p class="muted empty">
								No stays proposed for {current.name} yet. Add one and let the group vote.
							</p>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	{/if}
{/if}

<style>
	.layout {
		display: grid;
		grid-template-columns: 190px minmax(0, 1fr);
		gap: 1.6rem;
		align-items: start;
	}
	.panel {
		min-width: 0;
	}
	.phead {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		min-height: var(--phead-h);
		margin-bottom: 0.6rem;
	}
	.cityselect {
		min-width: 0;
		flex: 0 1 auto;
	}
	/* Solid accent, as the selected city pill used to be: this is the control that
	   says which city everything below belongs to, so it should read as the page's
	   current state rather than as one more neutral input in the row.
	   The city control must also be exactly as tall as the search input beside it,
	   or the header row height changes with it and the cards move. */
	.cityselect :global(.seltrigger) {
		padding: 0.4rem 0.85rem;
		border-radius: 999px;
		font-size: 0.88rem;
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		font-weight: 500;
	}
	.cityselect :global(.seltrigger:hover) {
		background: var(--accent-ink);
		border-color: var(--accent-ink);
	}
	/* The caret defaults to a faint grey that disappears on the green. */
	.cityselect :global(.selcaret) {
		color: rgba(255, 255, 255, 0.75);
	}
	/* Header-row stat. Lives in .phead rather than a line below it so switching
	   section never changes the height above the cards. No auto margin: the
	   search box owns the right edge on both sections, so this sits with the city
	   it describes rather than drifting between the two. */
	.pstat {
		font-size: 0.85rem;
		white-space: nowrap;
	}
	.pool {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1rem;
		min-width: 0;
	}
	.empty {
		grid-column: 1 / -1;
	}

	/* Card shell shared by places and stays: a flex column so the vote bar and
	   footers line up across a row no matter how the title wraps. */
	.opt {
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.opt.winner {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}
	.opt.picked:not(.winner) {
		border-color: var(--accent-soft);
	}
	.obody {
		padding: 0.9rem 1rem 1rem;
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
	}
	.otop {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.otop h4 {
		font-size: 1rem;
		margin: 0;
		min-width: 0;
		/* Long place names are common; cap at two lines rather than letting a card
		   grow taller than its neighbours. */
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.otop .chip {
		flex: 0 0 auto;
	}
	/* The clickable region of a place card: cover + title + meta. Reset the
	   button chrome so it reads as the card itself, not as a control. */
	.oinfo {
		all: unset;
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
		box-sizing: border-box;
		cursor: pointer;
		text-align: left;
		color: inherit;
	}
	.oinfo:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.oinfo:hover .oname {
		text-decoration: underline;
	}
	.oinfo .obody {
		padding-bottom: 0;
	}
	.obottom {
		padding-top: 0.6rem;
		flex: 0 0 auto;
	}
	.oname {
		font-size: 1rem;
		font-weight: 600;
		min-width: 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	/* Absorbs the slack so everything below aligns across cards. */
	.meta {
		flex: 1 1 auto;
		margin: 0.3rem 0 0.6rem;
		font-size: 0.85rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.5rem;
		align-items: baseline;
		min-width: 0;
	}
	/* Notes are a multi-line field, so honour the breaks the author typed,
	   still clamped to two lines so cards stay the same height. */
	.meta .notes {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.sched {
		font-size: 0.8rem;
		color: var(--accent-ink);
		margin: 0 0 0.6rem;
		overflow-wrap: anywhere;
	}
	.votebar {
		height: 6px;
		background: var(--surface-2);
		border-radius: 999px;
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: var(--accent);
	}
	.ofoot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
		font-size: 0.85rem;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.orow {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		flex-wrap: wrap;
		margin-top: 0.7rem;
		padding-top: 0.7rem;
		border-top: 1px solid var(--line);
	}
	.link {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		font-size: 0.82rem;
		color: var(--ink-soft);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.link:hover {
		color: var(--ink);
	}
	.link.danger {
		color: var(--danger, #a33d3d);
	}
	.datesedit {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.7rem;
	}
	.datesedit label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.75rem;
		color: var(--ink-faint);
		min-width: 0;
	}
	.datesedit input {
		padding: 0.35rem 0.4rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		font: inherit;
		font-size: 0.8rem;
		color: var(--ink);
		min-width: 0;
		max-width: 100%;
	}

	/* --- Place search, inline in the header row --- */
	.searchrow {
		position: relative;
		flex: 1 1 240px;
		min-width: 0;
		max-width: 420px;
		margin-left: auto;
	}
	.searchwrap {
		position: relative;
		min-width: 0;
	}
	/* Matched to the city control's metrics so the header row is exactly as tall
	   on Places as it is on Stays; switching section must not move the cards. */
	.searchwrap input {
		width: 100%;
		padding: 0.4rem 2rem 0.4rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
		font: inherit;
		font-size: 0.88rem;
		color: var(--ink);
	}
	.clearbtn {
		position: absolute;
		top: 50%;
		right: 0.3rem;
		transform: translateY(-50%);
		width: 1.5rem;
		height: 1.5rem;
		display: grid;
		place-items: center;
		border: none;
		border-radius: 999px;
		background: none;
		font: inherit;
		font-size: 1.05rem;
		line-height: 1;
		color: var(--ink-faint);
		cursor: pointer;
	}
	.clearbtn:hover {
		background: var(--surface-2);
		color: var(--ink);
	}
	/* Overlays the input's lower edge rather than sitting under it, so starting a
	   search adds no height to the header row. */
	.progress {
		position: absolute;
		left: 0.75rem;
		right: 0.75rem;
		bottom: 1px;
		height: 2px;
		border-radius: 999px;
		overflow: hidden;
		pointer-events: none;
	}
	.progress span {
		display: block;
		height: 100%;
		width: 40%;
		border-radius: 999px;
		background: var(--accent);
		transform: translateX(-110%);
	}
	.progress.on span {
		animation: slide 1.1s ease-in-out infinite;
	}
	@keyframes slide {
		0% {
			transform: translateX(-110%);
		}
		100% {
			transform: translateX(320%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.progress.on span {
			animation: none;
			width: 100%;
			transform: none;
			opacity: 0.6;
		}
	}
	.dropdown {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		z-index: 40;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		box-shadow: var(--shadow);
		/* The dropdown scrolls; the page behind it does not move. */
		max-height: min(60vh, 380px);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.hits {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	/* The whole row is the control; a small "Add" button next to a rich result
	   made the click target far smaller than the thing it acted on. */
	.hit {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		width: 100%;
		padding: 0.6rem 0.7rem;
		border: none;
		border-bottom: 1px solid var(--line);
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.nores {
		padding: 0.7rem;
		font-size: 0.85rem;
		border-bottom: 1px solid var(--line);
		overflow-wrap: anywhere;
	}
	/* The tint is the divider: it marks the footer as a different kind of thing
	   from the rows above rather than as one more result. */
	.manualrow {
		position: sticky;
		bottom: 0;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.15rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-2);
	}
	.attrib {
		font-size: 0.68rem;
		color: var(--ink-faint);
		white-space: nowrap;
	}
	.hit:hover,
	.hit:focus-visible {
		background: var(--surface-2);
	}
	.hit:hover .hact,
	.hit:focus-visible .hact {
		color: var(--accent-ink);
	}
	/* Affordance only; the row is the button, so this is aria-hidden. */
	.hact {
		flex: 0 0 auto;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--ink-faint);
		white-space: nowrap;
	}
	.hmeta {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.hname {
		overflow-wrap: anywhere;
	}
	.hsub {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.haddr {
		font-size: 0.8rem;
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.rate {
		font-size: 0.8rem;
		color: #b4682a;
		font-weight: 600;
		white-space: nowrap;
	}
	.price {
		font-size: 0.8rem;
		color: var(--accent-ink);
		font-weight: 600;
		white-space: nowrap;
	}
	.hrs {
		font-size: 0.8rem;
		white-space: nowrap;
	}
	/* --- Add place / stay modals --- */
	.hsum {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		margin: 0 0 0.3rem;
	}
	.hsumaddr {
		margin: 0 0 0.9rem;
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}
	.hsum.skel {
		height: 1.2em;
		width: 9rem;
		border-radius: 4px;
		background: var(--line);
		opacity: 0.5;
	}
	.frow {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.grow {
		flex: 1 1 180px;
		min-width: 0;
	}
	/* Wide enough that "Price / night (optional)" stays on one line: a wrapped
	   label makes this field's input sit a line lower than the one beside it. */
	.pricef {
		flex: 0 1 186px;
		min-width: 0;
	}
	.datef {
		flex: 0 1 145px;
		min-width: 0;
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.mform label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
		min-width: 0;
	}
	.mform input,
	.mform textarea {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		font: inherit;
		color: var(--ink);
		min-width: 0;
		max-width: 100%;
	}
	.mform textarea {
		width: 100%;
		resize: vertical;
		line-height: 1.4;
	}
	.fhint {
		font-size: 0.75rem;
		line-height: 1.35;
	}
	.voters {
		margin: 0.9rem 0 0;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
		font-size: 0.85rem;
		line-height: 1.5;
	}
	.vlabel {
		font-weight: 600;
	}
	/* The add popup keeps itself open when the server rejects, so the reason has
	   to live in the popup; a page-level note would sit behind the overlay. */
	.ferr {
		margin: 0;
		font-size: 0.85rem;
		color: #8c1d18;
		background: #fdecea;
		border: 1px solid #f3c9c4;
		border-radius: 8px;
		padding: 0.5rem 0.65rem;
	}
	.cname {
		font-weight: 600;
		margin: 0 0 0.5rem;
		overflow-wrap: anywhere;
	}
	.warn {
		margin: 0 0 0.5rem;
		font-size: 0.9rem;
		color: #8a4b12;
		background: #fdf2e4;
		border: 1px solid #f0d9bc;
		border-radius: var(--r);
		padding: 0.55rem 0.7rem;
	}
	.note.error {
		color: #a33d3d;
	}

	/* The section sidebar takes ~215px out of the row, so it stacks above the
	   cards on narrow screens rather than squeezing them. */
	@media (max-width: 860px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
	}
</style>
