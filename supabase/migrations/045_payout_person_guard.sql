-- A group pays pitch money to groups.payout_user_id, and that column
-- refuses to delete the person (024). Account deletion, leaving, and
-- removing a member used to fail only after refunds and memberships were
-- already gone, or to succeed and keep paying someone who had left.
-- Stop before any of that when the person still receives payments for a
-- group that has other members. Never pick a replacement here: an admin
-- moves payouts from the group's payouts screen (set_group_payout_user).
-- A group with nobody else left is deleted by the existing path.
--
-- Apply on its own with apply_migration, after 044. Do not edit earlier
-- files. Rollback:
--   Re-apply the previous function bodies from 018 (delete_my_account),
--   011 (leave_group) and 010 (kick_group_member). No table changes.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_blocked text;
  v_names text[];
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

  select array_agg(
    case
      when not exists (
        select 1 from public.group_members me
        where me.group_id = g.id and me.user_id = v_uid and me.role = 'admin'
      ) then format('Ask an admin of %s to move payouts to someone else.', g.name)
      when not exists (
        select 1 from public.group_members other
        where other.group_id = g.id and other.user_id <> v_uid and other.role = 'admin'
      ) then format('Make another member an admin in %s, then move payouts to them.', g.name)
      else format('Move payouts to another admin in %s.', g.name)
    end
    order by g.name
  )
  into v_names
  from public.groups g
  where g.payout_user_id = v_uid
    and exists (
      select 1 from public.group_members other
      where other.group_id = g.id and other.user_id <> v_uid
    );

  if v_names is not null then
    raise exception '%', format(
      'You receive this group''s payments. %s Do that before deleting your account.',
      array_to_string(v_names, ' ')
    );
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
  'Caller leaves groups they do not solely administer, cancels invites, drops upcoming open/full spots, and removes push tokens and notifications. The client then deletes Storage files and the auth user. Refuses while they are the only admin, or still receive payouts, for a group that has other members.';

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_is_admin boolean;
  v_other_admins integer;
  v_rest text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid()
  ) then
    raise exception 'You are not a member of this group';
  end if;

  -- The sentence starts with the wording the live 1.0.6 app already shows
  -- in full. The rest matches what that person can actually do.
  select g.name into v_name
  from public.groups g
  where g.id = p_group_id
    and g.payout_user_id = auth.uid()
    and exists (
      select 1 from public.group_members other
      where other.group_id = g.id and other.user_id <> auth.uid()
    );

  if v_name is not null then
    select exists (
      select 1 from public.group_members me
      where me.group_id = p_group_id and me.user_id = auth.uid() and me.role = 'admin'
    ) into v_is_admin;
    select count(*) into v_other_admins
    from public.group_members other
    where other.group_id = p_group_id and other.user_id <> auth.uid() and other.role = 'admin';
    if not v_is_admin then
      v_rest := format('Ask an admin of %s to move payouts to someone else before leaving.', v_name);
    elsif v_other_admins = 0 then
      v_rest := format('Make another member an admin in %s, then move payouts to them, before leaving.', v_name);
    else
      v_rest := format('You receive this group''s payments. Move payouts to another admin in %s before leaving.', v_name);
    end if;
    raise exception '%', 'Promote another admin before leaving or removing the last admin. ' || v_rest;
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = auth.uid();

  if not exists (select 1 from public.group_members where group_id = p_group_id) then
    delete from public.groups where id = p_group_id;
  end if;
end;
$$;

comment on function public.leave_group(uuid) is
  'Caller leaves the group. The last remaining member may leave; the empty group is then deleted. Refuses while the caller still receives the group''s payouts and other members remain.';

revoke all on function public.leave_group(uuid) from public, anon;
grant execute on function public.leave_group(uuid) to authenticated;

create or replace function public.kick_group_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_admins integer;
  v_rest text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can remove members' using errcode = '42501';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Use leave group to remove yourself';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id
  ) then
    raise exception 'That person is not a member of this group';
  end if;

  select g.name into v_name
  from public.groups g
  where g.id = p_group_id
    and g.payout_user_id = p_user_id
    and exists (
      select 1 from public.group_members other
      where other.group_id = g.id and other.user_id <> p_user_id
    );

  if v_name is not null then
    select count(*) into v_admins
    from public.group_members admin
    where admin.group_id = p_group_id and admin.role = 'admin';
    -- Change treasurer is only on screen when the group has two admins.
    if v_admins < 2 then
      v_rest := format('Make another member an admin in %s, then move payouts to them, before removing them.', v_name);
    else
      v_rest := format('They receive this group''s payments. Move payouts to another admin in %s before removing them.', v_name);
    end if;
    raise exception '%', 'Promote another admin before leaving or removing the last admin. ' || v_rest;
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

comment on function public.kick_group_member(uuid, uuid) is
  'Admin removes another member. Refuses while that member still receives the group''s payouts.';

revoke all on function public.kick_group_member(uuid, uuid) from public, anon;
grant execute on function public.kick_group_member(uuid, uuid) to authenticated;
