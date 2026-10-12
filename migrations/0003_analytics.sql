ALTER TABLE event DROP CONSTRAINT event_event_name_check;
ALTER TABLE event ADD CONSTRAINT event_event_name_check CHECK (event_name ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,63}$');
