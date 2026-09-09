import { useLiveStatus } from '../useTripEvents';
import { LinkButton } from './buttons';

/**
 * The only thing the live stream ever says out loud.
 *
 * A stream dropping and coming back is ordinary, happens on every laptop lid
 * and every server restart, and is none of the reader's business: a spinner or
 * a banner for it would be noise that trains people to ignore banners. So
 * `connecting`, `live` and `retrying` all render nothing.
 *
 * `off` is different. It means this page will not update itself any more, and
 * silently showing stale data as though it were live is the one outcome worth
 * interrupting for. Said in one quiet muted line, with the thing that fixes it.
 */
export default function LiveOff() {
	const events = useLiveStatus();
	if (!events || events.status !== 'off') return null;

	return (
		<p className="muted mb-4 flex flex-wrap items-center gap-2 text-[0.82rem]">
			<span aria-hidden="true">•</span>
			Live updates are off, so changes other people make will not appear on their own.
			<LinkButton onClick={events.retry}>Reconnect</LinkButton>
		</p>
	);
}
