-- Registered after the separately owned migration0049 dependency.
-- Existing paid executions and their ledger identity remain unchanged.
ALTER TABLE prompt_execution_quote ADD COLUMN cache_plan jsonb
 CHECK(cache_plan IS NULL OR (jsonb_typeof(cache_plan)='array' AND jsonb_array_length(cache_plan) BETWEEN 1 AND 4));
ALTER TABLE prompt_execution ADD COLUMN cache_key text CHECK(cache_key IS NULL OR cache_key ~ '^[a-f0-9]{64}$');
ALTER TABLE prompt_execution ADD CONSTRAINT prompt_execution_scoped_identity UNIQUE(id,workspace_id,project_id);
CREATE INDEX prompt_execution_cache_idx ON prompt_execution(project_id,cache_key,completed_at DESC,id DESC)
 WHERE cache_key IS NOT NULL AND result IS NOT NULL AND status='completed';
CREATE TABLE prompt_comparison_item (
 id uuid PRIMARY KEY,
 comparison_id uuid NOT NULL,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 3),
 execution_id uuid NOT NULL,
 reused boolean NOT NULL,
 UNIQUE(comparison_id,position),
 FOREIGN KEY(comparison_id,workspace_id,project_id) REFERENCES prompt_comparison(id,workspace_id,project_id) ON DELETE CASCADE,
 FOREIGN KEY(execution_id,workspace_id,project_id) REFERENCES prompt_execution(id,workspace_id,project_id),
 CHECK((reused AND id<>execution_id) OR (NOT reused AND id=execution_id))
);
INSERT INTO prompt_comparison_item(id,comparison_id,workspace_id,project_id,position,execution_id,reused)
 SELECT id,comparison_id,workspace_id,project_id,position,id,false FROM prompt_execution;
-- Keep every paid insertion path (including imported legacy fixtures) represented exactly once.
CREATE FUNCTION link_prompt_execution_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO prompt_comparison_item(id,comparison_id,workspace_id,project_id,position,execution_id,reused)
 VALUES(NEW.id,NEW.comparison_id,NEW.workspace_id,NEW.project_id,NEW.position,NEW.id,false);
 RETURN NEW;
END $$;
CREATE TRIGGER prompt_execution_item AFTER INSERT ON prompt_execution
 FOR EACH ROW EXECUTE FUNCTION link_prompt_execution_item();
