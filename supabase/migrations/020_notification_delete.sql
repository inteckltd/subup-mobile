-- Allow users to swipe-delete their own inbox rows. Notifications are still
-- created server-side only (no insert policy); this opens delete for the
-- signed-in owner.

drop policy if exists "Users can delete own notifications" on public.notifications;
create policy "Users can delete own notifications"
  on public.notifications for delete
  using (user_id = auth.uid());
