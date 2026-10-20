import type { SportType } from '../../types/database';

export type JoinQuestionId = 'attack' | 'fitness' | 'standard';

export type JoinQuestion = {
  id: JoinQuestionId;
  label: string;
  prompt: string;
  lowLabel: string;
  highLabel: string;
};

export type JoinAnswers = Record<JoinQuestionId, number>;

/** Neutral starting point: balanced, average fitness, some team football. */
export const DEFAULT_JOIN_ANSWERS: JoinAnswers = { attack: 5, fitness: 5, standard: 5 };

/**
 * Join questions per sport. A sport that is not listed here skips the
 * questions screen entirely (server side: `groups.sport = 'football'` only).
 */
const QUESTIONS_BY_SPORT: Partial<Record<SportType, JoinQuestion[]>> = {
  football: [
    {
      id: 'attack',
      label: 'Play style',
      prompt: 'Are you attacking or defensive?',
      lowLabel: 'Very defensive',
      highLabel: 'Very attacking',
    },
    {
      id: 'fitness',
      label: 'Fitness',
      prompt: 'What is your fitness level?',
      lowLabel: 'Need rest and breaks',
      highLabel: 'Comfortable for 90 minutes',
    },
    {
      id: 'standard',
      label: 'Standard',
      prompt: 'What standard of football have you played at?',
      lowLabel: 'Never played for a team',
      highLabel: 'Professional or academy',
    },
  ],
};

export function joinQuestionsFor(sport: SportType): JoinQuestion[] | null {
  return QUESTIONS_BY_SPORT[sport] ?? null;
}

export function hasJoinQuestions(sport: SportType): boolean {
  return joinQuestionsFor(sport) !== null;
}
