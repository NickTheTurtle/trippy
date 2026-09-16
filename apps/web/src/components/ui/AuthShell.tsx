import type { ReactNode } from 'react';
import { copy } from '../../copy';

/** The card, heading and blurb every signed-out page sits in. */
function AuthCard({
	title,
	blurb,
	children
}: {
	title: string;
	blurb: string;
	children: ReactNode;
}) {
	return (
		<div className="grid place-items-center px-6 py-16">
			<div className="w-full max-w-sm rounded-lg border border-line bg-surface p-8 shadow-card">
				<h1 className="text-title">{title}</h1>
				<p className="mt-1.5 mb-6 text-ink-soft">{blurb}</p>
				{children}
			</div>
		</div>
	);
}

/**
 * The frame shared by log in and register: centred card, heading, and the
 * alternate-action line underneath. Both pages are the same shape, so the shape
 * lives here and each page supplies only its fields.
 *
 * No error slot. A refusal from the server is a result like any other and goes
 * to the corner, which each page raises in its own catch rather than through a
 * prop here: the same wrong password twice is two refusals, and a prop holding
 * one string cannot say that a second time.
 */
export function AuthShell({
	title,
	blurb,
	onSubmit,
	submitting,
	submitLabel,
	children,
	footer
}: {
	title: string;
	blurb: string;
	onSubmit: () => void;
	submitting: boolean;
	submitLabel: string;
	children: ReactNode;
	footer: ReactNode;
}) {
	return (
		<AuthCard title={title} blurb={blurb}>
			<form
				className="flex flex-col gap-3.5"
				onSubmit={(e) => {
					e.preventDefault();
					onSubmit();
				}}
			>
				{children}
				<button
					type="submit"
					disabled={submitting}
					className="btn primary mt-1 w-full justify-center"
				>
					{submitting ? copy.common.working : submitLabel}
				</button>
			</form>

			<p className="mt-5 text-center text-body text-ink-soft">{footer}</p>
		</AuthCard>
	);
}

/**
 * The same card with something to read instead of something to fill in: the
 * end of a flow that continues in the reader's inbox, or one that has finished.
 *
 * It shares the chrome rather than restating it so that these pages never drift
 * into looking like a different product from the form they came from.
 */
export function AuthNotice({
	title,
	blurb,
	footer
}: {
	title: string;
	blurb: string;
	footer?: ReactNode;
}) {
	return (
		<AuthCard title={title} blurb={blurb}>
			{footer ? <p className="text-center text-body text-ink-soft">{footer}</p> : null}
		</AuthCard>
	);
}
