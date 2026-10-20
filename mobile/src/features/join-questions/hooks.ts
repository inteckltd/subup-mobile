import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../../providers/AuthProvider';
import { fetchMyMembershipAnswers } from './api';

/** Whether the caller's membership in this group still needs its join answers. */
export function useMembershipAnswers(groupId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['group', groupId, 'answers', session?.user.id],
    queryFn: () => fetchMyMembershipAnswers(groupId as string),
    enabled: !!session && !!groupId,
  });
}
