-- Rank tracking persistence and native calendar recurrence. Prior migrations are immutable.
CREATE TABLE rank_config (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  target_domain text NOT NULL CHECK (length(target_domain) BETWEEN 1 AND 253),
  -- Canonical SERP catalog code, not free text or the Labs country/language pair.
  location_code integer NOT NULL CHECK (location_code > 0),
  location_name text NOT NULL CHECK (length(location_name) BETWEEN 1 AND 200),
  location_type text NOT NULL CHECK (length(location_type) BETWEEN 1 AND 80),
  country_location_code integer NOT NULL CHECK (country_location_code > 0),
  country_iso char(2) NOT NULL CHECK (country_iso ~ '^[A-Z]{2}$'),
  language_code text NOT NULL CHECK (length(language_code) BETWEEN 1 AND 16),
  language_name text NOT NULL CHECK (length(language_name) BETWEEN 1 AND 80),
  catalog_verified_at timestamptz NOT NULL,
  devices text NOT NULL CHECK (devices IN ('desktop','mobile','both')),
  serp_depth smallint NOT NULL CHECK (serp_depth BETWEEN 10 AND 100 AND serp_depth % 10 = 0),
  max_crawl_pages smallint NOT NULL CHECK (max_crawl_pages BETWEEN 1 AND 10),
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483646),
  keywords_revision integer NOT NULL DEFAULT 1 CHECK (keywords_revision BETWEEN 1 AND 2147483646),
  metrics_revision bigint NOT NULL DEFAULT 1 CHECK (metrics_revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Manual until an owner explicitly enables a standing approval.
  schedule_interval text NOT NULL DEFAULT 'manual' CHECK (schedule_interval IN ('manual','daily','weekly','monthly')),
  schedule_timezone text,
  schedule_hour smallint CHECK (schedule_hour BETWEEN 0 AND 23),
  schedule_minute smallint CHECK (schedule_minute BETWEEN 0 AND 59),
  schedule_weekday smallint CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_enabled boolean NOT NULL DEFAULT false,
  approval_id uuid,
  approval_user_id text REFERENCES "user"(id),
  approval_config_revision integer CHECK (approval_config_revision BETWEEN 1 AND 2147483646),
  approval_keywords_revision integer CHECK (approval_keywords_revision BETWEEN 1 AND 2147483646),
  approval_request_hash text CHECK (approval_request_hash ~ '^[a-f0-9]{64}$'),
  approval_connection_id uuid,
  approval_connection_revision integer CHECK (approval_connection_revision > 0),
  approval_account_fingerprint text CHECK (approval_account_fingerprint ~ '^[a-f0-9]{64}$'),
  approval_account_fingerprint_version smallint CHECK (approval_account_fingerprint_version = 2),
  approval_max_micros bigint CHECK (approval_max_micros BETWEEN 1 AND 1000000000000),
  approved_at timestamptz,
  next_due_at timestamptz,
  last_skip_reason text,
  UNIQUE (id,project_id,workspace_id),
  UNIQUE (project_id,target_domain,location_code,language_code),
  FOREIGN KEY (project_id,workspace_id) REFERENCES project(id,workspace_id),
  FOREIGN KEY (approval_connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
  CHECK (
    (schedule_interval = 'manual' AND schedule_timezone IS NULL AND schedule_hour IS NULL AND schedule_minute IS NULL AND schedule_weekday IS NULL)
    OR (schedule_interval <> 'manual' AND schedule_timezone IS NOT NULL AND schedule_hour IS NOT NULL AND schedule_minute IS NOT NULL
      AND ((schedule_interval = 'weekly' AND schedule_weekday IS NOT NULL) OR (schedule_interval <> 'weekly' AND schedule_weekday IS NULL)))
  ),
  CHECK (NOT schedule_enabled OR (
    archived_at IS NULL AND schedule_interval <> 'manual' AND next_due_at IS NOT NULL
    AND approval_id IS NOT NULL AND approval_user_id IS NOT NULL
    AND approval_config_revision IS NOT NULL AND approval_config_revision = revision
    AND approval_keywords_revision IS NOT NULL AND approval_keywords_revision = keywords_revision
    AND approval_request_hash IS NOT NULL AND approval_connection_id IS NOT NULL AND approval_connection_revision IS NOT NULL
    AND approval_account_fingerprint IS NOT NULL AND approval_account_fingerprint_version IS NOT NULL AND approval_account_fingerprint_version = 2
    AND approval_max_micros IS NOT NULL AND approved_at IS NOT NULL
  )),
  CHECK (schedule_enabled OR next_due_at IS NULL)
);
CREATE INDEX rank_config_project_page ON rank_config(project_id,created_at,id);
CREATE INDEX rank_config_due ON rank_config(next_due_at,id) WHERE schedule_enabled;
-- Service invariant: target_domain/location_code/country parent/language are immutable
-- identity fields after creation. Retargeting creates another config. Catalog labels
-- may refresh without changing identity. Archive/reactivate increments revision,
-- clears next_due_at, and disables approval; reactivation never resumes paid schedules.
-- Changes to device/depth/keywords also invalidate approval atomically. Pins/names do
-- not alter paid request scope. No config lifetime cap is imposed.

CREATE TABLE rank_keyword (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  config_id uuid NOT NULL,
  keyword text NOT NULL CHECK (length(keyword) BETWEEN 1 AND 200),
  match_case boolean NOT NULL DEFAULT false,
  pinned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Derived metric payload is separate from authored text/pin and rank snapshots.
  -- It includes explicit per-field scope/source (local volume/CPC vs national KD),
  -- decimal-string CPC, null/missing semantics and original source observation time.
  metric_data jsonb CHECK (metric_data IS NULL OR jsonb_typeof(metric_data) = 'object'),
  -- This FK supports the existing Labs source only; Ads provenance requires its
  -- separately reviewed adapter/schema extension before claiming local metrics parity.
  metric_source_run_id uuid,
  metric_source_row integer CHECK (metric_source_row BETWEEN 0 AND 99),
  metric_observed_at timestamptz,
  metric_fetched_at timestamptz,
  metric_expired_at timestamptz,
  metric_version bigint NOT NULL DEFAULT 0 CHECK (metric_version >= 0),
  last_metric_attempt_version bigint NOT NULL DEFAULT 0 CHECK (last_metric_attempt_version >= 0),
  last_metric_attempt_status text,
  last_metric_attempt_at timestamptz,
  UNIQUE (config_id,keyword),
  UNIQUE (id,config_id,project_id,workspace_id),
  FOREIGN KEY (config_id,project_id,workspace_id) REFERENCES rank_config(id,project_id,workspace_id),
  FOREIGN KEY (metric_source_run_id,project_id) REFERENCES keyword_research_run(id,project_id),
  CHECK (metric_data IS NULL OR (metric_source_run_id IS NOT NULL AND metric_source_row IS NOT NULL AND metric_observed_at IS NOT NULL AND metric_fetched_at IS NOT NULL AND metric_expired_at IS NULL)),
  CHECK ((last_metric_attempt_status IS NULL) = (last_metric_attempt_at IS NULL))
);
CREATE INDEX rank_keyword_page ON rank_keyword(config_id,created_at,id);
CREATE INDEX rank_keyword_metric_expiry ON rank_keyword(project_id,metric_observed_at,id) WHERE metric_data IS NOT NULL;
-- Existing workspace/project/config serialization enforces <=1000 current keywords
-- per tracker on insert, including concurrent inserts. Case-sensitive terms remain
-- separate; case-insensitive insertion lowercases once before identity comparison.
-- Deletion never cascades paid history. Captured task IDs have no FK to this table.

CREATE TABLE rank_run (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  config_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id),
  trigger text NOT NULL CHECK (trigger IN ('manual','scheduled')),
  method text NOT NULL CHECK (method IN ('live','queued')),
  -- Quoted intents have no provider ledger or queue rows until explicit start.
  status text NOT NULL CHECK (status IN ('quoted','queued','running','waiting','completed','partial','failed','cancelled','skipped')),
  config_revision integer NOT NULL CHECK (config_revision BETWEEN 1 AND 2147483646),
  keywords_revision integer NOT NULL CHECK (keywords_revision BETWEEN 1 AND 2147483646),
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision > 0),
  account_fingerprint text NOT NULL CHECK (account_fingerprint ~ '^[a-f0-9]{64}$'),
  account_fingerprint_version smallint NOT NULL DEFAULT 2 CHECK (account_fingerprint_version = 2),
  connection_name text NOT NULL,
  -- Immutable canonical request, price evidence, captured target UUIDs/text, devices,
  -- location/language/target/depth/max_crawl_pages and ordered paid-dispatch grouping.
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 2097152),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  task_count integer NOT NULL CHECK (task_count BETWEEN 0 AND 2000),
  estimate_micros bigint NOT NULL CHECK (estimate_micros BETWEEN 0 AND 1000000000000),
  price_as_of timestamptz NOT NULL,
  expires_at timestamptz,
  request_key uuid,
  approval_id uuid,
  scheduled_for timestamptz,
  approval_snapshot jsonb CHECK (approval_snapshot IS NULL OR jsonb_typeof(approval_snapshot) = 'object'),
  is_subset boolean NOT NULL DEFAULT false,
  diagnostic text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  cancel_requested_at timestamptz,
  raw_expired_at timestamptz,
  data_expired_at timestamptz,
  UNIQUE (id,project_id,workspace_id),
  UNIQUE (workspace_id,request_key),
  FOREIGN KEY (config_id,project_id,workspace_id) REFERENCES rank_config(id,project_id,workspace_id),
  FOREIGN KEY (connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
  CHECK ((trigger = 'manual' AND approval_id IS NULL AND scheduled_for IS NULL AND approval_snapshot IS NULL AND expires_at IS NOT NULL)
    OR (trigger = 'scheduled' AND approval_id IS NOT NULL AND scheduled_for IS NOT NULL AND approval_snapshot IS NOT NULL AND request_key IS NULL AND method = 'queued')),
  CHECK (trigger <> 'manual' OR ((started_at IS NULL) = (request_key IS NULL))),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (status <> 'quoted' OR (trigger = 'manual' AND started_at IS NULL AND completed_at IS NULL)),
  CHECK (status NOT IN ('queued','running','waiting','completed','partial','failed','cancelled') OR started_at IS NOT NULL),
  CHECK (status = 'skipped' OR (task_count > 0 AND estimate_micros > 0)),
  CHECK ((status IN ('completed','partial','failed','cancelled','skipped')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX rank_scheduled_occurrence ON rank_run(config_id,approval_id,scheduled_for) WHERE trigger = 'scheduled';
CREATE UNIQUE INDEX rank_one_active ON rank_run(config_id) WHERE status IN ('queued','running','waiting');
CREATE INDEX rank_run_page ON rank_run(project_id,config_id,created_at DESC,id DESC);
CREATE INDEX rank_run_retention ON rank_run(project_id,completed_at,id) WHERE completed_at IS NOT NULL AND (raw_expired_at IS NULL OR data_expired_at IS NULL);
-- A quote's immutable financial identity remains after start/expiry. Expired is a
-- computed quote availability, not a successful execution status. Runs with mixed
-- results use partial; costStatus is derived separately from child ledger rows.

CREATE TABLE rank_dispatch (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  run_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 1999),
  method text NOT NULL CHECK (method IN ('live','queued')),
  task_count smallint NOT NULL CHECK (task_count BETWEEN 1 AND 100),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'array' AND jsonb_array_length(request) = task_count AND octet_length(request::text) <= 131072),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK (phase IN ('reserved','dispatched','collecting','finished','uncertain','cancelled')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  dispatched_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  next_poll_at timestamptz,
  collect_deadline timestamptz,
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  diagnostic text,
  -- Compact immutable financial evidence only. Raw SERP bodies belong on tasks.
  charge_evidence jsonb CHECK (charge_evidence IS NULL OR jsonb_typeof(charge_evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id,ordinal),
  UNIQUE (id,run_id,project_id,workspace_id),
  FOREIGN KEY (run_id,project_id,workspace_id) REFERENCES rank_run(id,project_id,workspace_id),
  FOREIGN KEY (id,workspace_id) REFERENCES provider_request(id,workspace_id),
  CHECK (method <> 'live' OR task_count = 1),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (phase NOT IN ('dispatched','collecting','uncertain') OR dispatched_at IS NOT NULL)
);
CREATE INDEX rank_dispatch_collect_due ON rank_dispatch(next_poll_at,id) WHERE phase = 'collecting';
CREATE INDEX rank_dispatch_recover ON rank_dispatch(phase,lease_expires_at,id) WHERE phase IN ('reserved','dispatched','collecting');
-- Accepted queued POSTs remain ledger-dispatched while final charges are pending.
-- Unknown acceptance/charge uses ledger-uncertain. Final settlement is exactly once
-- per dispatch after every posted task's charge is proven. No paid fallback/re-POST.

CREATE TABLE rank_task (
  id uuid PRIMARY KEY, -- Used as the exact unique provider tag, never a mutable term.
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  run_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  keyword_id uuid NOT NULL, -- Captured identifier; intentionally no rank_keyword FK.
  keyword text NOT NULL CHECK (length(keyword) BETWEEN 1 AND 200),
  match_case boolean NOT NULL,
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  provider_task_id text CHECK (length(provider_task_id) BETWEEN 1 AND 128),
  result_status text NOT NULL CHECK (result_status IN ('pending','ranked','not_found','failed','uncertain','cancelled','unavailable')),
  provider_status integer,
  position integer CHECK (position > 0),
  rank_basis text CHECK (rank_basis IN ('organic','absolute')),
  absolute_position integer CHECK (absolute_position > 0),
  ranking_url text CHECK (length(ranking_url) BETWEEN 1 AND 4096),
  serp_features jsonb CHECK (serp_features IS NULL OR (jsonb_typeof(serp_features) = 'array' AND jsonb_array_length(serp_features) <= 100)),
  checked_depth smallint CHECK (checked_depth BETWEEN 0 AND 100),
  returned_item_count integer CHECK (returned_item_count BETWEEN 0 AND 10000),
  observed_at timestamptz,
  retrieved_at timestamptz,
  provisional_micros bigint CHECK (provisional_micros BETWEEN 0 AND 1000000000000),
  final_micros bigint CHECK (final_micros BETWEEN 0 AND 1000000000000),
  final_charge_at timestamptz,
  charge_evidence jsonb CHECK (charge_evidence IS NULL OR jsonb_typeof(charge_evidence) = 'object'),
  raw_evidence jsonb CHECK (raw_evidence IS NULL OR jsonb_typeof(raw_evidence) = 'object'),
  raw_expired_at timestamptz,
  data_expired_at timestamptz,
  diagnostic text,
  UNIQUE (run_id,keyword_id,device),
  UNIQUE (dispatch_id,provider_task_id),
  FOREIGN KEY (dispatch_id,run_id,project_id,workspace_id) REFERENCES rank_dispatch(id,run_id,project_id,workspace_id),
  CHECK ((final_micros IS NULL) = (final_charge_at IS NULL)),
  CHECK (result_status <> 'ranked' OR data_expired_at IS NOT NULL OR (position IS NOT NULL AND rank_basis IS NOT NULL AND ranking_url IS NOT NULL AND observed_at IS NOT NULL AND retrieved_at IS NOT NULL AND checked_depth IS NOT NULL AND returned_item_count IS NOT NULL)),
  CHECK (result_status = 'ranked' OR (position IS NULL AND rank_basis IS NULL AND absolute_position IS NULL AND ranking_url IS NULL)),
  CHECK (rank_basis <> 'absolute' OR (absolute_position IS NOT NULL AND position = absolute_position)),
  CHECK (result_status <> 'not_found' OR data_expired_at IS NOT NULL OR (position IS NULL AND observed_at IS NOT NULL AND retrieved_at IS NOT NULL AND checked_depth IS NOT NULL AND returned_item_count IS NOT NULL)),
  CHECK (data_expired_at IS NULL OR (position IS NULL AND rank_basis IS NULL AND absolute_position IS NULL AND ranking_url IS NULL AND serp_features IS NULL AND raw_evidence IS NULL)),
  CHECK (raw_expired_at IS NULL OR raw_evidence IS NULL)
);
CREATE INDEX rank_task_history ON rank_task(project_id,keyword_id,device,observed_at DESC,id DESC);
CREATE INDEX rank_task_run_page ON rank_task(run_id,id);
-- Not-found is an observed negative within explicit depth, never a transport failure.
-- Compare only equivalent immutable target/device/scope. Preserve observed/baseline
-- dates and absence/expired distinctions; publish successful tasks in partial runs.

-- Native calendar recurrence. The caller validates/stores a pg_timezone_names name;
-- validation is repeated here. Sundays=0. Monthly always means local month end.
-- p_after is an exclusive bound captured AFTER the config lock; use clock_timestamp.
-- Do not advance by 24-hour intervals or by the old anchor repeatedly after downtime.
CREATE FUNCTION rank_next_due(
  p_interval text, p_timezone text, p_hour integer, p_minute integer,
  p_weekday integer, p_after timestamptz
) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  local_date date;
  candidate_date date;
  candidate timestamptz;
  answer timestamptz;
  n integer;
BEGIN
  IF p_interval IS NULL OR p_interval NOT IN ('daily','weekly','monthly')
     OR p_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone)
     OR p_hour IS NULL OR p_hour NOT BETWEEN 0 AND 23
     OR p_minute IS NULL OR p_minute NOT BETWEEN 0 AND 59
     OR p_after IS NULL OR NOT isfinite(p_after)
     OR (p_interval = 'weekly' AND (p_weekday IS NULL OR p_weekday NOT BETWEEN 0 AND 6))
     OR (p_interval <> 'weekly' AND p_weekday IS NOT NULL)
  THEN RAISE EXCEPTION 'Invalid rank schedule'; END IF;
  -- A skipped civil date can shift yesterday's (or prior month-end's) wall time
  -- into a future instant after the local calendar has already advanced.
  local_date := (p_after AT TIME ZONE p_timezone)::date - 1;
  -- A two-week horizon handles both an ordinary weekly occurrence and a skipped
  -- civil date. Monthly needs only current + next + following month end.
  FOR n IN 0..(CASE WHEN p_interval = 'monthly' THEN 2 ELSE 14 END) LOOP
    IF p_interval = 'monthly' THEN
      candidate_date := (date_trunc('month', local_date::timestamp) + make_interval(months => n + 1) - interval '1 day')::date;
    ELSE
      candidate_date := local_date + n;
      IF p_interval = 'weekly' AND extract(dow FROM candidate_date)::integer <> p_weekday THEN CONTINUE; END IF;
    END IF;
    candidate := (candidate_date + make_time(p_hour,p_minute,0)) AT TIME ZONE p_timezone;
    IF candidate > p_after AND (answer IS NULL OR candidate < answer) THEN answer := candidate; END IF;
  END LOOP;
  IF answer IS NULL THEN RAISE EXCEPTION 'Rank schedule is unavailable'; END IF;
  RETURN answer;
END;
$$;
-- PostgreSQL native convention: a nonexistent local time uses the pre-transition
-- offset (renders shifted forward); an ambiguous time uses the post-transition
-- offset (the later occurrence). Exactly one UTC occurrence is scheduled.
-- Primary reference: https://www.postgresql.org/docs/18/datetime-invalid-input.html
-- Required independent fixtures before adoption: New_York gap/fold, Lord_Howe30m,
-- Pacific/Apia skipped day, leap/non-leap month-end, UTC exact-boundary, invalid zone,
-- downtime advancement and simultaneous claims.
