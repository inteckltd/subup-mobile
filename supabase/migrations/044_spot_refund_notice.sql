-- One notice when a payment misses its spot.
--
-- spot_refund_notice is the dedupe key on the payment row:
--   null                  not a missed spot
--   refunded              tell them we refunded, not sent yet
--   hold_canceled         tell them the hold was dropped, not sent yet
--   sent_refunded         that refund notice was claimed
--   sent_hold_canceled    that hold notice was claimed
-- A webhook retry and the lock sweep both claim the pending value. Only
-- the claim that changes it to sent inserts the notification.
--
-- Idempotent. Apply with apply_migration before redeploying the functions
-- that write this column. Never db push.

alter table public.game_payments
  add column if not exists spot_refund_notice text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'game_payments_spot_refund_notice_check'
  ) then
    alter table public.game_payments
      add constraint game_payments_spot_refund_notice_check
      check (
        spot_refund_notice is null
        or spot_refund_notice in (
          'refunded',
          'hold_canceled',
          'sent_refunded',
          'sent_hold_canceled'
        )
      );
  end if;
end$$;

comment on column public.game_payments.spot_refund_notice is
  'Dedupe for the one push sent when this payment missed its spot. Pending values are refunded or hold_canceled; sent_* means that push was claimed.';
