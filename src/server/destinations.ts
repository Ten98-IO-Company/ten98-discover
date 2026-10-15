import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {publicTrackingSettings, trackingConsentEpoch} from './native-analytics.ts';
import {collectionOriginAllowed} from './collection-origins.ts';

export const PROVIDERS = ['meta', 'ga4', 'google_ads', 'cloudflare', 'tiktok', 'linkedin', 'microsoft_ads', 'pinterest', 'snapchat', 'x'] as const;
export const CANONICAL_EVENTS = ['page_view', 'sign_up', 'generate_lead', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];
export type Environment = 'live' | 'test';

const environmentSchema = z.enum(['live', 'test']);
const idSchema = z.uuid();
// RegExp `$` permits a final newline; identifiers and scalar fields must match every byte.
function fullMatch(pattern: RegExp, value: string) { return pattern.exec(value)?.[0] === value; }

const ASSET_PATTERNS: Record<Provider, RegExp> = {
  meta: /^\d{1,25}$/,
  ga4: /^G-[A-Z0-9]{4,20}$/,
  google_ads: /^AW-\d{1,20}$/,
  cloudflare: /^[0-9a-fA-F]{32}$/,
  tiktok: /^[A-Z0-9]{10,32}$/,
  linkedin: /^(?!0+$)\d{1,20}$/,
  microsoft_ads: /^(?!0+$)\d{1,20}$/,
  pinterest: /^(?!0+$)\d{1,20}$/,
  snapchat: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  x: /^[A-Za-z0-9]{3,20}$/,
};

const FIXED_TARGETS: Record<Provider, Partial<Record<CanonicalEvent, string>>> = {
  meta: {page_view: 'PageView', sign_up: 'CompleteRegistration', generate_lead: 'Lead', view_item: 'ViewContent', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'Purchase'},
  ga4: {page_view: 'page_view', sign_up: 'sign_up', generate_lead: 'generate_lead', view_item: 'view_item', add_to_cart: 'add_to_cart', begin_checkout: 'begin_checkout', purchase: 'purchase', refund: 'refund'},
  google_ads: {sign_up: 'conversion', generate_lead: 'conversion', view_item: 'conversion', add_to_cart: 'conversion', begin_checkout: 'conversion', purchase: 'conversion'},
  cloudflare: {page_view: 'sdk_pageview'},
  tiktok: {page_view: 'Pageview', sign_up: 'CompleteRegistration', generate_lead: 'Lead', view_item: 'ViewContent', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'Purchase'},
  linkedin: {sign_up: 'conversion', generate_lead: 'conversion', view_item: 'conversion', add_to_cart: 'conversion', begin_checkout: 'conversion', purchase: 'conversion'},
  microsoft_ads: {page_view: 'page_view', sign_up: 'sign_up', generate_lead: 'generate_lead', view_item: 'view_item', add_to_cart: 'add_to_cart', begin_checkout: 'begin_checkout', purchase: 'purchase'},
  pinterest: {page_view: 'pagevisit', sign_up: 'signup', generate_lead: 'lead', view_item: 'viewcontent', add_to_cart: 'addtocart', begin_checkout: 'initiatecheckout', purchase: 'checkout'},
  snapchat: {page_view: 'PAGE_VIEW', sign_up: 'SIGN_UP', view_item: 'VIEW_CONTENT', add_to_cart: 'ADD_CART', begin_checkout: 'START_CHECKOUT', purchase: 'PURCHASE'},
  x: {page_view: 'configured', sign_up: 'configured', generate_lead: 'configured', view_item: 'configured', add_to_cart: 'configured', begin_checkout: 'configured', purchase: 'configured'},
};

// Providers whose mapping target is user-supplied; the FIXED_TARGETS value is a catalog placeholder.
const DYNAMIC_TARGETS: Partial<Record<Provider, string>> = {
  google_ads: 'Conversion label',
  linkedin: 'Conversion rule ID',
  x: 'Event ID (tw-<pixelId>-<event>)',
};

const consentSchema = z.object({
  analytics: z.boolean(),
  advertising: z.boolean(),
  adUserData: z.boolean(),
  adPersonalization: z.boolean(),
}).strict();
export type Consent = z.infer<typeof consentSchema>;

const REQUIRED_PURPOSES: Record<Provider, readonly (keyof Consent)[]> = {
  meta: ['advertising'],
  ga4: ['analytics'],
  google_ads: ['advertising', 'adUserData'],
  cloudflare: ['analytics'],
  tiktok: ['advertising'],
  linkedin: ['advertising'],
  microsoft_ads: ['advertising'],
  pinterest: ['advertising'],
  snapchat: ['advertising'],
  x: ['advertising'],
};

// Messages that are safe to surface: they never contain input values.
const SAFE_MESSAGES = new Set([
  'Invalid asset ID format',
  'Duplicate provider',
  'Duplicate event mapping',
  'Event not supported by provider',
  'Target must be omitted for this provider',
  'Target required for this provider',
  'Invalid conversion label',
  'Invalid conversion rule ID',
  'Invalid event ID for this asset',
  'value and currency must be provided together',
  'purchase and refund require value, currency and transactionId',
]);

function parseOr400<S extends z.ZodTypeAny>(schema: S, input: unknown, fallback: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const friendly = result.error.issues.map(issue => issue.message).find(message => SAFE_MESSAGES.has(message));
    throw new FoundationError(400, friendly ?? fallback);
  }
  return result.data;
}

function dynamicTargetError(provider: Provider, assetId: string, target: string): string | null {
  if (provider === 'google_ads') {
    return fullMatch(/^[A-Za-z0-9_-]{1,100}$/, target) ? null : 'Invalid conversion label';
  }
  if (provider === 'linkedin') {
    if (!fullMatch(/^\d{1,20}$/, target)) return 'Invalid conversion rule ID';
    const value = Number(target);
    return Number.isSafeInteger(value) && value > 0 ? null : 'Invalid conversion rule ID';
  }
  if (provider === 'x') {
    const match = /^tw-([A-Za-z0-9]{3,20})-([A-Za-z0-9]{1,64})$/.exec(target);
    return match !== null && match[0] === target && match[1] === assetId ? null : 'Invalid event ID for this asset';
  }
  return 'Target must be omitted for this provider';
}

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

const mappingSchema = z.object({
  event: z.enum(CANONICAL_EVENTS),
  target: z.string().min(1).max(128).optional(),
}).strict();

const destinationSchema = z.object({
  provider: z.enum(PROVIDERS),
  assetId: z.string().min(1).max(64),
  enabled: z.boolean(),
  owner: z.enum(['managed', 'external']),
  ownershipConfirmed: z.boolean(),
  mappings: z.array(mappingSchema).max(8),
}).strict().superRefine((destination, ctx) => {
  if (!fullMatch(ASSET_PATTERNS[destination.provider], destination.assetId)) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid asset ID format'});
  }
  const seen = new Set<string>();
  for (const mapping of destination.mappings) {
    if (seen.has(mapping.event)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate event mapping'});
    }
    seen.add(mapping.event);
    if (FIXED_TARGETS[destination.provider][mapping.event] === undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Event not supported by provider'});
      continue;
    }
    if (DYNAMIC_TARGETS[destination.provider] !== undefined) {
      if (mapping.target === undefined) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Target required for this provider'});
      } else {
        const error = dynamicTargetError(destination.provider, destination.assetId, mapping.target);
        if (error !== null) ctx.addIssue({code: z.ZodIssueCode.custom, message: error});
      }
    } else if (mapping.target !== undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Target must be omitted for this provider'});
    }
  }
});

const configurationSchema = z.object({
  destinations: z.array(destinationSchema).max(10),
}).strict().superRefine((configuration, ctx) => {
  const seen = new Set<string>();
  for (const destination of configuration.destinations) {
    if (seen.has(destination.provider)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate provider'});
    }
    seen.add(destination.provider);
  }
});

const eventPropertiesSchema = z.object({
  value: z.string().refine(v => fullMatch(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/, v) && Number(v) <= 1_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).refine(c => c !== 'XXX' && c !== 'XTS' && CURRENCIES.has(c)).optional(),
  transactionId: z.string().refine(v => fullMatch(/^[A-Za-z0-9_.:-]{1,128}$/, v)).optional(),
  itemId: z.string().refine(v => fullMatch(/^[A-Za-z0-9_.:-]{1,128}$/, v)).optional(),
}).strict().superRefine((properties, ctx) => {
  if ((properties.value === undefined) !== (properties.currency === undefined)) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'value and currency must be provided together'});
  }
});

const destinationEventSchema = z.object({
  name: z.enum(CANONICAL_EVENTS),
  properties: eventPropertiesSchema.optional(),
}).strict().superRefine((event, ctx) => {
  if (event.name === 'purchase' || event.name === 'refund') {
    const properties = event.properties;
    if (!properties || properties.value === undefined || properties.currency === undefined || properties.transactionId === undefined) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'purchase and refund require value, currency and transactionId'});
    }
  }
});

export type Destination = z.infer<typeof destinationSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type DestinationEvent = z.infer<typeof destinationEventSchema>;

export function parseDestinationConfiguration(input: unknown): Configuration {
  return parseOr400(configurationSchema, input, 'Invalid destination configuration');
}

export function parseDestinationEvent(input: unknown): DestinationEvent {
  return parseOr400(destinationEventSchema, input, 'Invalid event');
}

const LABELS: Record<Provider, string> = {
  meta: 'Meta (Facebook / Instagram)',
  ga4: 'Google Analytics 4',
  google_ads: 'Google Ads',
  cloudflare: 'Cloudflare Web Analytics',
  tiktok: 'TikTok Pixel',
  linkedin: 'LinkedIn Insight Tag',
  microsoft_ads: 'Microsoft Advertising (UET)',
  pinterest: 'Pinterest Tag',
  snapchat: 'Snapchat Pixel',
  x: 'X (Twitter) Pixel',
};

const ASSET_LABELS: Record<Provider, string> = {
  meta: 'Dataset / Pixel ID',
  ga4: 'Measurement ID',
  google_ads: 'Conversion ID',
  cloudflare: 'Beacon token',
  tiktok: 'Pixel code',
  linkedin: 'Partner ID',
  microsoft_ads: 'Tag ID',
  pinterest: 'Tag ID',
  snapchat: 'Pixel ID',
  x: 'Pixel ID',
};

const NOTES: Record<Provider, string> = {
  meta: 'Fixed Meta event presets only; refund and arbitrary custom events are unsupported. Disable automatic advanced matching and duplicate auto-events in Events Manager; ownership confirmation cannot prove no hidden tags exist.',
  ga4: 'All eight canonical events map 1:1; custom events are unsupported. GA4 shares one Google global with Google Ads, so managed and external ownership cannot be mixed when both are enabled. adPersonalization is passed independently and never inferred. GA4 may perform its own automatic observations outside explicit mappings.',
  google_ads: 'page_view and refund are unsupported. Each supported event invokes a conversion using your conversion label; consent requires advertising and adUserData. Shares one Google global with GA4; enhanced conversions and other automatic Google observations are controlled in vendor settings, not here.',
  cloudflare: 'page_view only via the sdk_pageview beacon; the official beacon owns initial and SPA observations automatically. Custom events and refund are unsupported; no custom-event calls are made.',
  tiktok: 'Uses the updated Purchase and Lead event names; refund and arbitrary custom events are unsupported.',
  linkedin: 'Explicit mappings fire conversions by rule ID; page_view and refund are unsupported for mappings because the Insight Tag performs its own initial sitewide observation.',
  microsoft_ads: 'All canonical events except refund; page_view uses the documented manual SPA page_view push.',
  pinterest: 'checkout is the purchase equivalent; refund and arbitrary custom events are unsupported.',
  snapchat: 'generate_lead and refund are unsupported; fixed uppercase event names only.',
  x: 'All canonical events except refund map to a configured event ID (tw-<pixelId>-<event>) whose prefix must match this pixel asset ID.',
};

export const catalog = PROVIDERS.map(provider => ({
  provider,
  label: LABELS[provider],
  assetLabel: ASSET_LABELS[provider],
  assetPattern: ASSET_PATTERNS[provider].source,
  events: CANONICAL_EVENTS.filter(event => FIXED_TARGETS[provider][event] !== undefined).map(event => ({
    event,
    target: FIXED_TARGETS[provider][event] as string,
    targetRequired: DYNAMIC_TARGETS[provider] !== undefined,
    ...(DYNAMIC_TARGETS[provider] !== undefined ? {targetLabel: DYNAMIC_TARGETS[provider]} : {}),
  })),
  purposes: [...REQUIRED_PURPOSES[provider]],
  notes: NOTES[provider],
}));

function previewRoute(destination: Destination, event: DestinationEvent, consent: Consent) {
  const base = {provider: destination.provider, assetId: destination.assetId, target: null as string | null, fields: [] as string[]};
  if (!destination.enabled) {
    return {...base, status: 'disabled' as const, reason: 'Destination is disabled'};
  }
  if (destination.owner === 'external') {
    return {...base, status: 'external' as const, reason: 'Externally owned destination: this vendor is never invoked or injected'};
  }
  const fixedTarget = FIXED_TARGETS[destination.provider][event.name];
  if (fixedTarget === undefined) {
    return {...base, status: 'unsupported' as const, reason: 'Event is not supported by this provider'};
  }
  for (const purpose of REQUIRED_PURPOSES[destination.provider]) {
    if (!consent[purpose]) {
      return {...base, status: 'consent_blocked' as const, reason: `Required consent missing: ${purpose}`};
    }
  }
  const mapping = destination.mappings.find(m => m.event === event.name);
  if (!mapping) {
    return {...base, status: 'unsupported' as const, reason: 'No mapping configured for this event'};
  }
  const target = DYNAMIC_TARGETS[destination.provider] !== undefined ? (mapping.target as string) : fixedTarget;
  return {
    provider: destination.provider,
    assetId: destination.assetId,
    target,
    status: 'would_invoke' as const,
    reason: 'Consent and mapping satisfied; the SDK would be invoked. Invocation is not a receipt.',
    fields: Object.keys(event.properties ?? {}).sort(),
  };
}

export function previewConfiguration(configuration: unknown, event: unknown, consent: unknown) {
  const parsedConfiguration = parseDestinationConfiguration(configuration);
  const parsedEvent = parseDestinationEvent(event);
  const parsedConsent = parseOr400(consentSchema, consent, 'Invalid consent');
  return {
    dryRun: true as const,
    event: parsedEvent.name,
    routes: parsedConfiguration.destinations.map(destination => previewRoute(destination, parsedEvent, parsedConsent)),
  };
}

interface StateRow {
  draft: unknown;
  draft_version: number;
  active_revision: string | null;
}

interface LockedProject {
  id: string;
  origin: string;
}

async function withAuthorizedState<T>(
  projectId: string,
  userId: string,
  environment: Environment,
  operation: (client: PoolClient, project: LockedProject, state: StateRow) => Promise<T>,
): Promise<T> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT workspace_id FROM project WHERE id = $1', [projectId]);
    if (found.rowCount !== 1) throw new FoundationError(404, 'Not found');
    await client.query('SELECT id FROM workspace WHERE id = $1 FOR UPDATE', [found.rows[0].workspace_id]);
    const authorized = await client.query(
      `SELECT p.id, p.origin, m.role
       FROM project p
       LEFT JOIN membership m ON m.workspace_id = p.workspace_id AND m.user_id = $2
       WHERE p.id = $1 FOR UPDATE OF p`,
      [projectId, userId],
    );
    const row = authorized.rows[0];
    if (!row || (row.role !== 'owner' && row.role !== 'admin')) throw new FoundationError(404, 'Not found');
    await client.query(
      `INSERT INTO tracking_state (project_id, environment) VALUES ($1, $2)
       ON CONFLICT (project_id, environment) DO NOTHING`,
      [projectId, environment],
    );
    const stateResult = await client.query(
      'SELECT draft, draft_version, active_revision FROM tracking_state WHERE project_id = $1 AND environment = $2 FOR UPDATE',
      [projectId, environment],
    );
    const result = await operation(client, {id: row.id as string, origin: row.origin as string}, stateResult.rows[0] as StateRow);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function managementDto(client: PoolClient, project: LockedProject, environment: Environment) {
  const stateResult = await client.query(
    'SELECT draft, draft_version, active_revision FROM tracking_state WHERE project_id = $1 AND environment = $2',
    [project.id, environment],
  );
  const state = stateResult.rows[0] as StateRow;
  let active = null;
  if (state.active_revision !== null) {
    const activeResult = await client.query(
      `SELECT id, number, consent_epoch, configuration, created_at
       FROM tracking_revision
       WHERE id = $1 AND project_id = $2 AND environment = $3`,
      [state.active_revision, project.id, environment],
    );
    const revision = activeResult.rows[0];
    if (revision) {
      active = {
        id: revision.id as string,
        number: revision.number as number,
        consentEpoch: revision.consent_epoch as string,
        configuration: revision.configuration,
        createdAt: new Date(revision.created_at).toISOString(),
      };
    }
  }
  const historyResult = await client.query(
    `SELECT id, number, created_at, rollback_of
     FROM tracking_revision
     WHERE project_id = $1 AND environment = $2
     ORDER BY number DESC
     LIMIT 20`,
    [project.id, environment],
  );
  return {
    project: {id: project.id, origin: project.origin},
    environment,
    draftVersion: state.draft_version,
    draft: state.draft,
    active,
    history: historyResult.rows.map(r => ({
      id: r.id as string,
      number: r.number as number,
      createdAt: new Date(r.created_at).toISOString(),
      rollbackOf: r.rollback_of as string | null,
    })),
    catalog,
  };
}

function assertPublishable(configuration: Configuration): void {
  for (const destination of configuration.destinations) {
    if (destination.enabled && destination.owner === 'managed' && !destination.ownershipConfirmed) {
      throw new FoundationError(400, 'Managed publishing requires ownershipConfirmed=true after operator review');
    }
  }
  const ga4 = configuration.destinations.find(d => d.provider === 'ga4' && d.enabled);
  const ads = configuration.destinations.find(d => d.provider === 'google_ads' && d.enabled);
  if (ga4 && ads && ga4.owner !== ads.owner) {
    throw new FoundationError(400, 'GA4 and Google Ads cannot mix managed and external ownership when both are enabled');
  }
}

async function insertRevision(
  client: PoolClient,
  projectId: string,
  environment: Environment,
  configuration: Configuration,
  userId: string,
  rollbackOf: string | null,
): Promise<string> {
  const next = await client.query(
    'SELECT COALESCE(MAX(number), 0) + 1 AS number FROM tracking_revision WHERE project_id = $1 AND environment = $2',
    [projectId, environment],
  );
  const id = randomUUID();
  await client.query(
    `INSERT INTO tracking_revision (id, project_id, environment, number, consent_epoch, configuration, created_by, rollback_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, projectId, environment, next.rows[0].number, randomUUID(), JSON.stringify(configuration), userId, rollbackOf],
  );
  return id;
}

const draftBodySchema = z.object({expectedVersion: z.number().int().min(0), configuration: z.unknown()}).strict();
const previewBodySchema = z.object({expectedVersion: z.number().int().min(0), event: z.unknown(), consent: z.unknown()}).strict();
const publishBodySchema = z.object({expectedVersion: z.number().int().min(0)}).strict();
const rollbackBodySchema = z.object({expectedVersion: z.number().int().min(0), revisionId: z.string().uuid()}).strict();

export async function getDestinations(projectId: unknown, userId: unknown, environment: unknown) {
  const env = parseOr400(environmentSchema, environment, 'Invalid environment');
  const pid = parseOr400(idSchema, projectId, 'Invalid project id');
  const uid = parseOr400(idSchema, userId, 'Invalid user id');
  return withAuthorizedState(pid, uid, env, (client, project) => managementDto(client, project, env));
}

export async function saveDestinationsDraft(projectId: unknown, userId: unknown, environment: unknown, input: unknown) {
  const env = parseOr400(environmentSchema, environment, 'Invalid environment');
  const pid = parseOr400(idSchema, projectId, 'Invalid project id');
  const uid = parseOr400(idSchema, userId, 'Invalid user id');
  const body = parseOr400(draftBodySchema, input, 'Invalid draft request');
  return withAuthorizedState(pid, uid, env, async (client, project, state) => {
    if (state.draft_version !== body.expectedVersion) throw new FoundationError(409, 'Draft version conflict');
    const configuration = parseDestinationConfiguration(body.configuration);
    await client.query(
      'UPDATE tracking_state SET draft = $1, draft_version = draft_version + 1 WHERE project_id = $2 AND environment = $3',
      [JSON.stringify(configuration), pid, env],
    );
    return managementDto(client, project, env);
  });
}

export async function previewDestinations(projectId: unknown, userId: unknown, environment: unknown, input: unknown) {
  const env = parseOr400(environmentSchema, environment, 'Invalid environment');
  const pid = parseOr400(idSchema, projectId, 'Invalid project id');
  const uid = parseOr400(idSchema, userId, 'Invalid user id');
  const body = parseOr400(previewBodySchema, input, 'Invalid preview request');
  return withAuthorizedState(pid, uid, env, async (_client, _project, state) => {
    if (state.draft_version !== body.expectedVersion) throw new FoundationError(409, 'Draft version conflict');
    return previewConfiguration(state.draft, body.event, body.consent);
  });
}

export async function publishDestinations(projectId: unknown, userId: unknown, environment: unknown, input: unknown) {
  const env = parseOr400(environmentSchema, environment, 'Invalid environment');
  const pid = parseOr400(idSchema, projectId, 'Invalid project id');
  const uid = parseOr400(idSchema, userId, 'Invalid user id');
  const body = parseOr400(publishBodySchema, input, 'Invalid publish request');
  return withAuthorizedState(pid, uid, env, async (client, project, state) => {
    if (state.draft_version !== body.expectedVersion) throw new FoundationError(409, 'Draft version conflict');
    const configuration = parseDestinationConfiguration(state.draft);
    assertPublishable(configuration);
    const revisionId = await insertRevision(client, pid, env, configuration, uid, null);
    await client.query(
      'UPDATE tracking_state SET active_revision = $1, draft_version = draft_version + 1 WHERE project_id = $2 AND environment = $3',
      [revisionId, pid, env],
    );
    return managementDto(client, project, env);
  });
}

export async function rollbackDestinations(projectId: unknown, userId: unknown, environment: unknown, input: unknown) {
  const env = parseOr400(environmentSchema, environment, 'Invalid environment');
  const pid = parseOr400(idSchema, projectId, 'Invalid project id');
  const uid = parseOr400(idSchema, userId, 'Invalid user id');
  const body = parseOr400(rollbackBodySchema, input, 'Invalid rollback request');
  return withAuthorizedState(pid, uid, env, async (client, project, state) => {
    if (state.draft_version !== body.expectedVersion) throw new FoundationError(409, 'Draft version conflict');
    const historical = await client.query(
      'SELECT id, configuration FROM tracking_revision WHERE id = $1 AND project_id = $2 AND environment = $3',
      [body.revisionId, pid, env],
    );
    if (historical.rowCount !== 1) throw new FoundationError(404, 'Not found');
    const configuration = parseDestinationConfiguration(historical.rows[0].configuration);
    assertPublishable(configuration);
    const revisionId = await insertRevision(client, pid, env, configuration, uid, body.revisionId);
    await client.query(
      'UPDATE tracking_state SET draft = $1, active_revision = $2, draft_version = draft_version + 1 WHERE project_id = $3 AND environment = $4',
      [JSON.stringify(configuration), revisionId, pid, env],
    );
    return managementDto(client, project, env);
  });
}

export async function getPublicDestinations(siteKey: unknown, environment: unknown, origin: unknown) {
  const key = parseOr400(z.string().uuid(), siteKey, 'Invalid site key');
  const env = parseOr400(environmentSchema, environment, 'Invalid environment');
  const requestedOrigin = parseOr400(z.string().min(1).max(2048), origin, 'Invalid origin');
  const client = await getDatabase().pool.connect();
  try {
  await client.query('BEGIN');
  await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE', [key]);
  const result = await client.query(
    `SELECT p.id, p.origin, p.analytics_settings, p.analytics_epoch, r.id AS revision_id, r.consent_epoch, r.configuration
     FROM project p
     LEFT JOIN tracking_state s ON s.project_id = p.id AND s.environment = $2
     LEFT JOIN tracking_revision r ON r.id = s.active_revision AND r.project_id = p.id AND r.environment = $2
     WHERE p.public_key = $1`,
    [key, env],
  );
  const row = result.rows[0];
  if (!row || !await collectionOriginAllowed(client, requestedOrigin, row)) throw new FoundationError(404, 'Not found');
  const hasActive = typeof row.revision_id === 'string';
  const configuration = {
    schemaVersion: 3 as const,
    siteKey: key,
    environment: env,
    origin: requestedOrigin,
    revisionId: hasActive ? (row.revision_id as string) : null,
    consentEpoch: trackingConsentEpoch(row.analytics_epoch, hasActive ? row.consent_epoch : null),
    nativeTracking: publicTrackingSettings(row.analytics_settings),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    configuration: hasActive ? parseDestinationConfiguration(row.configuration) : {destinations: []},
  };
  await client.query('COMMIT');
  return configuration;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
