-- PitchIn — Storage bucket for group cover photos, used by the mobile
-- Create Group form. Public bucket (a cover photo isn't sensitive data),
-- but uploads/updates/deletes are path-scoped to the uploader's own
-- auth.uid() folder so one user can't overwrite another's file.

insert into storage.buckets (id, name, public)
values ('group-covers', 'group-covers', true)
on conflict (id) do nothing;

drop policy if exists "Users can upload their own group covers" on storage.objects;
create policy "Users can upload their own group covers"
on storage.objects for insert to authenticated
with check (bucket_id = 'group-covers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can update their own group covers" on storage.objects;
create policy "Users can update their own group covers"
on storage.objects for update to authenticated
using (bucket_id = 'group-covers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete their own group covers" on storage.objects;
create policy "Users can delete their own group covers"
on storage.objects for delete to authenticated
using (bucket_id = 'group-covers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Anyone can view group covers" on storage.objects;
create policy "Anyone can view group covers"
on storage.objects for select
using (bucket_id = 'group-covers');
