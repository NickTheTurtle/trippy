import { Routes, Route, Navigate } from 'react-router';
import { TABS, MERGED } from './nav';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import Placeholder from './pages/Placeholder';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import Trips from './pages/Trips';
import TripShell from './pages/TripShell';
import People from './pages/People';

/** Section pages, keyed by the slug in `nav.ts`. Anything not listed yet falls
 *  back to a stub, so the router stays complete while the port is in progress. */
const SECTION_PAGES: Partial<Record<(typeof TABS)[number]['slug'], React.ComponentType>> = {
	people: People
};

/**
 * Route skeleton mirroring the SvelteKit app's URLs exactly, so the two can be
 * compared side by side during the port and links stay valid when the Svelte
 * app is retired. Sections are stubs until each one is ported.
 */
export default function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<Landing />} />
				<Route path="/login" element={<Login />} />
				<Route path="/register" element={<Register />} />

				{/* Everything past this point needs a signed-in user. Grouping the
				    guarded routes under one element beats repeating a check inside
				    each page, where the one page that forgets it is the security
				    hole. It is convenience, not enforcement: the API authorises
				    every request independently. */}
				<Route element={<RequireAuth />}>
					<Route path="/account" element={<Placeholder title="Account" />} />
					<Route path="/trips" element={<Trips />} />
					<Route path="/trips/:tripId" element={<TripShell />}>
						<Route index element={<Navigate to="discover" replace />} />
						{TABS.map((t) => {
							const Page = SECTION_PAGES[t.slug];
							return (
								<Route
									key={t.slug}
									path={t.slug}
									element={Page ? <Page /> : <Placeholder title={t.label} />}
								/>
							);
						})}
						{MERGED.map((m) => (
							<Route key={m.slug} path={m.slug} element={<Navigate to={`../${m.into}`} replace />} />
						))}
					</Route>
				</Route>

				<Route path="*" element={<Placeholder title="Not found" />} />
			</Route>
		</Routes>
	);
}