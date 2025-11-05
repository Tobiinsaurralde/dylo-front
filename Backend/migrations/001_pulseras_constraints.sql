-- Ensure unique UID and single active bracelet per alumno
CREATE UNIQUE INDEX IF NOT EXISTS pulseras_codigo_nfc_unique ON pulseras (codigo_nfc);

-- Only one active bracelet per hijo
CREATE UNIQUE INDEX IF NOT EXISTS pulsera_activa_unique_per_hijo ON pulseras (hijo_id) WHERE activa = true;

