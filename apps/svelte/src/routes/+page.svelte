<script lang="ts">
	const features = [
		{
			icon: String.fromCodePoint(0x1f9ed),
			title: 'Discover and vote',
			body: 'Search each city for things to do and places to stay, shortlist them together, and vote before the organizer locks a pick.'
		},
		{
			icon: String.fromCodePoint(0x1f5fa),
			title: 'Map and travel time',
			body: 'Every day plots on a map with routes and drive, transit, or walk times between stops.'
		},
		{
			icon: String.fromCodePoint(0x1f465),
			title: 'See who splits off',
			body: 'Pick who is on each activity and the day lays itself out, drawing arrows as people leave one group and join another.'
		},
		{
			icon: String.fromCodePoint(0x1f30f),
			title: 'Multi-city, multi-zone',
			body: 'Each city keeps its own time zone, so flights and rail legs land at the right local hour.'
		},
		{
			icon: String.fromCodePoint(0x2705),
			title: 'Get everyone ready',
			body: 'Share a checklist and a budget. Tasks like visas are ticked off per person, so nothing looks done until it is.'
		},
		{
			icon: String.fromCodePoint(0x1f4b8),
			title: 'Settle up',
			body: 'Track who paid what in any currency, then settle with the fewest transactions.'
		}
	];
</script>

<section class="hero">
	<div class="container">
		<span class="chip accent">Group trips, done together</span>
		<h1>Plan the whole trip<br />in one place.</h1>
		<p class="lede">
			Trippy keeps a shared itinerary across every city, with a live map, travel times, lodging
			votes, and cost splitting built in.
		</p>
		<div class="cta">
			<a class="btn primary" href="/register">Start a trip</a>
			<a class="btn" href="/login">Log in</a>
		</div>
	</div>
</section>

<section class="container features">
	{#each features as f}
		<article class="card feat">
			<div class="ficon">{f.icon}</div>
			<h3>{f.title}</h3>
			<p class="muted">{f.body}</p>
		</article>
	{/each}
</section>

<style>
	.hero {
		padding: 5rem 0 3.5rem;
	}
	.hero h1 {
		font-size: clamp(2.4rem, 5vw, 3.6rem);
		margin: 1.2rem 0 0.8rem;
	}
	.lede {
		max-width: 34rem;
		font-size: 1.12rem;
		color: var(--ink-soft);
		margin: 0 0 1.8rem;
	}
	.cta {
		display: flex;
		gap: 0.75rem;
	}
	.features {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
	}
	.feat {
		padding: 1.5rem;
	}
	.ficon {
		font-size: 1.6rem;
		margin-bottom: 0.6rem;
	}
	.feat h3 {
		font-size: 1.12rem;
		margin-bottom: 0.35rem;
	}
	.feat p {
		font-size: 0.94rem;
		margin: 0;
	}
	@media (max-width: 860px) {
		.features {
			grid-template-columns: 1fr;
		}
	}
</style>
