import { Text } from 'react-native';
import { router } from 'expo-router';
import { copy } from '@trippy/copy';
import { Button, Screen } from '../src/ui';
import { type } from '../src/theme';

export default function Verify() {
	return (
		<Screen>
			<Text style={type.title}>{copy.auth.verify.title}</Text>
			<Text style={type.small}>{copy.mobileAuth.openWebLink}</Text>
			<Button label={copy.auth.verify.logIn} onPress={() => router.replace('/login')} />
		</Screen>
	);
}
