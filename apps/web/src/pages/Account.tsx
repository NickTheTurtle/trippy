import { useState } from 'react';
import { api } from '../api';
import { useApi } from '../useApi';
import { useMutation } from '../useMutation';
import { useAuth } from '../auth';
import Select from '../components/Select';
import FormError from '../components/FormError';
import { Field, FieldShell } from '../components/Field';

type AccountData = {
	profile: { name: string; email: string; homeTz: string };
	timeZones: string[];
};

/**
 * Account settings: the profile the app greets you by, and the password you
 * sign in with. Two independent forms rather than one, because they fail for
 * unrelated reasons and a wrong current password should not discard a name
 * change typed at the same time. Each keeps its own message for that reason.
 */
export default function Account() {
	const { data, error, loading, reload } = useApi<AccountData>('/account');

	return (
		<main className="mx-auto flex w-full max-w-[34rem] flex-col gap-5 px-6 pt-10 pb-16">
			<header>
				<h1 className="text-[1.7rem]">Account settings</h1>
				<p className="muted mt-1">Manage how you sign in and how times are shown to you.</p>
			</header>

			{error && <FormError message={error} variant="banner" />}
			{loading && !data && <p className="muted">Loading...</p>}

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
	const [name, setName] = useState(data.profile.name);
	const [email, setEmail] = useState(data.profile.email);
	const [homeTz, setHomeTz] = useState(data.profile.homeTz);
	/** Only the success line lives here; the failure is the mutation's own. */
	const [saved, setSaved] = useState(false);

	const zones = data.timeZones.map((tz) => ({
		value: tz,
		label: tz.replace(/_/g, ' ')
	}));

	const save = useMutation(
		async () => {
			setSaved(false);
			await api('/account/profile', {
				method: 'PATCH',
				body: { name, email, homeTz }
			});
			setSaved(true);
			// The top bar renders the session user, not this form, so it has to be
			// told the name it is showing has changed.
			await refresh();
			onSaved();
		},
		{ fallback: 'Could not save your profile.' }
	);

	return (
		<section className="card p-6">
			<h2 className="mb-4 text-[1.15rem]">Profile</h2>
			<FormError message={save.error} variant="banner" />
			<FormError
				message={saved && !save.error ? 'Profile saved.' : ''}
				tone="success"
				variant="banner"
			/>
			<form className="flex flex-col gap-3.5" onSubmit={save.submit}>
				<Field
					label="Name"
					type="text"
					autoComplete="name"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<Field
					label="Email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<FieldShell label="Home time zone">
					<Select value={homeTz} onChange={setHomeTz} options={zones} ariaLabel="Home time zone" />
				</FieldShell>
				<button className="btn primary mt-1 self-start" type="submit" disabled={save.busy}>
					{save.busy ? 'Saving...' : 'Save profile'}
				</button>
			</form>
		</section>
	);
}

function Password() {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [changed, setChanged] = useState(false);

	const save = useMutation(
		async () => {
			setChanged(false);
			await api('/account/password', {
				method: 'POST',
				body: { current, next, confirm }
			});
			setChanged(true);
			// Clearing on success matters more here than elsewhere: these are live
			// credentials sitting in a form the next person at the desk can read.
			setCurrent('');
			setNext('');
			setConfirm('');
		},
		{ fallback: 'Could not change your password.' }
	);

	return (
		<section className="card p-6">
			<h2 className="mb-4 text-[1.15rem]">Password</h2>
			<FormError message={save.error} variant="banner" />
			<FormError
				message={changed && !save.error ? 'Password updated.' : ''}
				tone="success"
				variant="banner"
			/>
			<form className="flex flex-col gap-3.5" onSubmit={save.submit}>
				<Field
					label="Current password"
					type="password"
					autoComplete="current-password"
					required
					value={current}
					onChange={(e) => setCurrent(e.target.value)}
				/>
				<Field
					label="New password"
					type="password"
					autoComplete="new-password"
					hint="At least 8 characters"
					required
					value={next}
					onChange={(e) => setNext(e.target.value)}
				/>
				<Field
					label="Confirm new password"
					type="password"
					autoComplete="new-password"
					required
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
				/>
				<button className="btn primary mt-1 self-start" type="submit" disabled={save.busy}>
					{save.busy ? 'Working...' : 'Change password'}
				</button>
			</form>
		</section>
	);
}
