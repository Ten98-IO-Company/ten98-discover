import type * as React from 'react';

type RankDepth = 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;
type RankPageCap = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type RankTrackingFieldsValue = {
  domain: string;
  countryLocationCode: string;
  targeting: 'national' | 'local';
  localLocationCode: string;
  languageCode: string;
  devices: 'desktop' | 'mobile' | 'both';
  depth: RankDepth;
  maxCrawlPages: RankPageCap;
};

export type RankLocationOption = {
  code: string;
  label: string;
  countryIso?: string;
};

export type RankLocationOptions = {
  query: string;
  options: readonly RankLocationOption[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
};

export type RankLanguageOption = { code: string; label: string };

export type RankTrackingFieldErrors = Partial<Record<keyof RankTrackingFieldsValue, string>>;

export type RankTrackingFieldsProps = {
  value: RankTrackingFieldsValue;
  onChange: (next: RankTrackingFieldsValue) => void;
  countries: readonly RankLocationOption[];
  localLocations: RankLocationOptions;
  languages: readonly RankLanguageOption[];
  onLocalQueryChange: (query: string) => void;
  onSearchLocalLocations: () => void;
  onLoadMoreLocalLocations: () => void;
  errors: RankTrackingFieldErrors;
  disabled: boolean;
  prefix: string;
};

const DEPTHS: readonly RankDepth[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const PAGE_CAPS: readonly RankPageCap[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SELECT_STYLE: React.CSSProperties = { width: '100%', minWidth: 0 };

export function RankTrackingFields(props: RankTrackingFieldsProps): React.JSX.Element {
  const {
    value,
    onChange,
    countries,
    localLocations,
    languages,
    onLocalQueryChange,
    onSearchLocalLocations,
    onLoadMoreLocalLocations,
    errors,
    disabled,
    prefix,
  } = props;

  const isLocal = value.targeting === 'local';
  const hasCountry = value.countryLocationCode !== '';
  const localLocked = !hasCountry || localLocations.loading;
  const localFieldError = hasCountry ? errors.localLocationCode : undefined;

  const id = (field: string): string => `${prefix}${field}`;
  const hintId = (field: string): string => `${prefix}${field}-hint`;
  const errorId = (field: string): string => `${prefix}${field}-error`;
  const describedBy = (...ids: Array<string | false | undefined>): string | undefined => {
    const joined = ids.filter(Boolean).join(' ');
    return joined === '' ? undefined : joined;
  };

  let localStatus: React.ReactNode = null;
  if (localLocations.loading) {
    localStatus = 'Loading locations…';
  } else if (localLocations.error) {
    localStatus = (
      <span role="alert" className="alert">
        {localLocations.error}
      </span>
    );
  } else if (localLocations.options.length === 0) {
    localStatus =
      localLocations.query.trim() === ''
        ? 'Search for a city or region.'
        : 'No locations match this search. Try another name.';
  }

  const onLocalQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!disabled && hasCountry && !localLocations.loading && !event.nativeEvent.isComposing) {
      onSearchLocalLocations();
    }
  };

  return (
    <fieldset disabled={disabled} className="stack" style={{ minWidth: 0 }}>
      <legend>Rank tracker targeting</legend>
      <div className="saved-keyword-filter-grid">
        <div className="field">
          <label htmlFor={id('domain')}>Target domain</label>
          <input
            id={id('domain')}
            type="text"
            value={value.domain}
            onChange={(event) => onChange({ ...value, domain: event.currentTarget.value })}
            maxLength={253}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="example.com"
            aria-invalid={errors.domain ? true : undefined}
            aria-describedby={describedBy(hintId('domain'), errors.domain && errorId('domain'))}
          />
          <p className="hint" id={hintId('domain')}>
            Tracks organic results for this domain and its subdomains.
          </p>
          {errors.domain ? (
            <p className="alert" id={errorId('domain')}>
              {errors.domain}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={id('countryLocationCode')}>Country or territory</label>
          <select
            id={id('countryLocationCode')}
            style={SELECT_STYLE}
            value={value.countryLocationCode}
            onChange={(event) =>
              onChange({
                ...value,
                countryLocationCode: event.currentTarget.value,
                localLocationCode: '',
              })
            }
            aria-invalid={errors.countryLocationCode ? true : undefined}
            aria-describedby={describedBy(
              errors.countryLocationCode && errorId('countryLocationCode'),
            )}
          >
            <option value="">Choose a country or territory</option>
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.label}
              </option>
            ))}
          </select>
          {errors.countryLocationCode ? (
            <p className="alert" id={errorId('countryLocationCode')}>
              {errors.countryLocationCode}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={id('targeting')}>Search targeting</label>
          <select
            id={id('targeting')}
            style={SELECT_STYLE}
            value={value.targeting}
            onChange={(event) => {
              const targeting = event.currentTarget.value as RankTrackingFieldsValue['targeting'];
              onChange({ ...value, targeting, localLocationCode: '' });
            }}
            aria-invalid={errors.targeting ? true : undefined}
            aria-describedby={describedBy(hintId('targeting'), errors.targeting && errorId('targeting'))}
          >
            <option value="national">Whole country or territory</option>
            <option value="local">City or region</option>
          </select>
          <p className="hint" id={hintId('targeting')}>
            {isLocal
              ? 'Choose a provider-supported city or region in that country or territory.'
              : 'Search from the selected country or territory.'}
          </p>
          {errors.targeting ? (
            <p className="alert" id={errorId('targeting')}>
              {errors.targeting}
            </p>
          ) : null}
        </div>

        {isLocal ? (
          <>
            <div className="field">
              <label htmlFor={id('localLocationQuery')}>Find a city or region</label>
              <div className="row">
                <input
                  id={id('localLocationQuery')}
                  type="text"
                  style={{ minWidth: 0 }}
                  value={localLocations.query}
                  onChange={(event) => onLocalQueryChange(event.currentTarget.value)}
                  onKeyDown={onLocalQueryKeyDown}
                  maxLength={100}
                  disabled={!hasCountry}
                  aria-describedby={hintId('localLocationCode')}
                />
                <button
                  type="button"
                  className="btn ghost"
                  disabled={disabled || localLocked}
                  onClick={onSearchLocalLocations}
                >
                  Search locations
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor={id('localLocationCode')}>City or region</label>
              <select
                id={id('localLocationCode')}
                style={SELECT_STYLE}
                value={value.localLocationCode}
                onChange={(event) =>
                  onChange({ ...value, localLocationCode: event.currentTarget.value })
                }
                disabled={localLocked}
                aria-invalid={localFieldError ? true : undefined}
                aria-describedby={describedBy(
                  hintId('localLocationCode'),
                  localFieldError && errorId('localLocationCode'),
                )}
              >
                <option value="">Choose a city or region</option>
                {localLocations.options.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              {localFieldError ? (
                <p className="alert" id={errorId('localLocationCode')}>
                  {localFieldError}
                </p>
              ) : null}
              {hasCountry ? (
                <div role="status" aria-live="polite" className="hint" id={hintId('localLocationCode')}>
                  {localStatus}
                </div>
              ) : (
                <p className="hint" id={hintId('localLocationCode')}>Choose a country or territory first.</p>
              )}
              {localLocations.hasMore ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={disabled || localLocked}
                  onClick={onLoadMoreLocalLocations}
                >
                  Load more locations
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="field">
          <label htmlFor={id('languageCode')}>Language</label>
          <select
            id={id('languageCode')}
            style={SELECT_STYLE}
            value={value.languageCode}
            onChange={(event) => onChange({ ...value, languageCode: event.currentTarget.value })}
            aria-invalid={errors.languageCode ? true : undefined}
            aria-describedby={describedBy(
              hintId('languageCode'),
              errors.languageCode && errorId('languageCode'),
            )}
          >
            <option value="">Choose a language</option>
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
          <p className="hint" id={hintId('languageCode')}>
            Choose the language used for this search.
          </p>
          {errors.languageCode ? (
            <p className="alert" id={errorId('languageCode')}>
              {errors.languageCode}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={id('devices')}>Devices</label>
          <select
            id={id('devices')}
            style={SELECT_STYLE}
            value={value.devices}
            onChange={(event) =>
              onChange({
                ...value,
                devices: event.currentTarget.value as RankTrackingFieldsValue['devices'],
              })
            }
            aria-invalid={errors.devices ? true : undefined}
            aria-describedby={describedBy(hintId('devices'), errors.devices && errorId('devices'))}
          >
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
            <option value="both">Desktop and mobile</option>
          </select>
          <p className="hint" id={hintId('devices')}>
            Desktop and mobile are separate checks.
          </p>
          {errors.devices ? (
            <p className="alert" id={errorId('devices')}>
              {errors.devices}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={id('depth')}>Requested results</label>
          <select
            id={id('depth')}
            style={SELECT_STYLE}
            value={String(value.depth)}
            onChange={(event) =>
              onChange({ ...value, depth: Number(event.currentTarget.value) as RankDepth })
            }
            aria-invalid={errors.depth ? true : undefined}
            aria-describedby={describedBy(hintId('depth'), errors.depth && errorId('depth'))}
          >
            {DEPTHS.map((depth) => (
              <option key={depth} value={depth}>
                {`${depth} results`}
              </option>
            ))}
          </select>
          <p className="hint" id={hintId('depth')}>
            Ask for up to this many search results; the page limit may stop retrieval earlier.
          </p>
          {errors.depth ? (
            <p className="alert" id={errorId('depth')}>
              {errors.depth}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={id('maxCrawlPages')}>Maximum billable pages</label>
          <select
            id={id('maxCrawlPages')}
            style={SELECT_STYLE}
            value={String(value.maxCrawlPages)}
            onChange={(event) =>
              onChange({ ...value, maxCrawlPages: Number(event.currentTarget.value) as RankPageCap })
            }
            aria-invalid={errors.maxCrawlPages ? true : undefined}
            aria-describedby={describedBy(
              hintId('maxCrawlPages'),
              errors.maxCrawlPages && errorId('maxCrawlPages'),
            )}
          >
            {PAGE_CAPS.map((pages) => (
              <option key={pages} value={pages}>
                {pages === 1 ? '1 page' : `${pages} pages`}
              </option>
            ))}
          </select>
          <p className="hint" id={hintId('maxCrawlPages')}>
            Limits how many search-result pages the provider may fetch per keyword and device.
          </p>
          {errors.maxCrawlPages ? (
            <p className="alert" id={errorId('maxCrawlPages')}>
              {errors.maxCrawlPages}
            </p>
          ) : null}
        </div>

        <p className="hint" id={id('closing-hint')}>
          Saving these settings does not start a paid check.
        </p>
      </div>
    </fieldset>
  );
}
