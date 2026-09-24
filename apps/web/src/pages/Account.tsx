import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useMutation } from '../hooks/useMutation';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { useAuth } from '../auth';
import TimeZonePicker from '../components/ui/TimeZonePicker';
import LoadError from '../components/ui/LoadError';
import Loading from '../components/ui/Loading';
import { useToast } from '../components/ui/Toast';
import { Field } from '../components/ui/Field';
import { copy } from '../copy';

const ca = copy.account;

type AccountData = {
	profile: {
		name: string;
		email: string;
		homeTz: string;
		/** An address this account asked to move to and has not confirmed yet. */
		pendingEmail?: string | null;
	};
	timeZones: string[];
};

/**
 * Account settings: the profile the app greets you by, and the password you
 * sign in with. Two independent forms rather than one, because they fail for
 * unrelated reasons and a wrong current password should not discard a name
 * change typed at the same time. Each reports its own result, which is now a
 * toast: the confirmation is about the save, not about the form, and saving a
 * new email remounts the form under it.
 */
export default function Account() {
	const { data, error, loading, reload } = useApi<AccountData>('/account');
	useDocumentTitle([ca.heading]);

	return (
		<main className="mx-auto flex w-full max-w-[34rem] flex-col gap-5 px-6 pt-10 pb-16">
			<header>
				<h1 className="text-title">{ca.heading}</h1>
			</header>

			{/* The reason goes to the corner. The panel only appears when there is
			    nothing else on the page: a reload that fails under a loaded form is
			    a result, not a missing page. */}
			{error && <LoadError message={error} onRetry={reload} panel={!data} />}
			{loading && !data && <Loading />}

			{data && (
				<>
					{/* Keyed on the loaded address so a reload after a save reseeds the
					    fields instead of leaving the form showing what was typed. Not on
					    the pending address: the notice about it is a live region, and
					    remounting would replace it with one that has nothing to announce. */}
					<Profile key={data.profile.email} data={data} onSaved={reload} />
					<Password />
				</>
			)}
		</main>
	);
}

function Profile({ data, onSaved }: { data: AccountData; onSaved: () => void }) {
	const { refresh } = useAuth();
	const toast = useToast();
	const [name, setName] = useState(data.profile.name);
	const [email, setEmail] = useState(data.profile.email);
	const [homeTz, setHomeTz] = useState(data.profile.homeTz);
	const [currentPassword, setCurrentPassword] = useState('');

	/* The email is the account's sign-in identity and the key trip invites are
	 * matched on, so the server asks for the current password before it will
	 * move it (see `PATCH /account/profile`). The field appears only once the
	 * address actually differs: asking for a password to rename yourself would
	 * be a toll on the common case for the sake of the rare one. Compared the
	 * way the server compares, trimmed and case-folded, so retyping the same
	 * address in capitals is not a change. */
	const changingEmail = email.trim().toLowerCase() !== data.profile.email.toLowerCase();
	const pending = data.profile.pendingEmail ?? null;

	const save = useMutation(
		async () => {
			const res = await api<{ pendingEmail?: string | null }>('/account/profile', {
				method: 'PATCH',
				body: changingEmail ? { name, email, homeTz, currentPassword } : { name, homeTz }
			});
			// A 202 names the address a link went to: nothing about the email has
			// changed yet, so the field goes back to the address that still signs
			// in, and the notice under it says where to look. The notice is the
			// result, so a "Profile saved." beside it would say it twice.
			if (res?.pendingEmail) {
				setEmail(data.profile.email);
				setCurrentPassword('');
			} else {
				toast.success(ca.profile.saved);
			}
			// The top bar renders the session user, not this form, so it has to be
			// told the name it is showing has changed.
			await refresh();
			onSaved();
		},
		{ fallback: ca.profile.fallback, onError: toast.error }
	);

	return (
		<section className="card p-6">
			<h2 className="mb-4 text-section">{ca.profile.heading}</h2>
			<form className="flex flex-col gap-3.5" onSubmit={save.submit}>
				<Field
					label={ca.profile.nameLabel}
					type="text"
					autoComplete="name"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<Field
					label={ca.profile.emailLabel}
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				{/* A live region so the notice is read out when a save produces it.
				    Rendered from the loaded profile rather than the save's response,
				    so it is still there after a reload, for as long as the link is
				    waiting to be opened. `sr-only` while empty rather than absent: a
				    region has to exist before its text arrives to be announced, and
				    out of the flow it adds no gap to the form. */}
				<p role="status" className={pending ? 'muted -mt-1.5 text-meta' : 'sr-only'}>
					{pending ? ca.profile.emailPending(pending) : ''}
				</p>
				{changingEmail && (
					<Field
						label={ca.profile.currentPasswordLabel}
						type="password"
						autoComplete="current-password"
						required
						value={currentPassword}
						onChange={(e) => setCurrentPassword(e.target.value)}
					/>
				)}
				<TimeZonePicker
					label={ca.profile.timeZoneLabel}
					ariaLabel={ca.profile.timeZoneAriaLabel}
					zones={data.timeZones}
					value={homeTz}
					onChange={setHomeTz}
					noMatches={ca.profile.timeZoneNoMatches}
				/>
				<button className="btn primary mt-1 self-start" type="submit" disabled={save.busy}>
					{save.busy ? copy.common.saving : copy.common.save}
				</button>
			</form>
		</section>
	);
}

function Password() {
	const toast = useToast();
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');

	const save = useMutation(
		async () => {
			await api('/account/password', {
				method: 'POST',
				body: { current, next, confirm }
			});
			toast.success(ca.password.updated);
			// Clearing on success matters more here than elsewhere: these are live
			// credentials sitting in a form the next person at the desk can read.
			setCurrent('');
			setNext('');
			setConfirm('');
		},
		{ fallback: ca.password.fallback, onError: toast.error }
	);

	return (
		<section className="card p-6">
			<h2 className="mb-4 text-section">{ca.password.heading}</h2>
			<form className="flex flex-col gap-3.5" onSubmit={save.submit}>
				<Field
					label={ca.password.currentLabel}
					type="password"
					autoComplete="current-password"
					required
					value={current}
					onChange={(e) => setCurrent(e.target.value)}
				/>
				<Field
					label={ca.password.newLabel}
					type="password"
					autoComplete="new-password"
					hint={ca.password.newHint}
					required
					value={next}
					onChange={(e) => setNext(e.target.value)}
				/>
				<Field
					label={ca.password.confirmLabel}
					type="password"
					autoComplete="new-password"
					required
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
				/>
				<button className="btn primary mt-1 self-start" type="submit" disabled={save.busy}>
					{save.busy ? copy.common.saving : copy.common.save}
				</button>
			</form>
		</section>
	);
}
