-- Workspace-owned board publication grants and immutable actor-scoped request receipts.
-- Append after actual0059; exactly TWO feature tables, with no retroactive publication.
-- Existing SQL0057/custom_board_request and all old BoardAck semantics stay unchanged.
CREATE TABLE board_share (
 id uuid PRIMARY KEY,
 board_id uuid NOT NULL REFERENCES custom_board(id) ON DELETE CASCADE,
 slug_label text NOT NULL CHECK(length(slug_label) BETWEEN 1 AND 48 AND slug_label ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 theme text NOT NULL CHECK(theme IN('light','dark')),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 board_revision integer NOT NULL CHECK(board_revision>0),
 selected_card_ids uuid[] NOT NULL CHECK(cardinality(selected_card_ids) BETWEEN 1 AND 40 AND array_ndims(selected_card_ids)=1 AND array_position(selected_card_ids,NULL) IS NULL),
 scope text NOT NULL CHECK(octet_length(scope) BETWEEN 1 AND 20000),
 allow_filter boolean NOT NULL DEFAULT false,
 ongoing_live boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(3) NOT NULL,
 revoked_at timestamptz(3),
 CHECK(expires_at>created_at)
);
CREATE INDEX board_share_page_idx ON board_share(board_id,created_at DESC,id DESC);
-- Workspace is derived through custom_board; avoid a second independently mutable workspace_id.
-- Application additionally validates sorted unique current card IDs, current kind/workspace/revision,
-- closed canonical scope, and TTL1h..365d using fresh DB clock. Never use old-reference save exemptions.
-- Public slug is immutable slug_label + '-' + id, so explicit republish keeps distributed URLs.
-- Active publication refuses exhausted revisions; irreversible safety revoke must remain possible.

CREATE TABLE board_share_request (
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 actor_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN('create','publish','revoke')),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 share_id uuid NOT NULL,
 applied_grant_revision integer NOT NULL CHECK(applied_grant_revision>0),
 applied_board_revision integer NOT NULL CHECK(applied_board_revision>0),
 PRIMARY KEY(workspace_id,request_id)
);
-- No board/share FK: receipts survive deletion so exact retries cannot recreate exposure.
-- No raw token, copied definition or report payload. Current owner/admin/W-lock admission precedes
-- actor+operation+canonical body-hash receipt lookup; row mutation and receipt insert share ONE commit.
-- Replay returns immutable old ACK plus separately current item/null, never a fake board ID/revision.