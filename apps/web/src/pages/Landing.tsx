import { Link } from 'react-router';
import { settle } from '@trippy/core/settlement';
import { localTime, zoneAbbr } from '@trippy/core/tz';

/**
 * Landing page, and deliberately also the smoke test for the port's two riskiest
 * assumptions: that `@trippy/core` resolves from the web app through the npm
 * workspace link, and that the Tailwind theme is picking up the ported tokens.
 * Both fail loudly here rather than silently much later.
 */
export default function Landing() {
	const owed = settle([
		{ userId: 'Ana', net: 42 },
		{ userId: 'Ben', net: -18 },
		{ userId: 'Cy', net: -24 }
	]);

	const zones = ['Europe/Athens', 'Asia/Shanghai', 'America/Los_Angeles'];

	return (
		<main className="mx-auto max-w-3xl px-6 py-16">
			<h1 className="font-serif text-4xl text-ink">Trippy</h1>
			<p className="mt-3 text-ink-soft">
				Plan a trip together: points of interest, a shared calendar, lodging votes and who owes
				whom.
			</p>

			<div className="mt-8 flex gap-3">
				<Link
					to="/trips"
					className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-ink"
				>
					Your trips
				</Link>
				<Link
					to="/login"
					className="rounded border border-line px-4 py-2 text-sm text-ink transition-colors hover:bg-surface-2"
				>
					Log in
				</Link>
			</div>

			<section className="mt-12 rounded-lg border border-line bg-surface p-5 shadow-sm">
				<h2 className="font-serif text-lg">Port smoke test</h2>

				<p className="mt-3 text-xs tracking-wide text-ink-faint uppercase">
					settle() from @trippy/core
				</p>
				<ul className="mt-1 text-sm text-ink-soft">
					{owed.map((t) => (
						<li key={`${t.from}-${t.to}`}>
							{t.from} pays {t.to} ${t.amount.toFixed(2)}
						</li>
					))}
				</ul>

				<p className="mt-4 text-xs tracking-wide text-ink-faint uppercase">tz helpers</p>
				<ul className="mt-1 text-sm text-ink-soft">
					{zones.map((z) => (
						<li key={z}>
							{z}: {localTime(z)} {zoneAbbr(z)}
						</li>
					))}
				</ul>
			</section>
		</main>
	);
}
