-- One-off: give every football membership that has no locked answers a
-- 5 / 5 / 5 (attack / fitness / standard) and lock it.
--
-- Run in the Supabase SQL editor. Safe to re-run: it only touches memberships
-- whose answers are not locked yet, so anything already answered (by the app
-- or by hand) is left alone. Ratings are never changed.
--
-- To set real values for someone afterwards, run for that membership:
--   select public.backfill_membership_answers('<group_id>', '<user_id>', 7, 6, 5);

update public.group_members gm
set attack_score = 5,
    fitness_score = 5,
    standard_score = 5,
    answers_locked_at = now(),
    answers_required = false
from public.groups g
where g.id = gm.group_id
  and g.sport = 'football'
  and gm.answers_locked_at is null;

-- Check: should return no rows.
select g.name, p.full_name
from public.group_members gm
join public.groups g on g.id = gm.group_id
join public.profiles p on p.id = gm.user_id
where g.sport = 'football'
  and gm.answers_locked_at is null;
