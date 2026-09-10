import type { ReactNode } from 'react';
import FormError from './FormError';
import { copy } from '../../copy';

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

				<FormError message={error} variant="banner" />

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

				<p className="mt-5 text-center text-[0.88rem] text-ink-soft">{footer}</p>
			</div>
		</div>
	);
}
