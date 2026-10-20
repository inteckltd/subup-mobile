import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { GroupInvitePreviewRow, MembershipAnswersRow, SportType } from '../../types/database';
import type { JoinAnswers } from './questions';
import { hasJoinQuestions } from './questions';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

const KNOWN = [
  'Answer all three questions',
  'Answers must be between 0 and 10',
  'Your answers are already locked',
  'You are not a member of this group',
  'This group has no join questions',
  'This invite is not for you',
  'This invite is no longer pending',
  'Invite not found',
];

export function joinQuestionsError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('join-questions', error);
  console.error('[join-questions]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (KNOWN.some((known) => message.startsWith(known))) return message;
  }
  return fallback;
}

export type GroupInvitePreview = {
  groupId: string;
  groupName: string;
  sport: SportType;
};

/** The caller's own pending invite. `preview` is null once it is no longer pending. */
export async function fetchGroupInvitePreview(
  inviteId: string,
): Promise<{ preview?: GroupInvitePreview | null; error?: string }> {
  const { data, error } = await supabase.rpc('get_group_invite_preview', { p_invite_id: inviteId });
  if (error) return { error: joinQuestionsError(error, "Couldn't open this invite.") };
  const row = ((data ?? []) as GroupInvitePreviewRow[])[0];
  if (!row) return { preview: null };
  return { preview: { groupId: row.group_id, groupName: row.group_name, sport: row.sport } };
}

export type MembershipAnswersModel = {
  sport: SportType;
  needsAnswers: boolean;
  answersLocked: boolean;
};

export async function fetchMyMembershipAnswers(groupId: string): Promise<MembershipAnswersModel | null> {
  const { data, error } = await supabase.rpc('get_my_membership_answers', { p_group_id: groupId });
  if (error) throw new Error(joinQuestionsError(error, "Couldn't load your player profile."));
  const row = ((data ?? []) as MembershipAnswersRow[])[0];
  if (!row) return null;
  return { sport: row.sport, needsAnswers: row.needs_answers, answersLocked: row.answers_locked };
}

export async function saveMembershipAnswers(groupId: string, answers: JoinAnswers): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('submit_membership_answers', {
    p_group_id: groupId,
    p_attack: answers.attack,
    p_fitness: answers.fitness,
    p_standard: answers.standard,
  });
  if (error) return { error: joinQuestionsError(error, "Couldn't save your answers.") };
  return {};
}

export type InviteStart =
  | { kind: 'questions'; groupId: string }
  | { kind: 'accepted'; groupId: string }
  | { kind: 'error'; error: string };

/**
 * First step of accepting an invite. Sports with join questions hand off to
 * the questions screen (nothing is saved until it succeeds); other sports
 * join straight away. Shared by the notification Accept button and the join link.
 */
export async function beginInviteAcceptance(
  inviteId: string,
  accept: (inviteId: string) => Promise<{ error?: string }>,
): Promise<InviteStart> {
  const { preview, error } = await fetchGroupInvitePreview(inviteId);
  if (error) return { kind: 'error', error };
  if (!preview) return { kind: 'error', error: 'This invite is no longer pending' };
  if (hasJoinQuestions(preview.sport)) return { kind: 'questions', groupId: preview.groupId };
  const accepted = await accept(inviteId);
  if (accepted.error) return { kind: 'error', error: accepted.error };
  return { kind: 'accepted', groupId: preview.groupId };
}
