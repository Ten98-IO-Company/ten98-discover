import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { scrubMalformedHostedBoardShareFragment } from './lib/boards';

export const getRouter = () => {
  if (typeof window !== 'undefined') scrubMalformedHostedBoardShareFragment(window.location, window.history);
  return createRouter({ routeTree, scrollRestoration: true });
};
declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter> }
}
