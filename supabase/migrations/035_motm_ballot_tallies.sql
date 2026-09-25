-- Anonymous MOTM results: vote counts after close, no voter identities.
--
-- get_motm_ballot must be dropped to add columns to RETURNS TABLE.
-- After close, the ballot includes every confirmed player (including the
-- caller) so the winner and tallies are complete. Counts stay null while
-- voting is open so remaining votes are not influenced.
--
-- get_game_detail is security invoker and reads the caller's own vote
-- (my_motm_vote_user_id). Keep an own-row SELECT policy so that still
-- works; drop the group-wide read that leaked voter -> candidate.

drop policy if exists "Group members can read motm votes" on public.motm_votes;
drop policy if exists "Users can read their own motm votes" on public.motm_votes;
create policy "Users can read their own motm votes"
on public.motm_votes for select to authenticated
using (voter_id = auth.uid());

drop function if exists public.get_motm_ballot(uuid);

create function public.get_motm_ballot(p_game_id uuid)
returns table (
  game_id uuid,
  title text,
  group_name text,
  scored_at timestamptz,
  closes_at timestamptz,
  is_open boolean,
  my_vote_user_id uuid,
  motm_user_id uuid,
  motm_name text,
  vote_total integer,
  candidate_user_id uuid,
  candidate_name text,
  candidate_avatar_url text,
  candidate_mmr integer,
  candidate_vote_count integer
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.title,
    grp.name as group_name,
    g.scored_at,
    g.scored_at + interval '24 hours' as closes_at,
    (
      g.status = 'completed'
      and g.motm_closed_at is null
      and g.scored_at is not null
      and now() < g.scored_at + interval '24 hours'
      and exists (
        select 1 from public.game_players me
        where me.game_id = g.id and me.user_id = auth.uid() and me.is_waitlisted = false
      )
    ) as is_open,
    (
      select mv.voted_for_id from public.motm_votes mv
      where mv.game_id = g.id and mv.voter_id = auth.uid()
    ) as my_vote_user_id,
    g.motm_user_id,
    winner.full_name as motm_name,
    case
      when g.motm_closed_at is not null then (
        select count(*)::integer from public.motm_votes mv_total
        where mv_total.game_id = g.id
      )
      else null
    end as vote_total,
    p.id as candidate_user_id,
    p.full_name as candidate_name,
    p.avatar_url as candidate_avatar_url,
    p.global_mmr as candidate_mmr,
    case
      when g.motm_closed_at is not null then (
        select count(*)::integer from public.motm_votes mv_count
        where mv_count.game_id = g.id and mv_count.voted_for_id = p.id
      )
      else null
    end as candidate_vote_count
  from public.games g
  join public.groups grp on grp.id = g.group_id
  left join public.game_players gp
    on gp.game_id = g.id
    and gp.is_waitlisted = false
    and (g.motm_closed_at is not null or gp.user_id <> auth.uid())
  left join public.profiles p on p.id = gp.user_id
  left join public.profiles winner on winner.id = g.motm_user_id
  where g.id = p_game_id
    and public.is_group_member(g.group_id)
  order by
    case
      when g.motm_closed_at is not null then (
        select count(*) from public.motm_votes mv_sort
        where mv_sort.game_id = g.id and mv_sort.voted_for_id = p.id
      )
    end desc nulls last,
    p.full_name nulls last;
$$;

comment on function public.get_motm_ballot(uuid) is
  'MOTM candidates plus voting window. After close, includes every confirmed player and anonymous vote counts. security definer; requires group membership.';

revoke all on function public.get_motm_ballot(uuid) from public, anon;
grant execute on function public.get_motm_ballot(uuid) to authenticated;
