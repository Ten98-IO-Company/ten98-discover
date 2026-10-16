CREATE TABLE tracked_asset (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('link','pixel')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 destination text CHECK(length(destination) BETWEEN 1 AND 2048),
 public_key uuid NOT NULL UNIQUE,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 active boolean NOT NULL,
 collection_enabled boolean NOT NULL DEFAULT false,
 capture_referrer boolean NOT NULL DEFAULT false,
 capture_geography boolean NOT NULL DEFAULT false,
 exclude_bots boolean NOT NULL DEFAULT true,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 retained_from timestamptz,
 next_cleanup_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='link' AND destination IS NOT NULL) OR(kind='pixel' AND destination IS NULL))
);
CREATE INDEX tracked_asset_page_idx ON tracked_asset(workspace_id,kind,created_at DESC,id DESC);
CREATE INDEX tracked_asset_cleanup_idx ON tracked_asset(next_cleanup_at,id);
CREATE TABLE tracked_asset_event (
 asset_id uuid NOT NULL REFERENCES tracked_asset(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 asset_revision integer NOT NULL CHECK(asset_revision>0),
 visitor_id text,
 visit_id text,
 dimensions jsonb NOT NULL CHECK(jsonb_typeof(dimensions)='object' AND octet_length(dimensions::text)<=4096),
 measurement_version text NOT NULL CHECK(measurement_version='native-asset-request-v1'),
 PRIMARY KEY(asset_id,id),
 CHECK((visitor_id IS NULL AND visit_id IS NULL) OR(visitor_id~'^[a-f0-9]{64}$' AND visit_id~'^[a-f0-9]{64}$' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL))
);
CREATE INDEX tracked_asset_event_time_idx ON tracked_asset_event(asset_id,received_at,id);
CREATE INDEX tracked_asset_event_identity_idx ON tracked_asset_event(asset_id,visitor_id,visit_id,received_at) WHERE visitor_id IS NOT NULL;
CREATE TABLE tracked_asset_request (
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 actor_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN('create','update','delete','share-create','share-revoke')),
 input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),
 asset_id uuid NOT NULL,
 applied_revision integer NOT NULL CHECK(applied_revision>0),
 share_id uuid,
 PRIMARY KEY(workspace_id,request_id)
);
CREATE TABLE tracked_asset_share (
 id uuid PRIMARY KEY,
 asset_id uuid NOT NULL REFERENCES tracked_asset(id) ON DELETE CASCADE,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 scope text NOT NULL CHECK(octet_length(scope) BETWEEN 1 AND 20000),
 sections text[] NOT NULL CHECK(cardinality(sections) BETWEEN 1 AND 3 AND sections<@ARRAY['summary','trend','breakdown']::text[]),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(3) NOT NULL,
 revoked_at timestamptz(3),
 CHECK(expires_at>created_at)
);
CREATE INDEX tracked_asset_share_page_idx ON tracked_asset_share(asset_id,created_at DESC,id DESC);
