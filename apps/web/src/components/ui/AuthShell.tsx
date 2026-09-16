import type { ReactNode } from 'react';
import { isValidEmail } from '@trippy/core/validate';
import type { ErrorSlot } from './Toast';
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
 * one string cannot say that a second time. Each page clears its own slot when
 * a submit starts, so the corner holds the latest answer and not the last one.
 *
 * Every field on these four forms is `required`. Presence is not the server's
 * rule to own here: its answer to an empty log in is "Wrong email or password",
 * which costs a round trip and points at the wrong thing. Anything the server
 * does own (how long a password must be, whether an address is already taken)
 * is still left to it, and arrives in the corner.
 *
 * Those two rules used to be enforced by the browser, which meant the one part
 * of the auth flow that still spoke in a different voice: an OS bubble, in the
 * OS styling, anchored to the input and gone again on its own, next to an app
 * where every other refusal is a corner toast. The dialogs already turned that
 * off in `ModalForm` for the same reason. The form is `noValidate` and the
 * check below is ours, so a missing field and a mistyped address are told in
 * the same place, and in the same words, as a wrong password. The inputs keep
 * their `required` and their `type="email"`: that is what assistive technology
 * and password managers read, and `noValidate` suppresses only the browser's
 * own UI.
 *
 * It reports through the page's own error slot rather than one of its own, so
 * a form that is refused locally and then refused by the server leaves one
 * sentence in the corner rather than two from two different owners.
 */
function firstProblem(form: HTMLFormElement): { field: HTMLInputElement; message: string } | null {
	for (const el of form.elements) {
		if (!(el instanceof HTMLInputElement)) continue;
		if (el.required && !el.value.trim()) return { field: el, message: copy.ui.form.missing };
		// The same shape the server and every other client check use, rather
		// than the browser's stricter and differently-worded idea of an address.
		if (el.type === 'email' && !isValidEmail(el.value))
			return { field: el, message: copy.ui.form.badEmail };
	}
	return null;
}

export function AuthShell({
	title,
	blurb,
	failure,
	onSubmit,
	submitting,
	submitLabel,
	children,
	footer
}: {
	title: string;
	blurb: string;
	/** The page's own corner slot, so one form never holds two refusals. */
	failure: ErrorSlot;
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
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					const problem = firstProblem(e.currentTarget);
					if (problem) {
						failure.show(problem.message);
						// The sentence says what is wrong; the focus says where.
						problem.field.focus();
						return;
					}
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
