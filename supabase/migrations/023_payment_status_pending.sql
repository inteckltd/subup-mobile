-- Add `pending` in its own migration. Postgres cannot use a newly added
-- enum value in the same transaction that creates it.

alter type public.payment_status add value if not exists 'pending';
