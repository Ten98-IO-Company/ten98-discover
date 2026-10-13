// src/components/SavedKeywordFilterFields.tsx
export type SavedKeywordFilterDraft = {
  search: string; includeTerms: string; excludeTerms: string;
  locationCode: string; languageCode: string; tagIds: string[];
  minVolume: string; maxVolume: string; minCpcUsd: string; maxCpcUsd: string;
  minDifficulty: string; maxDifficulty: string;
  metrics: 'all' | 'available' | 'unavailable' | 'expired';
  sort: 'createdAt' | 'keyword' | 'searchVolume' | 'cpcUsd' | 'competition' | 'keywordDifficulty' | 'fetchedAt';
  order: 'asc' | 'desc';
};
export type SavedKeywordTagOption = { id: string; name: string; color: string | null };
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
  return (
    <fieldset className="saved-keyword-filter-grid" disabled={disabled}>
      <legend>Saved keyword filters</legend>
      <div className="row">
        <div className="field">
          <label htmlFor={`${prefix}-search`}>Search</label>
          <input id={`${prefix}-search`} type="search" maxLength={200} value={value.search} onChange={(e) => onChange({ ...value, search: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-sort`}>Sort</label>
          <select id={`${prefix}-sort`} value={value.sort} onChange={(e) => onChange({ ...value, sort: e.target.value as SavedKeywordFilterDraft['sort'] })}>
            <option value="createdAt">Created</option>
            <option value="keyword">Keyword</option>
            <option value="searchVolume">Search volume</option>
            <option value="cpcUsd">CPC (USD)</option>
            <option value="competition">Competition</option>
            <option value="keywordDifficulty">Difficulty</option>
            <option value="fetchedAt">Last observed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-order`}>Direction</label>
          <select id={`${prefix}-order`} value={value.order} onChange={(e) => onChange({ ...value, order: e.target.value as SavedKeywordFilterDraft['order'] })}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </div>
      </div>
      <details>
        <summary>More filters</summary>
        <div className="field">
          <label htmlFor={`${prefix}-include-terms`}>Include phrases</label>
          <textarea id={`${prefix}-include-terms`} rows={3} maxLength={4020} value={value.includeTerms} onChange={(e) => onChange({ ...value, includeTerms: e.target.value })} />
          <p className="hint">{phraseHint}</p>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-exclude-terms`}>Exclude phrases</label>
          <textarea id={`${prefix}-exclude-terms`} rows={3} maxLength={4020} value={value.excludeTerms} onChange={(e) => onChange({ ...value, excludeTerms: e.target.value })} />
          <p className="hint">{phraseHint}</p>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor={`${prefix}-location-code`}>Location code</label>
            <input id={`${prefix}-location-code`} type="number" min={1} max={2147483647} step={1} value={value.locationCode} onChange={(e) => onChange({ ...value, locationCode: e.target.value })} />
            <p className="hint">Leave blank for every location.</p>
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-language-code`}>Language code</label>
            <input id={`${prefix}-language-code`} type="text" maxLength={6} placeholder="en or en-US" value={value.languageCode} onChange={(e) => onChange({ ...value, languageCode: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor={`${prefix}-min-volume`}>Min search volume</label>
            <input id={`${prefix}-min-volume`} type="number" min={0} max={9007199254740991} step={1} value={value.minVolume} onChange={(e) => onChange({ ...value, minVolume: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-max-volume`}>Max search volume</label>
            <input id={`${prefix}-max-volume`} type="number" min={0} max={9007199254740991} step={1} value={value.maxVolume} onChange={(e) => onChange({ ...value, maxVolume: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor={`${prefix}-min-cpc`}>Min CPC (USD)</label>
            <input id={`${prefix}-min-cpc`} type="text" inputMode="decimal" maxLength={14} value={value.minCpcUsd} onChange={(e) => onChange({ ...value, minCpcUsd: e.target.value })} />
            <p className="hint">USD per click; blank means no limit.</p>
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-max-cpc`}>Max CPC (USD)</label>
            <input id={`${prefix}-max-cpc`} type="text" inputMode="decimal" maxLength={14} value={value.maxCpcUsd} onChange={(e) => onChange({ ...value, maxCpcUsd: e.target.value })} />
            <p className="hint">USD per click; blank means no limit.</p>
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor={`${prefix}-min-difficulty`}>Min difficulty</label>
            <input id={`${prefix}-min-difficulty`} type="number" min={0} max={100} step={1} value={value.minDifficulty} onChange={(e) => onChange({ ...value, minDifficulty: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-max-difficulty`}>Max difficulty</label>
            <input id={`${prefix}-max-difficulty`} type="number" min={0} max={100} step={1} value={value.maxDifficulty} onChange={(e) => onChange({ ...value, maxDifficulty: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-metrics`}>Metric state</label>
          <select id={`${prefix}-metrics`} value={value.metrics} onChange={(e) => onChange({ ...value, metrics: e.target.value as SavedKeywordFilterDraft['metrics'] })}>
            <option value="all">All metrics</option>
            <option value="available">Available metrics</option>
            <option value="unavailable">Not observed</option>
            <option value="expired">Expired metrics</option>
          </select>
        </div>
        <fieldset className="field">
          <legend>Tags</legend>
          {tags.length === 0 ? (
            <p className="hint">Tags appear after you add them to saved keywords.</p>
          ) : (
            <>
              {tags.map((tag) => (
                <div className="field" key={tag.id}>
                  <input id={`${prefix}-tag-${tag.id}`} type="checkbox" checked={value.tagIds.includes(tag.id)} onChange={(e) => onChange({
                    ...value,
                    tagIds: e.target.checked
                      ? value.tagIds.includes(tag.id) ? value.tagIds : [...value.tagIds, tag.id]
                      : value.tagIds.filter((id) => id !== tag.id),
                  })} />
                  <label htmlFor={`${prefix}-tag-${tag.id}`}>{tag.name}</label>
                </div>
              ))}
              {value.tagIds.length > 0 && <p className="hint">Any selected tag matches.</p>}
            </>
          )}
        </fieldset>
      </details>
    </fieldset>
  );
}
