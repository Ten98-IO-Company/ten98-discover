// Adapted from Elmo 0.4.4 (3c673d0253d01ae030fa41519f62ad7e54f2281b) apps/web/src/lib/chart-utils.ts
// Copyright (c) 2026 Blue Whale Software, LLC. MIT License; see THIRD_PARTY_NOTICES.md.

/**
 * Walk each prompt's series across `dateRange`, carrying its last observation
 * forward over the days it didn't run. Pre-seeded with the prompt's earliest
 * observation so days before its first run still contribute — otherwise a
 * staggered schedule reads as a ramp-up rather than steady coverage.
 */
function carryForward<V>(
	byPrompt: Map<string, Map<string, V>>,
	dateRange: string[],
	visit: (promptId: string, date: string, carried: V, actual: V | undefined) => void,
): void {
	for (const [promptId, byDate] of byPrompt) {
		const earliest = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
		let carried = earliest;
		for (const date of dateRange) {
			const actual = byDate.get(date);
			if (actual !== undefined) carried = actual;
			if (carried === undefined) continue;
			visit(promptId, date, carried, actual);
		}
	}
}

/**
 * Generalized per-prompt LVCF with cadence normalization over arbitrary string
 * keys (citation category, page type, …). For each prompt, carries forward its
 * last known per-key counts, normalized by the brand's cadence so daily totals
 * reflect a steady rate rather than spiking on run days. Pre-seeds each prompt
 * with its earliest observation to avoid ramp-up artifacts.
 */
export function applyPerPromptKeyedLVCF<K extends string>(
	rows: { prompt_id: string; date: string | Date; key: K; count: number }[],
	dateRange: string[],
	cadenceHours: number | null | undefined,
	allKeys: readonly K[],
): Map<string, Record<K, number>> {
	// Stack glue: Elmo's getDefaultDelayHours() is a deployment setting; Discover has no
	// per-brand cadence, so the fallback is a daily cadence.
	const cadenceDays = Math.max(1, Math.ceil((cadenceHours ?? 24) / 24));
	const empty = (): Record<K, number> => Object.fromEntries(allKeys.map((k) => [k, 0])) as Record<K, number>;

	const byPrompt = new Map<string, Map<string, Record<K, number>>>();
	for (const row of rows) {
		const byDate = byPrompt.get(row.prompt_id) ?? new Map<string, Record<K, number>>();
		const date = String(row.date);
		const counts = byDate.get(date) ?? empty();
		counts[row.key] += Number(row.count);
		byDate.set(date, counts);
		byPrompt.set(row.prompt_id, byDate);
	}

	const daily = new Map<string, Record<K, number>>();
	carryForward(byPrompt, dateRange, (_promptId, date, carried) => {
		const day = daily.get(date) ?? empty();
		for (const key of allKeys) day[key] += carried[key] / cadenceDays;
		daily.set(date, day);
	});

	// Values are intentionally left fractional: both consumers
	// convert to percentages via toRoundedPercentages, where the 1/cadenceDays factor
	// cancels exactly — so cadence can't shift the chart, and a tiny category isn't
	// rounded to zero before the percentage is taken.
	return daily;
}

export type CarriedCitationAxisName = 'ownership' | 'publisher' | 'pageType' | 'sourceType';
export type CarriedCitationAxis = { key: string; values: number[] };
export type CarriedCitations = {
	method: 'elmo-lvcf-v1';
	dates: string[];
	/** True when at least one eligible answer was actually observed that day; false days are carried only. */
	observed: boolean[];
	axes: Record<CarriedCitationAxisName, CarriedCitationAxis[]>;
};
export type CarriedCitationInput = { promptId: string; date: string; keys: Record<CarriedCitationAxisName, string> };

/**
 * Discover adapter: carries each prompt's last per-day citation counts for every source axis. An eligible
 * answer with no citations is a real zero observation, so it is supplied as a zero-count row rather than
 * being replaced by an older day's counts.
 */
export function carriedCitations(
	citations: CarriedCitationInput[],
	eligible: { promptId: string; date: string }[],
	dates: string[],
	axisKeys: Record<CarriedCitationAxisName, readonly string[]>,
): CarriedCitations {
	const axes = {} as CarriedCitations['axes'];
	for (const axis of Object.keys(axisKeys) as CarriedCitationAxisName[]) {
		const allKeys = axisKeys[axis];
		const rows = [
			...eligible.map((o) => ({ prompt_id: o.promptId, date: o.date, key: allKeys[0], count: 0 })),
			...citations.map((c) => ({ prompt_id: c.promptId, date: c.date, key: c.keys[axis], count: 1 })),
		];
		const daily = applyPerPromptKeyedLVCF(rows, dates, 24, allKeys);
		axes[axis] = allKeys.map((key) => ({ key, values: dates.map((date) => daily.get(date)?.[key] ?? 0) }));
	}
	const seen = new Set(eligible.map((o) => o.date));
	return { method: 'elmo-lvcf-v1', dates, observed: dates.map((date) => seen.has(date)), axes };
}
