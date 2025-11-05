ALTER TABLE hijos
  ADD COLUMN IF NOT EXISTS saldo NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Optional: keep saldo non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hijos_saldo_non_negative'
  ) THEN
    ALTER TABLE hijos
      ADD CONSTRAINT hijos_saldo_non_negative CHECK (saldo >= 0);
  END IF;
END $$;

