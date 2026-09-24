import { useEffect, useId, useRef, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { CaretIcon } from './ui/icons';
import Logo from './ui/Logo';
import Avatar from './ui/Avatar';
import { copy } from '../copy';

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
	const menuWrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelId = useId();

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
					className="tap flex items-center gap-2 font-serif text-heading font-[560]"
				>
					<Logo />
					<span>{copy.shell.brand}</span>
				</Link>

				<nav className="flex min-w-0 items-center gap-6 text-body font-medium">
					{status === 'authenticated' ? (
						/* A disclosure, not an ARIA menu. It was marked up as
						   `role="menu"` with `menuitem`s, which promises arrow keys,
						   roving focus and typeahead that were never built, so a screen
						   reader user was told to use keys that did nothing. Two links'
						   worth of choices do not need a menu: a button that shows and
						   hides a panel of ordinary controls is the honest pattern, and
						   Tab, Escape and click-away are all it has to handle. */
						<div
							className="relative min-w-0"
							ref={menuWrapRef}
							onKeyDown={(e) => {
								if (e.key === 'Escape' && menuOpen) {
									e.stopPropagation();
									setMenuOpen(false);
									triggerRef.current?.focus();
								}
							}}
							// Tabbing out of the menu has to dismiss it as well, otherwise it
							// stays open over a page the user has already moved on to. Focus
							// moving between the trigger and its items is not leaving.
							onBlur={(e) => {
								if (!menuOpen) return;
								const next = e.relatedTarget as Node | null;
								if (next && menuWrapRef.current?.contains(next)) return;
								setMenuOpen(false);
							}}
						>
							<button
								type="button"
								ref={triggerRef}
								aria-expanded={menuOpen}
								aria-controls={panelId}
								onClick={(e) => {
									// Without this the window listener above would see the same
									// click and close the menu in the same tick it opened.
									e.stopPropagation();
									setMenuOpen((v) => !v);
								}}
								// A `.btn`, so the pill is the same height as every other
								// control in the app rather than the 38px its own padding
								// happened to give it. `round` rounds it around the avatar and
								// `quiet` drops the border until it is hovered or open.
								// `max-w-full` and the truncating name keep a long account
								// name from pushing the bar past a phone's width: at 390px a
								// fifty-letter name widened the page by 191px.
								className={`${menuOpen ? 'btn round' : 'btn round quiet'} max-w-full`}
							>
								<Avatar tone="solid" name={user.name} />
								<span className="min-w-0 max-w-[9rem] truncate sm:max-w-[16rem]" title={user.name}>
									{user.name}
								</span>
								<span className="flex text-ink-faint">
									<CaretIcon />
								</span>
							</button>

							{menuOpen && (
								<div
									id={panelId}
									className="absolute right-0 top-[calc(100%+8px)] z-30 flex min-w-48 flex-col rounded-sm border border-line bg-surface p-1.5 shadow-card"
								>
									<Link
										to="/account"
										onClick={() => setMenuOpen(false)}
										className="rounded-sm px-2.5 py-2 text-left text-body hover:bg-surface-2 hover:text-accent-ink"
									>
										{copy.shell.accountSettings}
									</Link>
									<button
										type="button"
										onClick={async () => {
											setMenuOpen(false);
											await logOut();
											navigate('/', { replace: true });
										}}
										className="cursor-pointer rounded-sm px-2.5 py-2 text-left text-body hover:bg-surface-2 hover:text-accent-ink"
									>
										{copy.shell.logOut}
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
									{copy.shell.logIn}
								</Link>
								<Link to="/register" className="btn primary">
									{copy.shell.register}
								</Link>
							</>
						)
					)}
				</nav>
			</div>
		</header>
	);
}
