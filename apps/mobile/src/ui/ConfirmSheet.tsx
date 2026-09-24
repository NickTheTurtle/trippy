import { Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { Button } from './index';
import { Sheet } from './Sheet';
import { space, type } from '../theme';

export function ConfirmSheet({
	open,
	title,
	message = copy.ui.confirmDialog.undone,
	confirmLabel,
	busyLabel = copy.common.working,
	busy = false,
	onCancel,
	onConfirm
}: {
	open: boolean;
	title: string;
	message?: string;
	confirmLabel: string;
	busyLabel?: string;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<Sheet open={open} title={title} onClose={onCancel}>
			<Text style={type.small}>{message}</Text>
			<View style={{ flexDirection: 'row', gap: space.md }}>
				<View style={{ flex: 1 }}>
					<Button label={copy.common.cancel} tone="ghost" onPress={onCancel} disabled={busy} />
				</View>
				<View style={{ flex: 1 }}>
					<Button
						label={busy ? busyLabel : confirmLabel}
						tone="danger"
						onPress={onConfirm}
						busy={busy}
					/>
				</View>
			</View>
		</Sheet>
	);
}
