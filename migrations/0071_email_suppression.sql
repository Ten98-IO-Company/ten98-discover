-- Transactional email suppression (#304). Additive after 0070; starts empty.
-- Amazon SES hard bounces and complaints, verified through the SNS feedback webhook, block further transactional sends to
-- the address. Only an unkeyed SHA-256 digest of the lowercased address is stored, never the address itself.
CREATE TABLE email_suppression (
  address_hash text PRIMARY KEY CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('permanent-bounce','complaint')),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
