import type { z } from 'zod';
import type { contentSupportSelectionSchema, contentSupportDependenciesSchema, contentSupportProposalSchema } from '../lib/ai-content-support.ts';
import type { ContentSupportSnapshot } from './ai-content-support-input.ts';
import type { RenderedInput, RouteSnapshot } from './openrouter-input.ts';

// PostgreSQL0043 columns plus the aliases selected by supportQuoteRow/supportRunRow.
// pg returns int8 amounts as strings and native timestamptz values as Dates.
type Selection = z.output<typeof contentSupportSelectionSchema>;
export type SupportQuoteRow = {
 id: string; workspace_id: string; project_id: string; user_id: string; request_id: string;
 connection_id: string; connection_revision: number; request_actor: string; key_fingerprint: string;
 source_kind: 'capture' | 'project'; audit_run_id: string; input_hash: string; payload_hash: string; schema_hash: string; business_input_hash: string | null;
 query_receipt_hash: string; corpus_receipt_hash: string; source_context_revision: number | null; source_profile_hash: string | null;
 retention_revision: number; raw_days_at_quote: number; derived_days_at_quote: number;
 source_input: Record<string,unknown> | null;
 snapshot: { evidence: ContentSupportSnapshot; selection: Selection } | null;
 messages: RenderedInput | null; dependencies: z.output<typeof contentSupportDependenciesSchema>; route: RouteSnapshot;
 request_version: number; estimate_micros: string|null; max_spend_micros: string|null; raw_expired_at: Date | null; input_purged_at: Date | null;
 created_at: Date; expires_at: Date; raw_anchor_at: Date; derived_anchor_at: Date;
 quote_created: string; quote_expires: string; raw_anchor: string; derived_anchor: string; quote_expired: boolean;
};
export type SupportRunRow = {
 id: string; quote_id: string; workspace_id: string; project_id: string; user_id: string; request_id: string;
 status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'cancelled';
 lease_owner: string | null; lease_expires_at: Date | null; lease_expired: boolean | null;
 generation_id: string | null; dispatched_at: Date | null; completed_at: Date | null; created_at: Date;
 raw_result: string | null; proposal: z.output<typeof contentSupportProposalSchema> | null;
 request_evidence: Record<string,unknown>|null; diagnostic: string | null; result_purged_at: Date | null;
 run_created: string; run_dispatched: string | null; run_completed: string | null;
 request_status: 'reserved' | 'dispatched' | 'settled' | 'uncertain' | 'cancelled';
 request_input_hash: string;
 request_connection_id: string; request_user_id: string; request_connection_revision: number; request_operation: string;
};
// The pure identity hash accepts pre-insert and deliberately tampered records.
// Its unknown fields grant no authority; persisted rows have the types above.
export type SupportQuoteIdentityInput = Record<string, unknown>;
export type SupportPayloadInput = SupportQuoteIdentityInput & {
 user_id: string; source_kind: string; audit_run_id: string; input_hash: string; messages: unknown;
};
