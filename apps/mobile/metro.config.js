// Metro has to be told about the monorepo: the app lives in apps/mobile but its
// dependencies are hoisted to the repository root, and it imports source from
// packages/core and packages/copy, which sit outside its own folder.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, 'node_modules'),
	path.resolve(workspaceRoot, 'node_modules')
];
// Watching the whole workspace means watching folders that are not build
// inputs and are actively hostile to a watcher: Visual Studio rewrites and
// deletes files under .vs/ while it is running, which crashes the file map with
// ENOENT, and data/ holds the live SQLite database and its -wal sibling. The
// web app's Vite config ignores the same two for the same reason.
config.resolver.blockList = [
	/[/\\]\.vs[/\\].*/,
	/[/\\]\.git[/\\].*/,
	/[/\\]data[/\\].*/,
	/[/\\]apps[/\\]web[/\\]dist[/\\].*/
];
// Hierarchical lookup has to stay on. Several Expo SDK 57 packages keep private
// nested copies of their dependencies (@expo/metro-runtime nests @expo/log-box,
// for instance), and turning the walk off makes those unresolvable.
//
// The reason it was ever turned off is real though: the root holds its own React
// and React Native for the web app, so a hoisted package walking up from the root
// can pick up a second copy and break hooks. Pin the three singletons explicitly
// instead, which fixes the duplication without breaking nested resolution.
const singletons = ['react', 'react-dom', 'react-native'];
const isSingleton = (name) => singletons.some((pkg) => name === pkg || name.startsWith(`${pkg}/`));

const appModules = path.resolve(projectRoot, 'node_modules');
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (isSingleton(moduleName)) {
		// Resolve as if the importer sat in apps/mobile, so the app's copy always
		// wins no matter which package asked for it.
		return context.resolveRequest(
			{
				...context,
				originModulePath: path.join(projectRoot, 'index.js'),
				nodeModulesPaths: [appModules]
			},
			moduleName,
			platform
		);
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
