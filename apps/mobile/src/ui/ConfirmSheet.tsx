import { useEffect, useRef } from 'react';
import { ActionSheetIOS, Alert, Platform, Text } from 'react-native';
import { copy } from '@trippy/copy';
import { Button, FormError } from './index';
import { Sheet } from './Sheet';
import { type } from '../theme';

type ConfirmProps = {
	open: boolean;
	title: string;
	message?: string;
	confirmLabel: string;
	busyLabel?: string;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	error?: string;
};

/**
 * Whether a confirmation rises over the sheet that asked for it (iOS: the
 * system action sheet) rather than replacing it (elsewhere: a second sheet).
 * An edit sheet stays open behind an overlaying confirmation, and closes for a
 * replacing one; either way a cancelled delete lands back in the edit sheet.
 */
export const confirmOverlays = Platform.OS === 'ios';

export function ConfirmSheet(props: ConfirmProps) {
	if (Platform.OS === 'ios') return <NativeConfirm {...props} />;
	const {
		open,
		title,
		message = copy.ui.confirmDialog.undone,
		confirmLabel,
		busyLabel = copy.common.working,
		busy = false,
		onCancel,
		onConfirm,
		error = ''
	} = props;
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

/**
 * On iOS a destructive confirmation is the system action sheet: the red action
 * and Cancel rise over whatever asked, so an edit sheet stays where it is behind
 * it rather than a second full sheet replacing it. It draws nothing itself.
 *
 * The caller's contract is unchanged: `open` stays true while the action runs
 * and the caller closes it on success. A refusal comes back as an alert that
 * offers the same action again, because the action sheet has already gone and
 * there is no longer a sheet to print the error in.
 */
function NativeConfirm({
	open,
	title,
	message = copy.ui.confirmDialog.undone,
	confirmLabel,
	onCancel,
	onConfirm,
	error = ''
}: ConfirmProps) {
	const latest = useRef({ onCancel, onConfirm });
	latest.current = { onCancel, onConfirm };
	const shown = useRef(false);
	// Only a refusal of the press this sheet made is answered: a mutation error
	// left over from an earlier attempt must not raise an alert on reopening.
	const awaiting = useRef(false);
	const confirm = () => {
		awaiting.current = true;
		latest.current.onConfirm();
	};

	useEffect(() => {
		if (!open) {
			shown.current = false;
			awaiting.current = false;
			return;
		}
		if (shown.current) return;
		shown.current = true;
		ActionSheetIOS.showActionSheetWithOptions(
			{
				title,
				message,
				options: [confirmLabel, copy.common.cancel],
				destructiveButtonIndex: 0,
				cancelButtonIndex: 1
			},
			(index) => (index === 0 ? confirm() : latest.current.onCancel())
		);
	}, [open, title, message, confirmLabel]);

	useEffect(() => {
		if (!open || !error || !awaiting.current) return;
		awaiting.current = false;
		Alert.alert(title, error, [
			{ text: copy.common.cancel, style: 'cancel', onPress: () => latest.current.onCancel() },
			{ text: confirmLabel, style: 'destructive', onPress: confirm }
		]);
	}, [open, error, title, confirmLabel]);

	return null;
}
