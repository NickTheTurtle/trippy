import type { ElementType, ReactNode } from 'react';
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
 * `as` is the element to render, because the same behaviour is wanted by a card
 * grid and by a list of rows, and a `<ul>` whose children are wrapped in a div
 * is no longer a list to a screen reader.
 *
 * `signature` must change exactly when the layout could have: the hook reads a
 * rect per child, which forces layout, so it is not something to do per render.
 */
export default function FlipGrid({
	signature,
	as: Tag = 'div',
	className,
	children
}: {
	signature: string;
	as?: ElementType;
	className?: string;
	children: ReactNode;
}) {
	const ref = useFlip<HTMLElement>(signature);
	return (
		<Tag ref={ref} className={className}>
			{children}
		</Tag>
	);
}
