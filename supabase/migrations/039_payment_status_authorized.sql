-- Enum values for hold-then-capture. Postgres cannot use a new enum value
-- in the same transaction that adds it, so the behaviour lives in 040.

alter type public.payment_status add value if not exists 'authorized';
alter type public.payment_status add value if not exists 'card_saved';
alter type public.notification_type add value if not exists 'game_shortfall';
