CREATE TABLE IF NOT EXISTS transacciones (
  id SERIAL PRIMARY KEY,
  client_tx_id VARCHAR(64) NOT NULL UNIQUE,
  hijo_id INTEGER NOT NULL,
  pulsera_id INTEGER,
  monto NUMERIC(12,2) NOT NULL,
  producto VARCHAR(255),
  reader_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure required columns exist (in case table existed partially)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='client_tx_id'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN client_tx_id VARCHAR(64) NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='hijo_id'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN hijo_id INTEGER NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='pulsera_id'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN pulsera_id INTEGER;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='monto'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN monto NUMERIC(12,2) NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='producto'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN producto VARCHAR(255);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='reader_name'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN reader_name VARCHAR(255);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name='transacciones' AND column_name='created_at'
  ) THEN
    ALTER TABLE transacciones ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- Optional FKs (only if referenced tables exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hijos') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'transacciones_hijo_fk'
    ) THEN
      ALTER TABLE transacciones
        ADD CONSTRAINT transacciones_hijo_fk FOREIGN KEY (hijo_id) REFERENCES hijos(id) ON DELETE RESTRICT;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pulseras') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'transacciones_pulsera_fk'
    ) THEN
      ALTER TABLE transacciones
        ADD CONSTRAINT transacciones_pulsera_fk FOREIGN KEY (pulsera_id) REFERENCES pulseras(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relname='transacciones_hijo_idx' AND n.nspname='public'
  ) THEN
    CREATE INDEX transacciones_hijo_idx ON transacciones (hijo_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relname='transacciones_created_idx' AND n.nspname='public'
  ) THEN
    CREATE INDEX transacciones_created_idx ON transacciones (created_at);
  END IF;
END $$;
