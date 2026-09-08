import type { ReactNode } from 'react';

/**
 * The frame shared by log in and register: centred card, heading, error slot,
 * and the alternate-action line underneath. Both pages are the same shape, so
 * the shape lives here and each page supplies only its fields.
 */
export function AuthShell({
	title,
	blurb,
	error,
	onSubmit,
	submitting,
	submitLabel,
	children,
	footer
}: {
	title: string;
	blurb: string;
	error: string | null;
	onSubmit: () => void;
	submitting: boolean;
	submitLabel: string;
	children: ReactNode;
	footer: ReactNode;
}) {
	return (
		<div className="grid place-items-center px-6 py-16">
			<div className="w-full max-w-sm rounded-lg border border-line bg-surface p-8 shadow-card">
				<h2 className="text-[1.6rem]">{title}</h2>
				<p className="mt-1.5 mb-6 text-ink-soft">{blurb}</p>

				{error && (
					// Announced politely so a screen reader hears the failure without
					// the user having to go looking for it.
					<p role="alert" className="mb-4 rounded bg-warn-soft px-3 py-2 text-sm text-warn">
						{error}
					</p>
				)}

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
						className="mt-1 w-full rounded bg-accent px-4 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{submitting ? 'Working...' : submitLabel}
					</button>
				</form>

				<p className="mt-5 text-center text-[0.88rem] text-ink-soft">{footer}</p>
			</div>
		</div>
	);
}

/**
 * A labelled input. The label is always present rather than a placeholder that
 * vanishes at the first keystroke, and `hint` is for a rule the value has to
 * keep satisfying, which is exactly when a placeholder would be gone.
 */
export function Field({
	label,
	hint,
	...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<label className="flex flex-col gap-1.5 text-sm font-medium text-ink-soft">
			{label}
			<input
				{...input}
				className="rounded border border-line bg-surface px-3 py-2.5 font-normal text-ink outline-none focus:border-accent"
			/>
			{hint && <span className="text-[0.78rem] font-normal text-ink-faint">{hint}</span>}
		</label>
	);
}
