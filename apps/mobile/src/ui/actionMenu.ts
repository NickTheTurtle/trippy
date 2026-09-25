import { ActionSheetIOS, Platform } from 'react-native';
import { copy } from '@trippy/copy';

export type MenuAction = { label: string; destructive?: boolean; onPress: () => void };

/**
 * A short menu of actions, shown the iOS way when it can be: the system action
 * sheet rising from the bottom with Cancel apart, instead of a whole sheet for
 * two rows. Answers false elsewhere, so the caller opens its own sheet.
 *
 * UIKit runs the chosen action after the action sheet has finished dismissing,
 * so the action may present a sheet of its own straight away.
 */
export function showActionMenu(title: string, actions: MenuAction[]): boolean {
	if (Platform.OS !== 'ios') return false;
	const destructive = actions.findIndex((action) => action.destructive);
	ActionSheetIOS.showActionSheetWithOptions(
		{
			title,
			options: [...actions.map((action) => action.label), copy.common.cancel],
			cancelButtonIndex: actions.length,
			destructiveButtonIndex: destructive >= 0 ? destructive : undefined
		},
		(index) => actions[index]?.onPress()
	);
	return true;
}
