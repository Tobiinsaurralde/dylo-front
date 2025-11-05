CREATE TABLE IF NOT EXISTS notificaciones (
  id SERIAL PRIMARY KEY,
  transaccion_id INTEGER,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transacciones') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'notificaciones_tx_fk'
    ) THEN
      ALTER TABLE notificaciones
        ADD CONSTRAINT notificaciones_tx_fk FOREIGN KEY (transaccion_id) REFERENCES transacciones(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relname='notificaciones_created_idx' AND n.nspname='public'
  ) THEN
    CREATE INDEX notificaciones_created_idx ON notificaciones (created_at);
  END IF;
END $$;
