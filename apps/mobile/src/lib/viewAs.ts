import { copy } from '@trippy/copy';

type Member = { id: string; name: string };

/**
 * The choices behind a View as button: everyone, then each member, you marked.
 */
export function viewAsChoices(members: Member[], me: string) {
	return [
		{ key: '', label: copy.viewAs.everyone },
		...members.map((m) => ({
			key: m.id,
			label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
		}))
	];
}

/**
 * What the View as button itself says: short, because it shares a row with
 * other controls. Everyone, You, or the person's first name; the menu and the
 * button's accessible name carry the full name.
 */
export function viewAsButtonLabel(value: string, members: Member[], me: string): string {
	if (!value) return copy.viewAs.everyone;
	if (value === me) return copy.viewAs.you;
	const name = members.find((m) => m.id === value)?.name ?? '';
	return name.trim().split(/\s+/)[0] || copy.viewAs.everyone;
}

/** The button's accessible name: the full choice, not the shortened label. */
export function viewAsAccessibilityLabel(value: string, members: Member[], me: string): string {
	const full = viewAsChoices(members, me).find((choice) => choice.key === value)?.label;
	return copy.viewAs.buttonLabel(full ?? copy.viewAs.everyone);
}
