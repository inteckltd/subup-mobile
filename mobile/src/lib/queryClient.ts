import NetInfo from '@react-native-community/netinfo';
import { onlineManager, QueryClient } from '@tanstack/react-query';

import { isOfflineState } from './connectivity';

/**
 * Pause queries while NetInfo reports offline, and refetch when the
 * connection comes back. `isInternetReachable === null` is treated as
 * online so we do not pause on launch before reachability is known.
 */
onlineManager.setEventListener((setOnline) => {
  return NetInfo.addEventListener((state) => {
    setOnline(!isOfflineState(state));
  });
});

/**
 * Single app-wide QueryClient instance. Module-level (not per-render) since
 * there's exactly one query client for the whole app's lifetime.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnReconnect: true,
    },
  },
});
