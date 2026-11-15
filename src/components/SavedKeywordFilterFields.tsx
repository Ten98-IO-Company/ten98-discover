// src/components/SavedKeywordFilterFields.tsx
import {Checkbox, Disclosure, Field, Fieldset, Inline, Input, Option, Select, Stack, Text, Textarea} from '@ten98/ui';
export type SavedKeywordFilterDraft = {
  search: string; includeTerms: string; excludeTerms: string;
  locationCode: string; languageCode: string; tagIds: string[];
  minVolume: string; maxVolume: string; minCpcUsd: string; maxCpcUsd: string;
  minDifficulty: string; maxDifficulty: string;
  metrics: 'all' | 'available' | 'unavailable' | 'expired';
  sort: 'createdAt' | 'keyword' | 'searchVolume' | 'cpcUsd' | 'competition' | 'keywordDifficulty' | 'fetchedAt';
  order: 'asc' | 'desc';
};
type SavedKeywordTagOption = { id: string; name: string; color: string | null };
export const emptySavedKeywordFilters: () => SavedKeywordFilterDraft = () => ({
  search: '', includeTerms: '', excludeTerms: '', locationCode: '', languageCode: '',
  tagIds: [], minVolume: '', maxVolume: '', minCpcUsd: '', maxCpcUsd: '',
  minDifficulty: '', maxDifficulty: '', metrics: 'all', sort: 'createdAt', order: 'desc',
});

export function SavedKeywordFilterFields({ value, onChange, tags, disabled = false, prefix }: {
  value: SavedKeywordFilterDraft;
  onChange: (value: SavedKeywordFilterDraft) => void;
  tags: SavedKeywordTagOption[];
  disabled?: boolean;
  prefix: string;
}) {
  const phraseHint = 'One phrase per line. All included phrases must match; excluded phrases must not match.';
  const set = <K extends keyof SavedKeywordFilterDraft>(key: K, next: SavedKeywordFilterDraft[K]) => onChange({ ...value, [key]: next });
  return (
    <Fieldset legend="Saved keyword filters" disabled={disabled}>
      <Inline align="end">
        <Field label="Search" htmlFor={`${prefix}-search`}>
          <Input id={`${prefix}-search`} type="search" maxLength={200} value={value.search} onChange={(e) => set('search', e.target.value)} />
        </Field>
        <Field label="Sort" htmlFor={`${prefix}-sort`}>
          <Select id={`${prefix}-sort`} value={value.sort} onChange={(e) => set('sort', e.target.value as SavedKeywordFilterDraft['sort'])}>
            <Option value="createdAt">Created</Option>
            <Option value="keyword">Keyword</Option>
            <Option value="searchVolume">Search volume</Option>
            <Option value="cpcUsd">CPC (USD)</Option>
            <Option value="competition">Competition</Option>
            <Option value="keywordDifficulty">Difficulty</Option>
            <Option value="fetchedAt">Last observed</Option>
          </Select>
        </Field>
        <Field label="Direction" htmlFor={`${prefix}-order`}>
          <Select id={`${prefix}-order`} value={value.order} onChange={(e) => set('order', e.target.value as SavedKeywordFilterDraft['order'])}>
            <Option value="desc">Descending</Option>
            <Option value="asc">Ascending</Option>
          </Select>
        </Field>
      </Inline>
      <Disclosure summary="More filters" variant="plain">
        <Stack>
          <Field label="Include phrases" htmlFor={`${prefix}-include-terms`} description={phraseHint}>
            <Textarea id={`${prefix}-include-terms`} rows={3} maxLength={4020} value={value.includeTerms} onChange={(e) => set('includeTerms', e.target.value)} />
          </Field>
          <Field label="Exclude phrases" htmlFor={`${prefix}-exclude-terms`} description={phraseHint}>
            <Textarea id={`${prefix}-exclude-terms`} rows={3} maxLength={4020} value={value.excludeTerms} onChange={(e) => set('excludeTerms', e.target.value)} />
          </Field>
          <Inline align="start">
            <Field label="Location code" htmlFor={`${prefix}-location-code`} description="Leave blank for every location.">
              <Input id={`${prefix}-location-code`} type="number" min={1} max={2147483647} step={1} value={value.locationCode} onChange={(e) => set('locationCode', e.target.value)} />
            </Field>
            <Field label="Language code" htmlFor={`${prefix}-language-code`}>
              <Input id={`${prefix}-language-code`} type="text" maxLength={6} placeholder="en or en-US" value={value.languageCode} onChange={(e) => set('languageCode', e.target.value)} />
            </Field>
          </Inline>
          <Inline align="start">
            <Field label="Min search volume" htmlFor={`${prefix}-min-volume`}>
              <Input id={`${prefix}-min-volume`} type="number" min={0} max={9007199254740991} step={1} value={value.minVolume} onChange={(e) => set('minVolume', e.target.value)} />
            </Field>
            <Field label="Max search volume" htmlFor={`${prefix}-max-volume`}>
              <Input id={`${prefix}-max-volume`} type="number" min={0} max={9007199254740991} step={1} value={value.maxVolume} onChange={(e) => set('maxVolume', e.target.value)} />
            </Field>
          </Inline>
          <Inline align="start">
            <Field label="Min CPC (USD)" htmlFor={`${prefix}-min-cpc`} description="USD per click; blank means no limit.">
              <Input id={`${prefix}-min-cpc`} type="text" inputMode="decimal" maxLength={14} value={value.minCpcUsd} onChange={(e) => set('minCpcUsd', e.target.value)} />
            </Field>
            <Field label="Max CPC (USD)" htmlFor={`${prefix}-max-cpc`} description="USD per click; blank means no limit.">
              <Input id={`${prefix}-max-cpc`} type="text" inputMode="decimal" maxLength={14} value={value.maxCpcUsd} onChange={(e) => set('maxCpcUsd', e.target.value)} />
            </Field>
          </Inline>
          <Inline align="start">
            <Field label="Min difficulty" htmlFor={`${prefix}-min-difficulty`}>
              <Input id={`${prefix}-min-difficulty`} type="number" min={0} max={100} step={1} value={value.minDifficulty} onChange={(e) => set('minDifficulty', e.target.value)} />
            </Field>
            <Field label="Max difficulty" htmlFor={`${prefix}-max-difficulty`}>
              <Input id={`${prefix}-max-difficulty`} type="number" min={0} max={100} step={1} value={value.maxDifficulty} onChange={(e) => set('maxDifficulty', e.target.value)} />
            </Field>
          </Inline>
          <Field label="Metric state" htmlFor={`${prefix}-metrics`}>
            <Select id={`${prefix}-metrics`} value={value.metrics} onChange={(e) => set('metrics', e.target.value as SavedKeywordFilterDraft['metrics'])}>
              <Option value="all">All metrics</Option>
              <Option value="available">Available metrics</Option>
              <Option value="unavailable">Not observed</Option>
              <Option value="expired">Expired metrics</Option>
            </Select>
          </Field>
          <Fieldset legend="Tags">
            {tags.length === 0 ? (
              <Text tone="muted" size="sm">Tags appear after you add them to saved keywords.</Text>
            ) : (
              <>
                {tags.map((tag) => (
                  <Checkbox key={tag.id} id={`${prefix}-tag-${tag.id}`} label={tag.name} checked={value.tagIds.includes(tag.id)} onChange={(e) => set('tagIds',
                    e.target.checked
                      ? value.tagIds.includes(tag.id) ? value.tagIds : [...value.tagIds, tag.id]
                      : value.tagIds.filter((id) => id !== tag.id))} />
                ))}
                {value.tagIds.length > 0 && <Text tone="muted" size="sm">Any selected tag matches.</Text>}
              </>
            )}
          </Fieldset>
        </Stack>
      </Disclosure>
    </Fieldset>
  );
}
