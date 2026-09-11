import type { ReactNode } from 'react';
import { useFlip } from '../../hooks/useFlip';

/**
 * A container whose children animate to their new places when the order
 * changes. Children opt in with `data-flip="<stable key>"`.
 *
 * A component rather than the bare `useFlip` hook because the lists that want
 * this are ordered by data the page derives after its loading and empty
 * branches have returned, and a hook cannot be called there. Passing the
 * children in moves the hook somewhere it can be called unconditionally.
 *
 * `signature` must change exactly when the layout could have: the hook reads a
 * rect per child, which forces layout, so it is not something to do per render.
 */
export default function FlipGrid({
	signature,
	className,
	children
}: {
	signature: string;
	className?: string;
	children: ReactNode;
}) {
	const ref = useFlip<HTMLDivElement>(signature);
	return (
		<div ref={ref} className={className}>
			{children}
		</div>
	);
}
