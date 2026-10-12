-- 0008_destinations.sql: per-project destination tracking state and immutable revisions.

CREATE TABLE tracking_revision (
    id uuid PRIMARY KEY,
    project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    environment text NOT NULL CHECK (environment IN ('live', 'test')),
    number integer NOT NULL CHECK (number > 0),
    consent_epoch uuid NOT NULL,
    configuration jsonb NOT NULL,
    created_by text REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    rollback_of uuid,
    CONSTRAINT tracking_revision_project_env_number_key UNIQUE (project_id, environment, number),
    CONSTRAINT tracking_revision_id_project_env_key UNIQUE (id, project_id, environment),
    CONSTRAINT tracking_revision_rollback_fkey FOREIGN KEY (rollback_of, project_id, environment)
        REFERENCES tracking_revision (id, project_id, environment)
);

CREATE TABLE tracking_state (
    project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    environment text NOT NULL CHECK (environment IN ('live', 'test')),
    draft jsonb NOT NULL DEFAULT '{"destinations":[]}'::jsonb,
    draft_version integer NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
    active_revision uuid,
    PRIMARY KEY (project_id, environment),
    CONSTRAINT tracking_state_active_fkey FOREIGN KEY (active_revision, project_id, environment)
        REFERENCES tracking_revision (id, project_id, environment)
);
