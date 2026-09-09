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

export function FieldShell({
	label,
	hint,
	htmlFor,
	className = '',
	children
}: {
	label: string;
	hint?: string;
	/** Set when the control is not a descendant, so the label still targets it. */
	htmlFor?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<label htmlFor={htmlFor} className={`field ${className}`}>
			<span>{label}</span>
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
 * still work without a second component.
 */
export function Field({
	label,
	hint,
	className = '',
	inputClassName = '',
	...input
}: {
	label: string;
	hint?: string;
	className?: string;
	inputClassName?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<FieldShell label={label} hint={hint} className={className}>
			<input {...input} className={`input ${inputClassName}`} />
		</FieldShell>
	);
}
