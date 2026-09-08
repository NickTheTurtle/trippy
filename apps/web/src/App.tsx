import { Routes, Route, NavLink, Navigate, Outlet } from 'react-router';
import { SECTIONS } from './nav';
import Placeholder from './pages/Placeholder';
import Landing from './pages/Landing';

/**
 * Route skeleton mirroring the SvelteKit app's URLs exactly, so the two can be
 * compared side by side during the port and links stay valid when the Svelte
 * app is retired. Sections are stubs until each one is ported.
 */
export default function App() {
	return (
		<Routes>
			<Route path="/" element={<Landing />} />
			<Route path="/login" element={<Placeholder title="Log in" />} />
			<Route path="/register" element={<Placeholder title="Create account" />} />
			<Route path="/account" element={<Placeholder title="Account" />} />
			<Route path="/trips" element={<Placeholder title="Trips" />} />
			<Route path="/trips/:tripId" element={<TripShell />}>
				<Route index element={<Navigate to="calendar" replace />} />
				{SECTIONS.map((s) => (
					<Route key={s.slug} path={s.slug} element={<Placeholder title={s.label} />} />
				))}
			</Route>
			<Route path="*" element={<Placeholder title="Not found" />} />
		</Routes>
	);
}

function TripShell() {
	return (
		<div className="mx-auto max-w-5xl px-6 py-8">
			<nav className="mb-6 flex flex-wrap gap-1 border-b border-line pb-2">
				{SECTIONS.map((s) => (
					<NavLink
						key={s.slug}
						to={s.slug}
						className={({ isActive }) =>
							[
								'rounded-sm px-3 py-1.5 text-sm transition-colors',
								isActive
									? 'bg-accent-soft font-medium text-accent-ink'
									: 'text-ink-soft hover:text-ink'
							].join(' ')
						}
					>
						{s.label}
					</NavLink>
				))}
			</nav>
			<Outlet />
		</div>
	);
}
