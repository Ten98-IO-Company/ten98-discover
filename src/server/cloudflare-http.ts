import {providerFetchJson} from '@ten98/runtime';
import {z} from 'zod';

// Contracts: https://developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/list/
// https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/
// https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/
const origin = 'https://api.cloudflare.com/client/v4';
const identifier = z.string().regex(/^[a-fA-F0-9]{32}$/);
const name = z.string().max(256).regex(/^[_A-Za-z][_0-9A-Za-z]*$/);
const text = z.string().max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenInput = z.string().min(1).max(4096).regex(/^[A-Za-z0-9._~-]+$/);
export type CloudflareTransportOptions = {signal?: AbortSignal; fetch?: (url: string, init: RequestInit) => Promise<Response>};
type Failure = 'input' | 'denied' | 'rate_limited' | 'unavailable' | 'timeout' | 'cancelled' | 'invalid_response' | 'incomplete';
const messages: Record<Failure, string> = {
  input: 'Check the Cloudflare connection fields.', denied: 'Cloudflare denied access to this connection.',
  rate_limited: 'Cloudflare limited this request. Check again later.', unavailable: 'Cloudflare could not be reached.',
  timeout: 'The Cloudflare check timed out.', cancelled: 'The Cloudflare check was cancelled.',
  invalid_response: 'Cloudflare returned an unsupported response.', incomplete: 'The complete Cloudflare site list could not be verified.',
};
export class CloudflareTransportError extends Error {
  readonly code: Failure;
  constructor(code: Failure) { super(messages[code]); this.name = 'CloudflareTransportError'; this.code = code; }
}
function parse<T extends z.ZodType>(schema: T, value: unknown, code: Failure = 'invalid_response'): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CloudflareTransportError(code);
  return result.data;
}
async function request(path: string, token: string, options: CloudflareTransportOptions, query?: string): Promise<unknown> {
  parse(tokenInput, token, 'input');
  try {
    const result = await providerFetchJson(origin + path, {hosts: ['api.cloudflare.com'], timeoutMs: 5000, maxBytes: 524288,
      signal: options.signal, fetch: options.fetch,
      init: {method: query === undefined ? 'GET' : 'POST', headers: {accept: 'application/json', authorization: `Bearer ${token}`,
        ...(query === undefined ? {} : {'content-type': 'application/json'})}, ...(query === undefined ? {} : {body: JSON.stringify({query})})}});
    if (!result.ok) throw new CloudflareTransportError(result.status === 401 || result.status === 403 ? 'denied' : result.status === 429 ? 'rate_limited' : 'unavailable');
    if (result.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new CloudflareTransportError('invalid_response');
    return result.body;
  } catch (error) {
    if (options.signal?.aborted) throw new CloudflareTransportError('cancelled');
    if (error instanceof CloudflareTransportError) throw error;
    const code = (error as {code?: unknown} | null)?.code;
    throw new CloudflareTransportError(code === 'PROVIDER_TIMEOUT' ? 'timeout' : code === 'PROVIDER_RESPONSE_INVALID' ? 'invalid_response' : 'unavailable');
  }
}

// Optional provider fields stay absent. In particular, ruleset.zone_name is not a site's hostname.
const site = z.object({site_tag: identifier,
  rules: z.array(z.object({host: text.optional(), inclusive: z.boolean().optional(), is_paused: z.boolean().optional(),
    paths: z.array(text).max(100).optional()})).max(100).optional(),
  ruleset: z.object({enabled: z.boolean().optional(), zone_name: text.optional(), zone_tag: identifier.optional()}).optional(),
});
export type CloudflareSite = z.output<typeof site>;
const sitePage = z.object({success: z.literal(true), errors: z.array(z.unknown()).length(0), result: z.array(site).max(50),
  result_info: z.object({count: integer, page: integer.min(1), per_page: integer.min(1).max(50), total_count: integer.max(1000), total_pages: integer.max(20)})});

/** No partial list is returned; selection must use an account's fully checked inventory. */
export async function listCloudflareSites(accountId: string, token: string, options: CloudflareTransportOptions = {}): Promise<CloudflareSite[]> {
  parse(identifier, accountId, 'input');
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  const sites: CloudflareSite[] = [], seen = new Set<string>();
  let total: number | undefined, pages: number | undefined, perPage: number | undefined;
  try { for (let page = 1; page <= 20; page++) {
    const result = parse(sitePage, await request(`/accounts/${accountId}/rum/site_info/list?page=${page}&per_page=50&order_by=created`, token, {...options, signal}));
    const info = result.result_info;
    if (info.page !== page || info.count !== result.result.length || info.count !== Math.min(info.per_page, Math.max(0, info.total_count - (page - 1) * info.per_page))
      || info.total_pages !== Math.ceil(info.total_count / info.per_page) && !(info.total_count === 0 && info.total_pages === 1)
      || total !== undefined && (total !== info.total_count || pages !== info.total_pages || perPage !== info.per_page)) throw new CloudflareTransportError('incomplete');
    total = info.total_count; pages = info.total_pages; perPage = info.per_page;
    for (const value of result.result) {
      const key = value.site_tag.toLowerCase();
      if (seen.has(key)) throw new CloudflareTransportError('incomplete');
      seen.add(key); sites.push(value);
    }
    if (page >= pages) {
      if (sites.length !== total) throw new CloudflareTransportError('incomplete');
      return sites;
    }
  } } catch (error) {
    if (signal.aborted && !options.signal?.aborted) throw new CloudflareTransportError('timeout');
    throw error;
  }
  throw new CloudflareTransportError('incomplete');
}

async function graphql<T extends z.ZodType>(token: string, query: string, data: T, options: CloudflareTransportOptions): Promise<z.output<T>> {
  const envelope = z.object({data: z.unknown(), errors: z.array(z.unknown()).length(0).nullish()}).strict();
  return parse(data, parse(envelope, await request('/graphql', token, options, query)).data);
}
const settings = z.object({enabled: z.boolean(), availableFields: z.array(name).max(2048), maxPageSize: integer,
  maxNumberOfFields: integer, notOlderThan: integer, maxDuration: integer}).strict();
export type CloudflareCapabilities = z.output<typeof settings>;

/** Capability evidence only; this does not certify metric field meanings or execute a metric query. */
export async function inspectCloudflareCapabilities(accountId: string, token: string, options: CloudflareTransportOptions = {}): Promise<CloudflareCapabilities> {
  parse(identifier, accountId, 'input');
  const data = z.object({viewer: z.object({accounts: z.array(z.object({settings: z.object({rumPageloadEventsAdaptiveGroups: settings}).strict()}).strict()).length(1)}).strict()}).strict();
  const result = await graphql(token, `query { viewer { accounts(filter: {accountTag: "${accountId}"}) { settings { rumPageloadEventsAdaptiveGroups { enabled availableFields maxPageSize maxNumberOfFields notOlderThan maxDuration } } } } }`, data, options);
  const value = result.viewer.accounts[0].settings.rumPageloadEventsAdaptiveGroups;
  if (new Set(value.availableFields).size !== value.availableFields.length || value.enabled && (!value.maxPageSize || !value.maxNumberOfFields || !value.maxDuration)) throw new CloudflareTransportError('invalid_response');
  return value;
}

const namedKind = z.enum(['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT']);
type TypeRef = {kind: z.output<typeof namedKind> | 'LIST' | 'NON_NULL'; name: string | null; ofType?: TypeRef | null};
const namedReference = z.object({kind: namedKind, name, ofType: z.null().optional()}).strict();
// Match the requested introspection depth; a truncated or excessively nested type is unavailable.
let typeRef: z.ZodType<TypeRef> = namedReference;
for (let depth = 0; depth < 3; depth++) typeRef = z.union([namedReference,
  z.object({kind: z.enum(['LIST', 'NON_NULL']), name: z.null(), ofType: typeRef}).strict()]);
const inputField = z.object({name, type: typeRef}).strict();
const schemaType = z.object({name, kind: namedKind, fields: z.array(z.object({name, type: typeRef, args: z.array(inputField).max(100)}).strict()).max(2048).nullable(),
  inputFields: z.array(inputField).max(2048).nullable(), enumValues: z.array(z.object({name}).strict()).max(2048).nullable()}).strict();
export type CloudflareSchemaType = z.output<typeof schemaType>;
const reference = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';

/** Discover names from the API rather than guessing Cloudflare's generated type names. */
export async function cloudflareQueryType(token: string, options: CloudflareTransportOptions = {}): Promise<string> {
  const data = z.object({__schema: z.object({queryType: z.object({name}).strict()}).strict()}).strict();
  return (await graphql(token, 'query { __schema { queryType { name } } }', data, options)).__schema.queryType.name;
}
export async function inspectCloudflareType(token: string, typeName: string, options: CloudflareTransportOptions = {}): Promise<CloudflareSchemaType> {
  parse(name, typeName, 'input');
  const query = `query { __type(name: "${typeName}") { name kind fields { name type { ${reference} } args { name type { ${reference} } } } inputFields { name type { ${reference} } } enumValues { name } } }`;
  const result = (await graphql(token, query, z.object({__type: schemaType}).strict(), options)).__type;
  if (result.name !== typeName || new Set(result.fields?.map(field => field.name)).size !== (result.fields?.length ?? 0)
    || result.fields?.some(field => new Set(field.args.map(arg => arg.name)).size !== field.args.length)
    || new Set(result.inputFields?.map(field => field.name)).size !== (result.inputFields?.length ?? 0)
    || new Set(result.enumValues?.map(value => value.name)).size !== (result.enumValues?.length ?? 0)
    || (result.kind === 'OBJECT' || result.kind === 'INTERFACE') !== (result.fields !== null)
    || (result.kind === 'INPUT_OBJECT') !== (result.inputFields !== null) || (result.kind === 'ENUM') !== (result.enumValues !== null)) throw new CloudflareTransportError('invalid_response');
  return result;
}
