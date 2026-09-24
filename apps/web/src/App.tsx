import { Routes, Route, Navigate } from 'react-router';
import { TABS } from './nav';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import NotFound from './pages/NotFound';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import Forgot from './pages/Forgot';
import Reset from './pages/Reset';
import Verify from './pages/Verify';
import VerifyEmail from './pages/VerifyEmail';
import Account from './pages/Account';
import Trips from './pages/Trips';
import TripShell from './pages/TripShell';
import People from './pages/People';
import Expenses from './pages/Expenses';
import Pretrip from './pages/Pretrip';
import Discover from './pages/Discover';
import Schedule from './pages/Schedule';

/** Section pages, keyed by the slug in `nav.ts`. A full Record rather than a
 *  Partial: adding a tab without a page should fail the type-check, not render
 *  a stub nobody notices. */
const SECTION_PAGES: Record<(typeof TABS)[number]['slug'], React.ComponentType> = {
	people: People,
	expenses: Expenses,
	preparation: Pretrip,
	discover: Discover,
	schedule: Schedule
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
				<Route path="/forgot" element={<Forgot />} />
				<Route path="/reset" element={<Reset />} />
				<Route path="/verify" element={<Verify />} />
				{/* Public on purpose: see `VerifyEmail`. */}
				<Route path="/verify-email" element={<VerifyEmail />} />

				{/* Everything past this point needs a signed-in user. Grouping the
				    guarded routes under one element beats repeating a check inside
				    each page, where the one page that forgets it is the security
				    hole. It is convenience, not enforcement: the API authorises
				    every request independently. */}
				<Route element={<RequireAuth />}>
					<Route path="/account" element={<Account />} />
					<Route path="/trips" element={<Trips />} />
					<Route path="/trips/:tripId" element={<TripShell />}>
						<Route index element={<Navigate to="discover" replace />} />
						{TABS.map((t) => {
							const Page = SECTION_PAGES[t.slug];
							return <Route key={t.slug} path={t.slug} element={<Page />} />;
						})}
					</Route>
				</Route>

				<Route path="*" element={<NotFound />} />
			</Route>
		</Routes>
	);
}
