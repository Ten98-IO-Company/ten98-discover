-- Owner decision D3 (2026-10-17): ten98 enforces no money limit; workspace_budget keeps only the manual pause.
-- Before D3 a missing row meant paused. Record that state for every existing workspace so no standing
-- approval starts charging at deploy; workspaces created from now on start unpaused.
INSERT INTO workspace_budget(workspace_id,paused) SELECT id,true FROM workspace ON CONFLICT(workspace_id) DO NOTHING;
ALTER TABLE workspace_budget ALTER COLUMN paused SET DEFAULT false, DROP COLUMN monthly_limit_micros;
ALTER TABLE provider_connection DROP COLUMN monthly_limit_micros;
