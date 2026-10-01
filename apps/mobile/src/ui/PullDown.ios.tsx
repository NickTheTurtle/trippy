import type { SFSymbol } from 'sf-symbols-typescript';
import { color } from '../theme';
import { PullDownFallback } from './pullDownFallback';
import type { PullDownProps } from './pullDownFallback';
import { hasSwiftUI, serifPostScript } from './swiftUI';

export type { PullDownAction, PullDownOption, PullDownProps } from './pullDownFallback';

/**
 * The iOS pull-down: the system menu (SwiftUI `Menu`), opening from the trigger
 * with the choices as a picker (the system draws the checkmark) and any
 * commands under a divider, the way Photos, Files and Mail offer theirs. A
 * choice or a command runs when the menu closes, so a command may present a
 * sheet straight away.
 */
export function PullDown(props: PullDownProps) {
	if (!hasSwiftUI) return <PullDownFallback {...props} />;
	return <NativePullDown {...props} />;
}

function NativePullDown({
	variant,
	label,
	accessibilityLabel,
	title,
	options,
	value,
	onPick,
	actions = []
}: PullDownProps) {
	// Required here, not imported: see hasSwiftUI.
	const ui = require('@expo/ui/swift-ui') as typeof import('@expo/ui/swift-ui');
	const m = require('@expo/ui/swift-ui/modifiers') as typeof import('@expo/ui/swift-ui/modifiers');
	const { Host, Menu, Picker, Text, HStack, Image, Divider, Button } = ui;

	const trigger =
		variant === 'title' ? (
			<HStack spacing={6} alignment="center">
				<Text
					modifiers={[
						m.font({ family: serifPostScript, size: 24, textStyle: 'title2' }),
						m.foregroundStyle(color.ink),
						m.lineLimit(1)
					]}
				>
					{label}
				</Text>
				<Image systemName="chevron.down" size={14} color={color.accent} />
			</HStack>
		) : (
			<HStack spacing={4} alignment="center">
				<Text modifiers={[m.font({ textStyle: 'footnote', weight: 'semibold' }), m.lineLimit(1)]}>
					{clip(label)}
				</Text>
				<Image systemName="chevron.down" size={10} color={color.accentInk} />
			</HStack>
		);

	const menuModifiers =
		variant === 'pill'
			? [
					m.buttonStyle('bordered'),
					m.buttonBorderShape('capsule'),
					m.controlSize('small'),
					m.tint(color.accent),
					m.accessibilityLabel(accessibilityLabel)
				]
			: [
					m.tint(color.accent),
					m.accessibilityLabel(accessibilityLabel),
					// Left-aligned in the full-width host, so a long name truncates
					// before the chevron instead of pushing it off the screen.
					m.frame({ maxWidth: 10000, alignment: 'leading' })
				];

	return (
		// The title's host takes the row's width from React Native and only its
		// height from SwiftUI: a host sized to its content gives the text all the
		// width it asks for, so the line limit could never truncate.
		<Host
			matchContents={variant === 'title' ? { vertical: true } : true}
			style={variant === 'title' ? { alignSelf: 'stretch' } : undefined}
		>
			<Menu label={trigger} modifiers={menuModifiers}>
				<Picker
					label={title}
					selection={value}
					onSelectionChange={(key) => onPick(String(key))}
					modifiers={[m.pickerStyle('inline'), m.labelsHidden()]}
				>
					{options.map((option) => (
						<Text key={option.key} modifiers={[m.tag(option.key)]}>
							{option.label}
						</Text>
					))}
				</Picker>
				{actions.length ? <Divider /> : null}
				{actions.map((action) => (
					<Button
						key={action.key}
						label={action.label}
						systemImage={action.symbol as SFSymbol}
						role={action.destructive ? 'destructive' : 'default'}
						onPress={action.onPress}
					/>
				))}
			</Menu>
		</Host>
	);
}

/**
 * The pill sizes to its text and shares a row with other controls, so a long
 * first name is cut here; the menu and the accessible name carry it in full.
 */
function clip(label: string, max = 14): string {
	return label.length > max ? `${label.slice(0, max - 1).trimEnd()}…` : label;
}
