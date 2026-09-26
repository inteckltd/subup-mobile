import { useQuery } from '@tanstack/react-query';

import { currentAppVersion, fetchLatestStoreVersion, isStoreUpdateAvailable } from './api';

export function useStoreUpdateAvailable(): boolean {
  const installed = currentAppVersion();
  const query = useQuery({
    queryKey: ['store-update', installed],
    queryFn: fetchLatestStoreVersion,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 0,
  });
  return isStoreUpdateAvailable(installed, query.data ?? null);
}
