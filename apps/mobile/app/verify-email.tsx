import { Text } from 'react-native';
import { router } from 'expo-router';
import { copy } from '@trippy/copy';
import { Button, Screen } from '../src/ui';
import { type } from '../src/theme';

export default function VerifyEmail() {
	return (
		<Screen safeTop largeTitle={copy.auth.verifyEmail.title}>
			<Text style={type.subhead}>{copy.mobileAuth.openWebLink}</Text>
			<Button label={copy.auth.verify.logIn} onPress={() => router.replace('/login')} />
		</Screen>
	);
}
