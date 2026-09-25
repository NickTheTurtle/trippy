import { Text } from 'react-native';
import { router } from 'expo-router';
import { copy } from '@trippy/copy';
import { Button, Screen } from '../src/ui';
import { type } from '../src/theme';

export default function Reset() {
	return (
		<Screen largeTitle={copy.auth.reset.title} subtitle={copy.shell.brand}>
			<Text style={type.subhead}>{copy.mobileAuth.openWebLink}</Text>
			<Button label={copy.auth.reset.footerLink} onPress={() => router.replace('/login')} />
		</Screen>
	);
}
