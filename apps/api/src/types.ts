import type { SessionUser } from '@trippy/server/auth';
import type { getTripForUser } from '@trippy/server/trips';

/** The trip shape `requireMember` puts on the context. */
export type Trip = NonNullable<ReturnType<typeof getTripForUser>>;

/** For routes behind `requireUser` or `requireMember`, where a user is certain. */
export type Env = { Variables: { user: SessionUser; trip: Trip } };
