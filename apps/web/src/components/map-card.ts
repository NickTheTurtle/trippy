import type { MapItem, MapTrack } from './GoogleMap';
import { copy } from '../copy';

const SVG = 'http://www.w3.org/2000/svg';

/** The warning triangle from `icons.tsx`, as DOM rather than as JSX. */
function warnIcon(): SVGElement {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('width', '13');
	svg.setAttribute('height', '13');
	const stroke = (d: string) => {
		const p = document.createElementNS(SVG, 'path');
		p.setAttribute('d', d);
		p.setAttribute('fill', 'none');
		p.setAttribute('stroke', 'currentColor');
		p.setAttribute('stroke-width', '1.5');
		p.setAttribute('stroke-linejoin', 'round');
		p.setAttribute('stroke-linecap', 'round');
		return p;
	};
	svg.append(stroke('M8 2.6L14.5 13.4H1.5L8 2.6z'), stroke('M8 6.6v3'));
	const dot = document.createElementNS(SVG, 'circle');
	dot.setAttribute('cx', '8');
	dot.setAttribute('cy', '11.6');
	dot.setAttribute('r', '0.85');
	dot.setAttribute('fill', 'currentColor');
	svg.append(dot);
	return svg;
}

/**
 * The card a pin opens when it is pointed at.
 *
 * One builder for both maps. A reader with a Maps key and a reader without one
 * are reading the same trip, and the keyless fallback drifting into a different
 * card is a difference nobody asked for.
 *
 * Four parts, in the order the question is asked: which track this pin belongs
 * to, what it is called, what it is and when, then the facts that only matter
 * once you have decided you care. The track name leads and carries the track's
 * own colour, because the colour is the only thing tying a card to the pin
 * underneath it, and a reader should not have to learn a code to use a map.
 *
 * A pin can hold more than one thing, because more than one thing can be at one
 * address. It is given every item at its point rather than the first, so the
 * others stop being unreachable.
 *
 * Built as DOM rather than as an HTML string. Every line on it is typed by a
 * trip member and a track colour comes back from the API as member-editable
 * text, so interpolating any of it into markup would let somebody close an
 * attribute and inject tags. `style.color` is set through the CSSOM, which
 * refuses anything that is not a colour.
 */
export function mapCard(
	items: MapItem[],
	track: Pick<MapTrack, 'name' | 'color'>,
	onAdd?: (poiId: string) => void
): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'mapcard';

	const eyebrow = document.createElement('em');
	eyebrow.className = 'mapcard-track';
	eyebrow.style.color = track.color;
	eyebrow.textContent = track.name;
	wrap.append(eyebrow);

	/* One pin, so one card, exactly as before. Several, and each gets the same
	   block under the one eyebrow: the track is what they have in common, and
	   repeating it per entry would say nothing and cost a line each. The list
	   scrolls rather than growing, so a venue with nine things on it cannot
	   push a card taller than the window. */
	const list = document.createElement('div');
	list.className = items.length > 1 ? 'mapcard-list' : 'mapcard-one';
	wrap.append(list);

	for (const item of items) {
		const entry = document.createElement('div');
		entry.className = 'mapcard-entry';
		list.append(entry);

		const title = document.createElement('strong');
		title.textContent = item.title;
		entry.append(title);

		const row = (text: string, className?: string) => {
			const span = document.createElement('span');
			if (className) span.className = className;
			span.textContent = text;
			entry.append(span);
			return span;
		};

		if (item.subtitle) row(item.subtitle, 'mapcard-sub');
		for (const line of item.detail ?? []) row(line);
		if (item.warn) {
			const warn = row(item.warn, 'mapcard-warn');
			warn.prepend(warnIcon());
		}
		/* The one thing a card can do. Only an unplanned place carries it, which
		   is what `addId` means, so a card either offers the day's next stop or
		   is a plain read. The whole card claims the pointer once it does, since
		   a button the pointer cannot reach is not a button. */
		if (item.addId && onAdd) {
			const id = item.addId;
			const add = document.createElement('button');
			add.type = 'button';
			add.className = 'mapcard-add';
			add.textContent = copy.ui.mapCard.add;
			add.addEventListener('click', (e) => {
				e.stopPropagation();
				onAdd(id);
			});
			entry.append(add);
			wrap.classList.add('mapcard-act');
		}
	}

	return wrap;
}

/**
 * Where to put the card for an event that may not have come from a pointer.
 *
 * Both maps make their markers reachable by keyboard, and the click a keyboard
 * sends has no useful coordinates: reading `clientX` off it puts the card in
 * the top-left corner of the window, nowhere near the pin it belongs to. So the
 * marker's own element is measured instead, which is where a reader tabbing
 * through the pins is looking.
 */
export function cardAnchor(
	domEvent: { clientX?: number; clientY?: number } | undefined,
	el: Element | null | undefined
): { x: number; y: number } {
	if (domEvent && (domEvent.clientX || domEvent.clientY)) {
		return { x: domEvent.clientX ?? 0, y: domEvent.clientY ?? 0 };
	}
	const box = el?.getBoundingClientRect?.();
	if (box) return { x: box.left + box.width / 2, y: box.top };
	return { x: 0, y: 0 };
}

/** How far the card sits from the pointer, and how close it may come to an edge. */
const GAP = 18;
const EDGE = 8;
/**
 * How long a hovered card waits before leaving.
 *
 * A card that offers an action has to be reachable, and the pointer gets there
 * by crossing the gap between the pin and the card, which is over the map: the
 * pin's `mouseout` fires on the way. Long enough to cross 18px, short enough
 * that a card the reader has moved away from is gone before it is noticed.
 */
const GRACE = 160;

/**
 * Where a hover card is drawn.
 *
 * Both map libraries offer their own bubble, and both draw it inside the map
 * element, anchored above the pin, with no idea that anything is in the way.
 * A pin near the top of a small map therefore opened a card with its first two
 * lines cut off by the map's own overflow, and a pin near a side lost its right
 * edge. Google's cure for that is to pan the map, which slides the pin out from
 * under the pointer and closes the card it just opened.
 *
 * So the card is drawn by the app instead: one fixed-position layer on the body,
 * outside every scroll box, placed from the pointer and clamped to the window.
 * It flips below the pointer when there is no room above, which is the same
 * behaviour the app's menus already have. It never takes the pointer, so moving
 * onto it is impossible and hovering the pin under it still works.
 *
 * A phone has no hover, so both maps open it on click too: a tap is the only way
 * to read a pin there, and a tap on the map behind it is what puts it away.
 */
export function createCardLayer() {
	let el: HTMLDivElement | null = null;
	/* Whether the open card was asked for rather than hovered into. A hovered
	   card leaves the moment the pointer leaves its pin, which is right for a
	   glance and wrong for a pin holding nine things: the list under the pointer
	   cannot be read, let alone scrolled, if it disappears on the way to it. So
	   a click keeps it, and only a click on the map, on another pin, or a redraw
	   that takes its pin away puts it back. */
	let held = false;
	/** A hide waiting out `GRACE`, cancelled if the pointer arrives on the card. */
	let pending: ReturnType<typeof setTimeout> | null = null;

	const stopPending = () => {
		if (pending === null) return;
		clearTimeout(pending);
		pending = null;
	};
	const clear = () => {
		stopPending();
		held = false;
		if (el) el.replaceChildren();
	};

	const layer = () => {
		if (!el) {
			el = document.createElement('div');
			el.className = 'mapcardlayer';
			document.body.appendChild(el);
		}
		return el;
	};

	return {
		show(card: HTMLElement, x: number, y: number, hold = false) {
			const host = layer();
			stopPending();
			held = hold;
			/* The card keeps itself alive while the pointer is on it, and leaves
			   when the pointer leaves. Only a card carrying an action ever gets
			   the pointer, so for every other card these never fire. */
			card.addEventListener('mouseenter', stopPending);
			card.addEventListener('mouseleave', () => {
				if (!held) clear();
			});
			host.replaceChildren(card);
			/* Measured after mounting rather than guessed: the card is as tall as
			   the trip made it, and the flip depends on knowing that. */
			host.style.visibility = 'hidden';
			host.style.left = '0px';
			host.style.top = '0px';
			const { width, height } = host.getBoundingClientRect();
			const above = y - GAP - height;
			const top = above >= EDGE ? above : Math.min(y + GAP, window.innerHeight - EDGE - height);
			const left = Math.min(
				Math.max(EDGE, x - width / 2),
				Math.max(EDGE, window.innerWidth - EDGE - width)
			);
			host.style.left = `${Math.round(left)}px`;
			host.style.top = `${Math.round(Math.max(EDGE, top))}px`;
			host.style.visibility = 'visible';
		},
		/** `force` closes a held card: the map was clicked, or the pin is gone. */
		hide(force = false) {
			if (held && !force) return;
			if (force) {
				clear();
				return;
			}
			stopPending();
			pending = setTimeout(clear, GRACE);
		},
		destroy() {
			stopPending();
			el?.remove();
			el = null;
			held = false;
		}
	};
}
