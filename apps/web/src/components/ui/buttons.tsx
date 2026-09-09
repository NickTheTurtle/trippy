import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * The two button shapes that pages kept re-declaring locally.
 *
 * `LinkBtn` existed verbatim, twice, at the bottom of `Expenses` and `Pretrip`,
 * and the icon button existed as a local `IconBtn` in `Pretrip` plus the same
 * class string written out by hand in `Expenses`. Neither is a new style: the
 * looks still come from `.link` and `.btn.small.icon.quiet` in `index.css`.
 *
 * What is shared here is the markup that goes with them: that an icon button
 * says what it does through `aria-label` and `title`, since its label is a
 * glyph a screen reader cannot read out, and that both default to
 * `type="button"`, which a couple of hand-written copies had left off. A button
 * with no type is a submit button, which is a live bug the moment one of them
 * ends up inside a form.
 */

type ButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'children'>;

/** A text-only action. For anything a full button would out-shout. */
export function LinkButton({
	className = '',
	danger = false,
	children,
	...rest
}: ButtonProps & {
	className?: string;
	/** Red, for a text-only destructive action. */
	danger?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			{...rest}
			className={['link', danger ? 'danger' : '', className].filter(Boolean).join(' ')}
		>
			{children}
		</button>
	);
}

/** A square glyph button. `label` is the accessible name, not decoration. */
export function IconButton({
	label,
	danger = false,
	className = '',
	children,
	...rest
}: ButtonProps & {
	label: string;
	danger?: boolean;
	/** For per-row extras such as the hover-reveal utilities. */
	className?: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			{...rest}
			className={['btn small icon quiet', danger ? 'danger' : '', className]
				.filter(Boolean)
				.join(' ')}
		>
			{children}
		</button>
	);
}
