-- PREPARED ONLY: register after the accepted 0044 migration; not applied in this increment.
-- Account presentation preferences are user-scoped, independently of workspace roles.
CREATE TABLE user_preference (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 80 AND time_zone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+.-]+)+)$'),
  locale text NOT NULL CHECK(locale IN (
    'ka-GE','ar-SA','az-AZ','be-BY','bg-BG','bn-BD','bs-BA','ca-ES','cs-CZ','da-DK','de-CH','de-DE','el-GR','en-GB','en-US','es-ES','fa-IR','fi-FI','fo-FO','fr-FR','ga-ES','he-IL','hi-IN','hr-HR','hu-HU','id-ID','it-IT','ja-JP','km-KH','ko-KR','lt-LT','mn-MN','ms-MY','my-MM','nl-NL','nb-NO','pl-PL','pt-BR','pt-PT','ro-RO','ru-RU','si-LK','sk-SK','sl-SI','sv-SE','ta-IN','th-TH','tr-TR','uk-UA','ur-PK','uz-UZ','vi-VN','zh-CN','zh-TW'
  )),
  theme text NOT NULL CHECK(theme IN ('light','dark','system')),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
