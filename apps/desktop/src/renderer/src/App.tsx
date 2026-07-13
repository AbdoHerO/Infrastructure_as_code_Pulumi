import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './app/providers.js';
import { router } from './app/router.js';

/** Renderer application root. */
export function App(): JSX.Element {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
