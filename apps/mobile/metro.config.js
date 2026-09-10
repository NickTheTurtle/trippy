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
// Without this, a package hoisted to the root and a copy nested under the app
// can both be resolved, and React ends up loaded twice.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
