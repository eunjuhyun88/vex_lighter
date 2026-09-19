-- Repair development databases that recorded migration 155 before its
-- portfolio snapshot columns were present. Every statement is additive and
-- idempotent so the repair is safe on both old and complete installations.
ALTER TABLE proj_portfolio_snapshots
  ADD COLUMN IF NOT EXISTS partial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unresolved_chain_count integer NOT NULL DEFAULT 0
    CHECK (unresolved_chain_count >= 0);

ALTER TABLE proj_portfolio_snapshot_groups
  ADD COLUMN IF NOT EXISTS partial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unresolved_chain_count integer NOT NULL DEFAULT 0
    CHECK (unresolved_chain_count >= 0);

CREATE TABLE IF NOT EXISTS proj_snapshot_read_deferrals (
  wallet_scope_key text PRIMARY KEY,
  consecutive_failure_cycles integer NOT NULL CHECK (consecutive_failure_cycles BETWEEN 0 AND 4),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proj_balance_chain_read_status (
  wallet_address TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  stale_since TIMESTAMPTZ,
  failure_reason TEXT,
  read_status TEXT NOT NULL DEFAULT 'ok'
    CONSTRAINT balance_chain_read_status_kind CHECK (read_status IN ('ok', 'read_failed', 'inventory_incomplete')),
  PRIMARY KEY (wallet_address, chain_id),
  CHECK ((failure_reason IS NULL) = (stale_since IS NULL))
);

DO $$ BEGIN
  IF to_regclass('proj_balance_chain_read_status') IS NOT NULL THEN
    ALTER TABLE proj_balance_chain_read_status
      ADD COLUMN IF NOT EXISTS read_status text NOT NULL DEFAULT 'ok';
    UPDATE proj_balance_chain_read_status
    SET read_status = 'read_failed'
    WHERE failure_reason IS NOT NULL AND read_status = 'ok';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'proj_balance_chain_read_status'::regclass
        AND conname = 'balance_chain_read_status_kind'
    ) THEN
      ALTER TABLE proj_balance_chain_read_status
        ADD CONSTRAINT balance_chain_read_status_kind
        CHECK (read_status IN ('ok', 'read_failed', 'inventory_incomplete'));
    END IF;
  END IF;
END $$;
