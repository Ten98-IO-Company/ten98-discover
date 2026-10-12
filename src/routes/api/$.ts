import { createFileRoute } from '@tanstack/react-router';
import { handleApi } from '../../server/api.ts';

export const Route = createFileRoute('/api/$')({
  server: { handlers: { GET: ({ request }) => handleApi(request), POST: ({ request }) => handleApi(request), OPTIONS: ({ request }) => handleApi(request) } },
});
