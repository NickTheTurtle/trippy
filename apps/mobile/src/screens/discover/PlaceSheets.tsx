import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { parseMoneyToCents } from '@trippy/copy/format';
import { CURRENCY_CODES } from '@trippy/core/currency';
import { currencyName } from '@trippy/core/currency-names';
import { isStayCategory, poiKindFromCategory, POI_KINDS, type PoiKind } from '@trippy/core/types';
import { MAX_NOTES_LENGTH } from '@trippy/core/validate';
import type { PlaceHit, PlaceHitDetails, Poi, Stay } from '../../lib/api-types';
import { api, ApiError, isAbort } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Field, FormError } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { SheetFooter } from '../../ui/SheetFooter';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { Picker, SearchablePicker } from '../../ui/controls';
import { CoverImage } from './CoverImage';
import { color, fieldLabel, radius, space, type } from '../../theme';

const MIN_QUERY = 3;
const SEARCH_DEBOUNCE_MS = 600;
const STAY_VIEW = 'stay';
type AddType = PoiKind | typeof STAY_VIEW;

const TYPE_OPTIONS = [
	...POI_KINDS.map((k) => ({
		key: k,
		label: k === 'food' ? copy.discover.types.food : copy.discover.types.attraction
	})),
	{ key: STAY_VIEW, label: copy.discover.types.stay }
];
const POI_TYPE_OPTIONS = POI_KINDS.map((k) => ({
	key: k,
	label: k === 'food' ? copy.discover.types.food : copy.discover.types.attraction
}));

function newSessionToken(): string {
	const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
	return (
		cryptoLike?.randomUUID?.() ??
		`s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
	);
}

function hitKey(h: PlaceHit): string {
	return `${h.name}|${h.address ?? ''}|${h.lat}|${h.lng}`;
}

function withDetails(h: PlaceHit, d: PlaceHitDetails): PlaceHit {
	return {
		...h,
		...d,
		name: d.name ?? h.name,
		address: d.address ?? h.address,
		category: d.category || h.category,
		lat: d.lat ?? h.lat,
		lng: d.lng ?? h.lng
	};
}

function inferType(category: string | null | undefined): AddType | null {
	if (!category?.trim()) return null;
	if (isStayCategory(category)) return STAY_VIEW;
	return poiKindFromCategory(category);
}

function currencyOptions(currencies: readonly string[]) {
	const codes = currencies.length ? currencies : CURRENCY_CODES;
	return codes.map((code) => ({ key: code, label: code, detail: currencyName(code) }));
}

function TextArea({
	label,
	value,
	onChangeText
}: {
	label: string;
	value: string;
	onChangeText: (v: string) => void;
}) {
	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<TextInput
				accessibilityLabel={label}
				value={value}
				onChangeText={onChangeText}
				multiline
				maxLength={MAX_NOTES_LENGTH}
				style={{
					minHeight: 88,
					textAlignVertical: 'top',
					padding: space.md,
					borderRadius: radius.md,
					borderWidth: 1,
					borderColor: color.line,
					backgroundColor: color.surface,
					color: color.ink
				}}
			/>
		</View>
	);
}

function LinkField({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) {
	return (
		<Field
			label={`${copy.discover.placeFields.linkLabel}${copy.ui.field.optionalSuffix}`}
			value={value}
			onChangeText={onChangeText}
			placeholder={copy.discover.placeFields.linkPlaceholder}
			autoCapitalize="none"
			keyboardType="url"
		/>
	);
}

function SearchResults({ hits, onPick }: { hits: PlaceHit[]; onPick: (hit: PlaceHit) => void }) {
	if (hits.length === 0) return null;
	return (
		<View
			style={{ borderWidth: 1, borderColor: color.line, borderRadius: radius.md, maxHeight: 250 }}
		>
			<ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
				{hits.map((hit, index) => (
					<Pressable
						key={`${hitKey(hit)}-${index}`}
						onPress={() => onPick(hit)}
						style={({ pressed }) => ({
							padding: space.md,
							borderTopWidth: index === 0 ? 0 : 1,
							borderTopColor: color.line,
							backgroundColor: pressed ? color.surface2 : color.surface
						})}
					>
						<Text style={type.body}>{hit.name}</Text>
						{hit.address ? <Text style={type.faint}>{hit.address}</Text> : null}
					</Pressable>
				))}
			</ScrollView>
		</View>
	);
}

export function AddDiscoverSheet({
	open,
	base,
	city,
	provider,
	initialType,
	currency,
	currencies,
	onClose,
	onAdded
}: {
	open: boolean;
	base: string;
	city: { id: string; name: string };
	provider: 'google' | 'osm';
	initialType: AddType;
	currency: string;
	currencies: string[];
	onClose: () => void;
	onAdded: (type: AddType) => void;
}) {
	const [view, setView] = useState<AddType>(initialType);
	const [name, setName] = useState('');
	const [activity, setActivity] = useState('');
	const [price, setPrice] = useState('');
	const [cur, setCur] = useState(currency);
	const [url, setUrl] = useState('');
	const [notes, setNotes] = useState('');
	const [hit, setHit] = useState<PlaceHit | null>(null);
	const [hits, setHits] = useState<PlaceHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);
	const [searchError, setSearchError] = useState('');
	const [detailLoading, setDetailLoading] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const searchCtl = useRef<AbortController | undefined>(undefined);
	const detailCtl = useRef<AbortController | undefined>(undefined);
	const detailToken = useRef(0);
	const session = useRef<string | undefined>(undefined);
	const typeChosen = useRef(false);

	const stay = view === STAY_VIEW;

	function abortDetails() {
		detailToken.current += 1;
		detailCtl.current?.abort();
		detailCtl.current = undefined;
		setDetailLoading(false);
	}

	function unpick() {
		abortDetails();
		setHit(null);
	}
	const providerLabel =
		provider === 'google'
			? copy.discover.addDialog.providerGoogle
			: copy.discover.addDialog.providerOsm;

	useEffect(() => {
		if (!open) {
			clearTimeout(timer.current);
			searchCtl.current?.abort();
			abortDetails();
			session.current = undefined;
			return;
		}
		setView(initialType);
		setName('');
		setActivity('');
		setPrice('');
		setCur(currency);
		setUrl('');
		setNotes('');
		setHit(null);
		setHits([]);
		setSearchError('');
		setSearched(false);
		add.reset();
		typeChosen.current = false;
	}, [open, initialType, currency]);

	useEffect(
		() => () => {
			clearTimeout(timer.current);
			searchCtl.current?.abort();
			detailCtl.current?.abort();
			detailToken.current += 1;
		},
		[]
	);

	function runSearch(q: string) {
		setSearchError('');
		if (q.length < MIN_QUERY) {
			setHits([]);
			setSearched(false);
			setSearching(false);
			return;
		}
		searchCtl.current?.abort();
		const ctl = new AbortController();
		searchCtl.current = ctl;
		setSearching(true);
		session.current ??= newSessionToken();
		const params = new URLSearchParams({
			q,
			cityId: city.id,
			kind: stay ? 'stay' : 'place',
			token: session.current
		});
		api<{ results: PlaceHit[] }>(`${base}/search?${params}`, { signal: ctl.signal })
			.then((d) => {
				setHits(d.results ?? []);
				setSearched(true);
				setSearchError('');
			})
			.catch((err) => {
				if (ctl.signal.aborted || isAbort(err)) return;
				setHits([]);
				setSearched(true);
				setSearchError(err instanceof ApiError ? err.message : copy.api.requestFailed);
			})
			.finally(() => {
				if (searchCtl.current === ctl) {
					searchCtl.current = undefined;
					setSearching(false);
				}
			});
	}

	function onNameChange(value: string) {
		setName(value);
		setHit(null);
		add.reset();
		clearTimeout(timer.current);
		setSearching(value.trim().length >= MIN_QUERY);
		timer.current = setTimeout(() => runSearch(value.trim()), SEARCH_DEBOUNCE_MS);
	}

	function pick(picked: PlaceHit) {
		clearTimeout(timer.current);
		searchCtl.current?.abort();
		setSearching(false);
		setHits([]);
		setHit(picked);
		setName(picked.name);
		setUrl(picked.url ?? '');
		setNotes((v) => v || (stay ? '' : (picked.address ?? '')));
		const pickedType = inferType(picked.category);
		if (!typeChosen.current && pickedType) setView(pickedType);
		const sessionId = session.current;
		session.current = undefined;
		if (!picked.id || (picked.rating !== null && picked.photo)) return;
		detailCtl.current?.abort();
		const ctl = new AbortController();
		detailCtl.current = ctl;
		const token = (detailToken.current += 1);
		setDetailLoading(true);
		const params = new URLSearchParams({ id: picked.id });
		if (sessionId) params.set('token', sessionId);
		api<{ details: PlaceHitDetails | null }>(`${base}/details?${params}`, { signal: ctl.signal })
			.then((d) => {
				if (token !== detailToken.current || !d.details) return;
				const merged = withDetails(picked, d.details);
				setHit(merged);
				setUrl((v) => v || (merged.url ?? ''));
				setNotes((v) => v || (stay ? '' : (merged.address ?? '')));
				const mergedType = inferType(merged.category);
				if (!typeChosen.current && mergedType) setView(mergedType);
			})
			.catch(() => {})
			.finally(() => {
				if (token === detailToken.current) setDetailLoading(false);
			});
	}

	function changeType(next: string) {
		clearTimeout(timer.current);
		const value = next as AddType;
		typeChosen.current = true;
		if ((value === STAY_VIEW) !== stay) {
			setHit(null);
			setHits([]);
			setSearchError('');
			setSearched(false);
			searchCtl.current?.abort();
			session.current = undefined;
		}
		setView(value);
	}

	const add = useMutation<[number | null]>(
		async (cents) => {
			if (stay) {
				await api(`${base}/stays`, {
					method: 'POST',
					body: {
						cityId: city.id,
						name: name.trim(),
						priceCents: cents,
						currency: cur,
						notes: notes.trim(),
						url: url.trim(),
						photo: hit?.photo ?? null,
						lat: hit?.lat ?? null,
						lng: hit?.lng ?? null
					}
				});
				return;
			}
			await api(`${base}/pois`, {
				method: 'POST',
				body: {
					cityId: city.id,
					name: name.trim(),
					activity: activity.trim(),
					category: hit?.category ?? '',
					kind: view,
					notes: notes.trim(),
					url: url.trim(),
					photo: hit?.photo ?? null,
					lat: hit?.lat ?? null,
					lng: hit?.lng ?? null,
					rating: hit?.rating ?? null,
					ratingCount: hit?.ratingCount ?? null,
					priceLevel: hit?.priceLevel ?? null,
					hours: hit?.hours ?? null
				}
			});
		},
		{ fallback: copy.discover.addDialog.fallback, onSuccess: () => onAdded(view) }
	);

	function submit() {
		if (!name.trim()) return add.setError(copy.ui.form.missing);
		if (!stay) return void add.run(null);
		const cents = parseMoneyToCents(price);
		if (cents === 'bad') return add.setError(copy.discover.addDialog.badPrice);
		void add.run(cents);
	}

	const message =
		name.trim().length < MIN_QUERY
			? copy.discover.addDialog.keepTyping
			: searching || detailLoading
				? copy.discover.addDialog.searching
				: searchError ||
					(searched && hits.length === 0 ? copy.discover.addDialog.noMatches(name.trim()) : '');

	return (
		<Sheet open={open} title={copy.discover.addDialog.title} subtitle={city.name} onClose={onClose}>
			<Field
				label={copy.discover.addDialog.nameLabel}
				value={name}
				onChangeText={onNameChange}
				autoCorrect={false}
			/>
			{message ? (
				<Text style={searchError ? { ...type.small, color: color.dangerInk } : type.faint}>
					{message}
				</Text>
			) : null}
			<SearchResults hits={hits.slice(0, 6)} onPick={pick} />
			<Text style={{ ...type.faint, textAlign: 'right' }}>
				{copy.discover.addDialog.attribution(providerLabel)}
			</Text>
			{hit ? (
				<View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
					<View style={{ width: 72 }}>
						<CoverImage photo={hit.photo} seed={hit.name} category={hit.category} height={52} />
					</View>
					<View style={{ flex: 1 }}>
						<Text style={type.body}>{hit.name}</Text>
						{hit.address ? <Text style={type.faint}>{hit.address}</Text> : null}
					</View>
					<Pressable onPress={unpick} hitSlop={8}>
						<Text style={{ ...type.small, color: color.accent }}>
							{copy.discover.addDialog.notThisOne}
						</Text>
					</Pressable>
				</View>
			) : null}
			<Picker
				label={copy.discover.placeFields.typeLabel}
				options={TYPE_OPTIONS}
				value={view}
				onPick={changeType}
			/>
			{stay ? (
				<View style={{ gap: space.md }}>
					<Field
						label={`${copy.discover.addDialog.priceLabel}${copy.ui.field.optionalSuffix}`}
						value={price}
						onChangeText={setPrice}
						keyboardType="decimal-pad"
					/>
					<SearchablePicker
						label={copy.discover.addDialog.currencyLabel}
						value={cur}
						options={currencyOptions(currencies)}
						onPick={setCur}
						noMatches={copy.ui.currencyPicker.noMatches}
					/>
				</View>
			) : (
				<Field
					label={`${copy.discover.addDialog.activityLabel}${copy.ui.field.optionalSuffix}`}
					value={activity}
					onChangeText={setActivity}
				/>
			)}
			<LinkField value={url} onChangeText={setUrl} />
			<TextArea
				label={`${copy.discover.placeFields.notesLabel}${copy.ui.field.optionalSuffix}`}
				value={notes}
				onChangeText={setNotes}
			/>
			<FormError message={add.error} />
			<SheetFooter
				primaryLabel={copy.common.add}
				primaryBusyLabel={copy.common.adding}
				primaryBusy={add.busy}
				primaryDisabled={detailLoading}
				onPrimary={submit}
			/>
		</Sheet>
	);
}

export function EditPlaceSheet({
	open,
	base,
	poi,
	onClose,
	onSaved,
	onDeleted
}: {
	open: boolean;
	base: string;
	poi: Poi | null;
	onClose: () => void;
	onSaved: () => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState('');
	const [kind, setKind] = useState<PoiKind>('attraction');
	const [url, setUrl] = useState('');
	const [notes, setNotes] = useState('');
	const [confirm, setConfirm] = useState(false);

	useEffect(() => {
		if (!open || !poi) return;
		setName(poi.name);
		setKind(poi.kind);
		setUrl(poi.url ?? '');
		setNotes(poi.notes ?? '');
		setConfirm(false);
	}, [open, poi]);

	const save = useMutation(
		() =>
			api(`${base}/pois/${poi?.id}`, {
				method: 'PATCH',
				body: { name: name.trim(), kind, url: url.trim(), notes: notes.trim() }
			}),
		{ fallback: copy.discover.editPlace.fallback, onSuccess: onSaved }
	);
	const remove = useMutation(() => api(`${base}/pois/${poi?.id}`, { method: 'DELETE' }), {
		fallback: copy.ui.confirmDialog.fallback,
		onSuccess: () => {
			setConfirm(false);
			onDeleted();
		}
	});

	return (
		<>
			<Sheet open={open && !confirm} title={copy.discover.editPlace.title} onClose={onClose}>
				<Field label={copy.discover.editPlace.nameLabel} value={name} onChangeText={setName} />
				<Picker
					label={copy.discover.placeFields.typeLabel}
					options={POI_TYPE_OPTIONS}
					value={kind}
					onPick={(v) => setKind(v as PoiKind)}
				/>
				<LinkField value={url} onChangeText={setUrl} />
				<TextArea
					label={`${copy.discover.placeFields.notesLabel}${copy.ui.field.optionalSuffix}`}
					value={notes}
					onChangeText={setNotes}
				/>
				{poi ? (
					<Text style={type.faint}>
						{copy.discover.editPlace.votes(poi.votes)}
						{copy.discover.editPlace.voters(poi.voters)}
					</Text>
				) : null}
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={copy.common.save}
					primaryBusyLabel={copy.common.saving}
					primaryBusy={save.busy}
					onPrimary={() => void save.run()}
					destructiveLabel={poi ? copy.common.deleteLabel(poi.name) : copy.common.delete}
					onDestructive={() => setConfirm(true)}
				/>
			</Sheet>
			<ConfirmSheet
				open={!!poi && confirm}
				title={
					poi && poi.linked > 0
						? copy.discover.deletePlace.linkedTitle(poi.name, poi.linked)
						: poi
							? copy.common.deleteTitle(poi.name)
							: ''
				}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirm(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}

export function EditStaySheet({
	open,
	base,
	stay,
	currency,
	currencies,
	onClose,
	onSaved,
	onDeleted
}: {
	open: boolean;
	base: string;
	stay: Stay | null;
	currency: string;
	currencies: string[];
	onClose: () => void;
	onSaved: () => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState('');
	const [price, setPrice] = useState('');
	const [cur, setCur] = useState(currency);
	const [url, setUrl] = useState('');
	const [notes, setNotes] = useState('');
	const [confirm, setConfirm] = useState(false);

	useEffect(() => {
		if (!open || !stay) return;
		setName(stay.name);
		setPrice(stay.price_cents == null ? '' : String(stay.price_cents / 100));
		setCur(stay.currency || currency);
		setUrl(stay.url ?? '');
		setNotes(stay.tag);
		setConfirm(false);
	}, [open, stay, currency]);

	const save = useMutation<[number | null]>(
		(cents) =>
			api(`${base}/stays/${stay?.id}`, {
				method: 'PATCH',
				body: {
					name: name.trim(),
					priceCents: cents,
					currency: cur,
					url: url.trim(),
					notes: notes.trim()
				}
			}),
		{ fallback: copy.discover.editStay.fallback, onSuccess: onSaved }
	);
	const remove = useMutation(() => api(`${base}/stays/${stay?.id}`, { method: 'DELETE' }), {
		fallback: copy.ui.confirmDialog.fallback,
		onSuccess: () => {
			setConfirm(false);
			onDeleted();
		}
	});

	function submit() {
		const cents = parseMoneyToCents(price);
		if (cents === 'bad') return save.setError(copy.discover.editStay.badPrice);
		void save.run(cents);
	}

	return (
		<>
			<Sheet open={open && !confirm} title={copy.discover.editStay.title} onClose={onClose}>
				<Field label={copy.discover.editStay.nameLabel} value={name} onChangeText={setName} />
				<Field
					label={`${copy.discover.editStay.priceLabel}${copy.ui.field.optionalSuffix}`}
					value={price}
					onChangeText={setPrice}
					keyboardType="decimal-pad"
				/>
				<SearchablePicker
					label={copy.discover.editStay.currencyLabel}
					value={cur}
					options={currencyOptions(currencies)}
					onPick={setCur}
					noMatches={copy.ui.currencyPicker.noMatches}
				/>
				<LinkField value={url} onChangeText={setUrl} />
				<TextArea
					label={`${copy.discover.placeFields.notesLabel}${copy.ui.field.optionalSuffix}`}
					value={notes}
					onChangeText={setNotes}
				/>
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={copy.common.save}
					primaryBusyLabel={copy.common.saving}
					primaryBusy={save.busy}
					onPrimary={submit}
					destructiveLabel={stay ? copy.common.deleteLabel(stay.name) : copy.common.delete}
					onDestructive={() => setConfirm(true)}
				/>
			</Sheet>
			<ConfirmSheet
				open={!!stay && confirm}
				title={
					stay && stay.linked > 0
						? copy.discover.deleteStay.linkedTitle(stay.name, stay.linked)
						: stay
							? copy.common.deleteTitle(stay.name)
							: ''
				}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirm(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}
