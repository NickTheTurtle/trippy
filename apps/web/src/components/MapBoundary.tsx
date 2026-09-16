import { Component, type ErrorInfo, type ReactNode } from 'react';
import { copy } from '../copy';

/**
 * Keeps a broken map inside its own box.
 *
 * The planner page renders a map beside the board, and a map is the one thing
 * on that page built on somebody else's SDK: it can fail for reasons the app
 * has no say in, from a refused key to a module that never arrived. Without a
 * boundary, one throw from deep inside the drawing code unmounts the whole
 * route, which is how a line that would not redraw took the schedule with it
 * and left the Add dialog unopenable.
 *
 * So the map is fenced. The rest of the planner goes on working, and the box
 * that would have held the map says it could not be drawn.
 *
 * Deliberately not offering a retry. The failures seen here are a bad key and a
 * half-loaded SDK, neither of which a second attempt in the same page fixes,
 * and a button that reliably does nothing is worse than no button. The fallback
 * that does help, the keyless renderer, is chosen by the page rather than here.
 */
export default class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// Kept in the console rather than shown: it is SDK wording, for whoever is
		// looking at why, and it is not addressed to the reader of the page.
		console.error('map failed', error, info.componentStack);
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div className="mapbox grid place-items-center">
				<p className="muted m-0 px-6 text-center text-body">{copy.ui.tripMap.failed}</p>
			</div>
		);
	}
}
