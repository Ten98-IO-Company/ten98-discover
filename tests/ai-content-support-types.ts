import type {supportQuoteRow,supportRunRow,supportRunDto,cancelSupportReservation} from '../src/server/ai-content-support.ts';
type IsAny<T> = 0 extends (1 & T) ? true : false;
type RequireFalse<T extends false> = T;
type Quote = Awaited<ReturnType<typeof supportQuoteRow>>;
type Run = Awaited<ReturnType<typeof supportRunRow>>;
export type CheckedServiceRows = [RequireFalse<IsAny<Quote>>,RequireFalse<IsAny<Run>>,RequireFalse<IsAny<Parameters<typeof supportRunDto>[2]>>,RequireFalse<IsAny<Parameters<typeof cancelSupportReservation>[1]>>];

export function checkNativeRowContracts(run: Run, quote: Quote) {
 // @ts-expect-error PostgreSQL int8 amounts must retain their exact decimal strings.
 run.estimate_micros = 1;
 // @ts-expect-error Ledger identity revisions are integers, not provider strings.
 run.ledger_connection_revision = '1';
 // @ts-expect-error Nullable SQL lease comparisons cannot be used as definite booleans.
 const active: boolean = run.lease_expired;
 // @ts-expect-error Native dispatch timestamps require a null guard.
 run.dispatched_at.toISOString();
 // @ts-expect-error Native timestamps and exact formatted aliases are different representations.
 run.run_dispatched = new Date();
 // @ts-expect-error Purged stored payloads require a null guard.
 quote.snapshot.selection;
 return active;
}
