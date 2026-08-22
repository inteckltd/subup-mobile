import type { GroupCardModel } from '../home/types';

export type SetupProgress = {
  createdGroup: boolean;
  invitedSquad: boolean;
  scheduledGame: boolean;
  /** True for empty accounts and for anyone who admins at least one group. Members-only skip the checklist. */
  isOrganiser: boolean;
  allComplete: boolean;
  firstAdminGroupId: string | undefined;
};

export function getSetupProgress(
  groups: GroupCardModel[],
  upcomingGameCount: number,
  hasPendingInvite = false,
): SetupProgress {
  const adminGroups = groups.filter((group) => group.role === 'admin');
  const createdGroup = groups.length > 0;
  const invitedSquad = hasPendingInvite || adminGroups.some((group) => group.memberCount > 1);
  const scheduledGame = upcomingGameCount > 0;
  const isOrganiser = groups.length === 0 || adminGroups.length > 0;

  return {
    createdGroup,
    invitedSquad,
    scheduledGame,
    isOrganiser,
    allComplete: createdGroup && invitedSquad && scheduledGame,
    firstAdminGroupId: adminGroups[0]?.id,
  };
}
