import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './components/ui/Toast';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<AuthProvider>
				{/* Above the router, so a result outlives the page that caused it:
				    saving an email reloads the account page out from under its own
				    confirmation. */}
				<ToastProvider>
					<App />
				</ToastProvider>
			</AuthProvider>
		</BrowserRouter>
	</StrictMode>
);
