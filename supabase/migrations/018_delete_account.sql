-- Account deletion FKs, profile-stat protection, and delete_my_account RPC.
--
-- Past games keep a lobby row after the player is wiped (user_id SET NULL)
-- so history shows "Deleted user". Upcoming spots are removed in the RPC
-- before auth.users is deleted by the delete-my-account Edge Function.

-- ---------------------------------------------------------------------------
-- FKs: survive profile deletion
-- ---------------------------------------------------------------------------

alter table public.groups
  alter column created_by drop not null;

alter table public.groups
  drop constraint if exists groups_created_by_fkey;

alter table public.groups
  add constraint groups_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null;

alter table public.games
  alter column created_by drop not null;

alter table public.games
  drop constraint if exists games_created_by_fkey;

alter table public.games
  add constraint games_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null;

alter table public.game_players
  alter column user_id drop not null;

alter table public.game_players
  drop constraint if exists game_players_user_id_fkey;

alter table public.game_players
  add constraint game_players_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete set null;

alter table public.motm_votes
  alter column voted_for_id drop not null;

alter table public.motm_votes
  drop constraint if exists motm_votes_voted_for_id_fkey;

alter table public.motm_votes
  add constraint motm_votes_voted_for_id_fkey
    foreign key (voted_for_id) references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Clients must not write MMR / stats columns. Security-definer RPCs run as
-- the function owner (not `authenticated`), so apply_game_mmr still works.
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_stats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user = 'authenticated' then
    if new.global_mmr is distinct from old.global_mmr
      or new.games_played is distinct from old.games_played
      or new.motm_count is distinct from old.motm_count
      or new.reliability_score is distinct from old.reliability_score
    then
      raise exception 'Cannot update rating stats' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_stats on public.profiles;
create trigger protect_profile_stats
  before update on public.profiles
  for each row execute function public.protect_profile_stats();

-- ---------------------------------------------------------------------------
-- Games writes go through RPCs (create_game / update_game / cancel_game /
-- submit_game_score). Direct client INSERT/UPDATE/DELETE is too broad —
-- it let any admin change scores or cancel without the lock/score rules.
-- ---------------------------------------------------------------------------

drop policy if exists "Admins can create games" on public.games;
drop policy if exists "Admins can update games" on public.games;
drop policy if exists "Admins can delete games" on public.games;

-- ---------------------------------------------------------------------------
-- delete_my_account — authenticated, security definer. Does not delete
-- auth.users (Edge Function does that with the service role).
-- ---------------------------------------------------------------------------

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_blocked text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select string_agg(g.name, ', ' order by g.name)
  into v_blocked
  from public.groups g
  where exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id = v_uid and gm.role = 'admin'
    )
    and exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id <> v_uid
    )
    and not exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id <> v_uid and gm.role = 'admin'
    );

  if v_blocked is not null then
    raise exception 'Promote another admin in % before deleting your account.', v_blocked
      using errcode = 'P0001';
  end if;

  -- Sole-member groups: cascade games/members. prevent_last_admin_loss
  -- allows this because no other members remain.
  delete from public.groups g
  where exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id = v_uid
    )
    and not exists (
      select 1 from public.group_members gm
      where gm.group_id = g.id and gm.user_id <> v_uid
    );

  delete from public.group_members where user_id = v_uid;

  update public.group_invites
  set status = 'cancelled'
  where status = 'pending'
    and (invited_by = v_uid or invited_user_id = v_uid);

  delete from public.game_players gp
  using public.games g
  where gp.game_id = g.id
    and gp.user_id = v_uid
    and g.status in ('open', 'full')
    and g.starts_at > now();

  delete from public.push_tokens where user_id = v_uid;
  delete from public.notifications where user_id = v_uid;
end;
$$;

comment on function public.delete_my_account() is
  'Wipes the caller''s memberships, upcoming spots, invites, tokens, and sole-member groups. Blocks if they are the last admin of a group that still has other members. auth.users is deleted by the delete-my-account Edge Function.';

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
