-- Authored citation identities and exact-host publisher overrides share context revision/retention.
ALTER TABLE project_context
  ADD COLUMN brand_citation_domains jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(brand_citation_domains)='array' AND jsonb_array_length(brand_citation_domains)<=19),
  ADD COLUMN citation_category_overrides jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(citation_category_overrides)='array' AND jsonb_array_length(citation_category_overrides)<=100);
