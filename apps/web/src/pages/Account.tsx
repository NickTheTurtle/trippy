import { useState } from 'react';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { useAuth } from '../auth';
import Select from '../components/Select';
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

			{error && (
				<p role="alert" className="text-warn">
					{error}
				</p>
			)}
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
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [saving, setSaving] = useState(false);

	const zones = data.timeZones.map((tz) => ({
		value: tz,
		label: tz.replace(/_/g, ' ')
	}));

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setMsg(null);
		try {
			await api('/account/profile', {
				method: 'PATCH',
				body: { name, email, homeTz }
			});
			setMsg({ ok: true, text: 'Profile saved.' });
			// The top bar renders the session user, not this form, so it has to be
			// told the name it is showing has changed.
			await refresh();
			onSaved();
		} catch (err) {
			setMsg({
				ok: false,
				text: err instanceof ApiError ? err.message : 'Could not save your profile.'
			});
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="card p-6">
			<h2 className="mb-4 text-[1.15rem]">Profile</h2>
			<Message msg={msg} />
			<form className="flex flex-col gap-3.5" onSubmit={submit}>
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
				<button className="btn primary mt-1 self-start" type="submit" disabled={saving}>
					{saving ? 'Saving...' : 'Save profile'}
				</button>
			</form>
		</section>
	);
}

function Password() {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [saving, setSaving] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setMsg(null);
		try {
			await api('/account/password', {
				method: 'POST',
				body: { current, next, confirm }
			});
			setMsg({ ok: true, text: 'Password updated.' });
			// Clearing on success matters more here than elsewhere: these are live
			// credentials sitting in a form the next person at the desk can read.
			setCurrent('');
			setNext('');
			setConfirm('');
		} catch (err) {
			setMsg({
				ok: false,
				text: err instanceof ApiError ? err.message : 'Could not change your password.'
			});
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="card p-6">
			<h2 className="mb-4 text-[1.15rem]">Password</h2>
			<Message msg={msg} />
			<form className="flex flex-col gap-3.5" onSubmit={submit}>
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
				<button className="btn primary mt-1 self-start" type="submit" disabled={saving}>
					{saving ? 'Working...' : 'Change password'}
				</button>
			</form>
		</section>
	);
}

/** Success is polite and failure is assertive, so a screen reader interrupts
 *  only for the one the user has to act on. */
function Message({ msg }: { msg: { ok: boolean; text: string } | null }) {
	if (!msg) return null;
	return (
		<p
			role={msg.ok ? 'status' : 'alert'}
			className={[
				'mb-4 rounded px-3 py-2 text-sm',
				msg.ok ? 'bg-accent-soft text-accent-ink' : 'bg-warn-soft text-warn'
			].join(' ')}
		>
			{msg.text}
		</p>
	);
}
