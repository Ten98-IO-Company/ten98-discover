-- P04: a row requires every member to have a verified second factor ("user"."twoFactorEnabled") before reaching this workspace's data.
CREATE TABLE workspace_two_factor_requirement (workspace_id text PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE);
