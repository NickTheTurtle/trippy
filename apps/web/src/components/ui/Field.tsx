/**
 * The shared labelled-field pair.
 *
 * Four pages had each written their own `Field` plus their own `INPUT` class
 * string, so the same form control came out at three different label sizes and
 * four different corner radii depending on which page you were on. The visual
 * spec now lives in `.field` and `.input` in `index.css`; these two components
 * are only the markup.
 *
 * `FieldShell` wraps an arbitrary control, which is what a Select or a custom
 * widget needs. `Field` is the common case of a plain text input.
 */
import type React from 'react';
import { copy } from '../../copy';

export function FieldShell({
	label,
	optional = false,
	hint,
	htmlFor,
	className = '',
	children
}: {
	label: React.ReactNode;
	/** Appends the house "(optional)" suffix. Never say it in a placeholder. */
	optional?: boolean;
	hint?: string;
	/** Set when the control is not a descendant, so the label still targets it. */
	htmlFor?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<label htmlFor={htmlFor} className={`field ${className}`}>
			<span>
				{label}
				{optional && <span className="foptional">{copy.ui.field.optionalSuffix}</span>}
			</span>
			{children}
			{/* A hint is for a rule the value has to keep satisfying, which is
			    exactly when a placeholder would already be gone. */}
			{hint && <span className="fhint">{hint}</span>}
		</label>
	);
}

/**
 * `value`/`onChange` are passed straight through as input props rather than as
 * a `(v: string) => void`, so an uncontrolled input, a checkbox or a `ref` all
 * still work without a second component. `ComponentPropsWithRef` rather than
 * `InputHTMLAttributes` is what makes that last one true for the type checker
 * as well: React 19 passes `ref` through as an ordinary prop, so the spread
 * below already forwarded it at runtime.
 */
export function Field({
	label,
	optional = false,
	hint,
	className = '',
	inputClassName = '',
	...input
}: {
	label: React.ReactNode;
	/** Appends the house "(optional)" suffix. Never say it in a placeholder. */
	optional?: boolean;
	hint?: string;
	className?: string;
	inputClassName?: string;
} & React.ComponentPropsWithRef<'input'>) {
	return (
		<FieldShell label={label} optional={optional} hint={hint} className={className}>
			<input {...input} className={`input ${inputClassName}`} />
		</FieldShell>
	);
}
