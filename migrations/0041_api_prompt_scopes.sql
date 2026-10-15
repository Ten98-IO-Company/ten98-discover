-- Expand validation only: existing key rows and their exact grants remain unchanged.
ALTER TABLE api_key DROP CONSTRAINT api_key_scopes_check;
ALTER TABLE api_key ADD CONSTRAINT api_key_scopes_check CHECK (
  array_ndims(scopes) = 1 AND cardinality(scopes) BETWEEN 1 AND 7
  AND array_position(scopes, NULL) IS NULL
  AND scopes <@ ARRAY['projects:read', 'projects:write', 'analytics:read', 'events:write', 'team:read', 'prompts:read', 'prompts:write']::text[]
);
