import { Text } from 'react-native';
import { router } from 'expo-router';
import { copy } from '@trippy/copy';
import { Button, Screen } from '../src/ui';
import { type } from '../src/theme';

export default function Verify() {
	return (
		<Screen largeTitle={copy.auth.verify.title} subtitle={copy.shell.brand}>
			<Text style={type.subhead}>{copy.mobileAuth.openWebLink}</Text>
			<Button label={copy.auth.verify.logIn} onPress={() => router.replace('/login')} />
		</Screen>
	);
}
