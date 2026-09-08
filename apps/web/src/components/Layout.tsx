import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth';

/**
 * The app frame: sticky top bar over whatever route is showing. It is a layout
 * route rather than a component each page renders, so the bar is mounted once
 * and its open/closed menu state survives navigation.
 */
export default function Layout() {
	return (
		<>
			<TopBar />
			{/* A plain wrapper, not <main>: each page renders its own <main>, and
			    nesting one inside another is invalid and confuses screen readers. */}
			<div className="pb-16">
				<Outlet />
			</div>
		</>
	);
}

function TopBar() {
	const { status, user, logOut } = useAuth();
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);

	// Any click that is not on the trigger closes the menu. Registered on the
	// window rather than a backdrop element so the click that dismisses the menu
	// still reaches whatever it landed on.
	useEffect(() => {
		if (!menuOpen) return;
		const close = () => setMenuOpen(false);
		window.addEventListener('click', close);
		return () => window.removeEventListener('click', close);
	}, [menuOpen]);

	return (
		<header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-[8px]">
			<div className="container flex h-16 items-center justify-between">
				<Link
					to={status === 'authenticated' ? '/trips' : '/'}
					className="flex items-center gap-2 font-serif text-[1.25rem] font-[560]"
				>
					<span className="text-[1.4rem] text-accent">◍</span>
					<span>Trippy</span>
				</Link>

				<nav className="flex items-center gap-6 text-[0.92rem] font-medium">
					{status === 'authenticated' ? (
						<div className="relative">
							<button
								type="button"
								aria-haspopup="menu"
								aria-expanded={menuOpen}
								onClick={(e) => {
									// Without this the window listener above would see the same
									// click and close the menu in the same tick it opened.
									e.stopPropagation();
									setMenuOpen((v) => !v);
								}}
								className={[
									'inline-flex items-center gap-2 rounded-full border py-1 pr-2 pl-1.5 font-medium text-ink',
									menuOpen ? 'border-line bg-surface' : 'border-transparent hover:border-line hover:bg-surface'
								].join(' ')}
							>
								<span className="grid size-7 place-items-center rounded-full bg-accent text-[0.8rem] font-semibold text-white">
									{user.name.slice(0, 1).toUpperCase()}
								</span>
								<span>{user.name}</span>
								<span aria-hidden="true" className="text-[0.7rem] text-ink-faint">
									▾
								</span>
							</button>

							{menuOpen && (
								<div
									role="menu"
									className="absolute right-0 top-[calc(100%+8px)] z-30 flex min-w-48 flex-col rounded border border-line bg-surface p-1.5 shadow-card"
								>
									<Link
										to="/account"
										role="menuitem"
										className="rounded-sm px-2.5 py-2 text-left text-[0.9rem] hover:bg-surface-2 hover:text-accent-ink"
									>
										Account settings
									</Link>
									<button
										type="button"
										role="menuitem"
										onClick={async () => {
											await logOut();
											navigate('/', { replace: true });
										}}
										className="cursor-pointer rounded-sm px-2.5 py-2 text-left text-[0.9rem] hover:bg-surface-2 hover:text-accent-ink"
									>
										Log out
									</button>
								</div>
							)}
						</div>
					) : (
						// Nothing is shown while the session is still being checked. The
						// alternative is guessing, and guessing wrong means the bar flips
						// from "Log in" to a username a moment after every page load.
						status === 'anonymous' && (
							<>
								<Link to="/login" className="hover:text-accent">
									Log in
								</Link>
								<Link to="/register" className="btn primary">
									Start planning
								</Link>
							</>
						)
					)}
				</nav>
			</div>
		</header>
	);
}
