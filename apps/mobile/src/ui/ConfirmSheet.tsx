import { Text } from 'react-native';
import { copy } from '@trippy/copy';
import { Button, FormError } from './index';
import { Sheet } from './Sheet';
import { type } from '../theme';

export function ConfirmSheet({
	open,
	title,
	message = copy.ui.confirmDialog.undone,
	confirmLabel,
	busyLabel = copy.common.working,
	busy = false,
	onCancel,
	onConfirm,
	error = ''
}: {
	open: boolean;
	title: string;
	message?: string;
	confirmLabel: string;
	busyLabel?: string;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	error?: string;
}) {
	return (
		<Sheet open={open} title={title} onClose={onCancel}>
			<Text style={type.small}>{message}</Text>
			<FormError message={error} />
			<Button
				label={busy ? busyLabel : confirmLabel}
				tone="danger"
				onPress={onConfirm}
				busy={busy}
			/>
		</Sheet>
	);
}
