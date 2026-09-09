import { defineConfig, mergeConfig } from 'vite';
import appConfig from '../apps/web/vite.config.ts';

const apiPort = Number(process.env.E2E_API_PORT ?? 5185);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5184);

export default mergeConfig(
	appConfig,
	defineConfig({
		root: 'apps/web',
		server: {
			port: webPort,
			strictPort: true,
			proxy: {
				'/api': {
					target: `http://localhost:${apiPort}`,
					changeOrigin: true
				}
			}
		}
	})
);
