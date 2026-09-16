import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useMutation } from '../hooks/useMutation';
import { useAuth } from '../auth';
import Select from '../components/ui/Select';
import FormError from '../components/ui/FormError';
import { useToast } from '../components/ui/Toast';
import { Field, FieldShell } from '../components/ui/Field';
import { copy } from '../copy';

const ca = copy.account;

type AccountData = {
	profile: { name: string; email: string; homeTz: string };
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

	return (
		<main className="mx-auto flex w-full max-w-[34rem] flex-col gap-5 px-6 pt-10 pb-16">
			<header>
				<h1 className="text-title">{ca.heading}</h1>
			</header>

			{/* The load, not a result: with no data there is nothing else on the
			    page, so this one stays where the page is. */}
			{error && <FormError message={error} variant="banner" />}
			{loading && !data && <p className="muted">{ca.loading}</p>}

			{data && (
				<>
					{/* Keyed on the loaded values so a reload after a save reseeds the
					    fields instead of leaving the form showing what was typed. */}
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

	const zones = data.timeZones.map((tz) => ({
		value: tz,
		label: tz.replace(/_/g, ' ')
	}));

	const save = useMutation(
		async () => {
			await api('/account/profile', {
				method: 'PATCH',
				body: { name, email, homeTz }
			});
			toast.success(ca.profile.saved);
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
				<FieldShell label={ca.profile.timeZoneLabel}>
					<Select
						value={homeTz}
						onChange={setHomeTz}
						options={zones}
						ariaLabel={ca.profile.timeZoneAriaLabel}
					/>
				</FieldShell>
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
