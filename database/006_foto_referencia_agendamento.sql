BEGIN;
ALTER TABLE agendamento ADD COLUMN IF NOT EXISTS foto_referencia bytea;
COMMIT;
