import type * as React from 'react';
import { Button, Field, Fieldset, Inline, Input, Select, Text } from '@ten98/ui';

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
// @ten98/ui text controls are 36px; keep the 44px coarse-pointer target the rank suite asserts.
const TOUCH_TARGET: React.CSSProperties = { minHeight: 'var(--t98-control-touch)' };

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

  // Field supplies `<id>-error` and aria-invalid from its `error` prop, so only the hint is linked here.
  const id = (field: string): string => `${prefix}${field}`;
  const hintId = (field: string): string => `${prefix}${field}-hint`;

  let localStatus: React.ReactNode = null;
  if (localLocations.loading) {
    localStatus = 'Loading locations…';
  } else if (localLocations.error) {
    localStatus = (
      <Text as="span" tone="danger" role="alert">
        {localLocations.error}
      </Text>
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
    <Fieldset legend="Rank tracker targeting" disabled={disabled} layout="grid">
      <Field label="Target domain" htmlFor={id('domain')} error={errors.domain}>
        <Input
          style={TOUCH_TARGET}
          id={id('domain')}
          type="text"
          value={value.domain}
          onChange={(event) => onChange({ ...value, domain: event.currentTarget.value })}
          maxLength={253}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="example.com"
          aria-describedby={hintId('domain')}
        />
        <Text as="p" size="sm" tone="muted" id={hintId('domain')}>
          Tracks organic results for this domain and its subdomains.
        </Text>
      </Field>

      <Field label="Country or territory" htmlFor={id('countryLocationCode')} error={errors.countryLocationCode}>
        <Select
          style={TOUCH_TARGET}
          id={id('countryLocationCode')}
          value={value.countryLocationCode}
          options={[
            { value: '', label: 'Choose a country or territory' },
            ...countries.map((country) => ({ value: country.code, label: country.label })),
          ]}
          onChange={(event) =>
            onChange({
              ...value,
              countryLocationCode: event.currentTarget.value,
              localLocationCode: '',
            })
          }
        />
      </Field>

      <Field label="Search targeting" htmlFor={id('targeting')} error={errors.targeting}>
        <Select
          style={TOUCH_TARGET}
          id={id('targeting')}
          value={value.targeting}
          options={[
            { value: 'national', label: 'Whole country or territory' },
            { value: 'local', label: 'City or region' },
          ]}
          onChange={(event) => {
            const targeting = event.currentTarget.value as RankTrackingFieldsValue['targeting'];
            onChange({ ...value, targeting, localLocationCode: '' });
          }}
          aria-describedby={hintId('targeting')}
        />
        <Text as="p" size="sm" tone="muted" id={hintId('targeting')}>
          {isLocal
            ? 'Choose a provider-supported city or region in that country or territory.'
            : 'Search from the selected country or territory.'}
        </Text>
      </Field>

      {isLocal ? (
        <>
          <Inline align="end">
            <Field label="Find a city or region" htmlFor={id('localLocationQuery')}>
              <Input
                style={TOUCH_TARGET}
                id={id('localLocationQuery')}
                type="text"
                value={localLocations.query}
                onChange={(event) => onLocalQueryChange(event.currentTarget.value)}
                onKeyDown={onLocalQueryKeyDown}
                maxLength={100}
                disabled={!hasCountry}
                aria-describedby={hintId('localLocationCode')}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || localLocked}
              onClick={onSearchLocalLocations}
            >
              Search locations
            </Button>
          </Inline>

          <Field label="City or region" htmlFor={id('localLocationCode')} error={localFieldError}>
            <Select
              style={TOUCH_TARGET}
              id={id('localLocationCode')}
              value={value.localLocationCode}
              options={[
                { value: '', label: 'Choose a city or region' },
                ...localLocations.options.map((option) => ({ value: option.code, label: option.label })),
              ]}
              onChange={(event) => onChange({ ...value, localLocationCode: event.currentTarget.value })}
              disabled={localLocked}
              aria-describedby={hintId('localLocationCode')}
            />
            {hasCountry ? (
              <Text as="div" size="sm" tone="muted" role="status" aria-live="polite" id={hintId('localLocationCode')}>
                {localStatus}
              </Text>
            ) : (
              <Text as="p" size="sm" tone="muted" id={hintId('localLocationCode')}>
                Choose a country or territory first.
              </Text>
            )}
            {localLocations.hasMore ? (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled || localLocked}
                onClick={onLoadMoreLocalLocations}
              >
                Load more locations
              </Button>
            ) : null}
          </Field>
        </>
      ) : null}

      <Field label="Language" htmlFor={id('languageCode')} error={errors.languageCode}>
        <Select
          style={TOUCH_TARGET}
          id={id('languageCode')}
          value={value.languageCode}
          options={[
            { value: '', label: 'Choose a language' },
            ...languages.map((language) => ({ value: language.code, label: language.label })),
          ]}
          onChange={(event) => onChange({ ...value, languageCode: event.currentTarget.value })}
          aria-describedby={hintId('languageCode')}
        />
        <Text as="p" size="sm" tone="muted" id={hintId('languageCode')}>
          Choose the language used for this search.
        </Text>
      </Field>

      <Field label="Devices" htmlFor={id('devices')} error={errors.devices}>
        <Select
          style={TOUCH_TARGET}
          id={id('devices')}
          value={value.devices}
          options={[
            { value: 'desktop', label: 'Desktop' },
            { value: 'mobile', label: 'Mobile' },
            { value: 'both', label: 'Desktop and mobile' },
          ]}
          onChange={(event) =>
            onChange({
              ...value,
              devices: event.currentTarget.value as RankTrackingFieldsValue['devices'],
            })
          }
          aria-describedby={hintId('devices')}
        />
        <Text as="p" size="sm" tone="muted" id={hintId('devices')}>
          Desktop and mobile are separate checks.
        </Text>
      </Field>

      <Field label="Requested results" htmlFor={id('depth')} error={errors.depth}>
        <Select
          style={TOUCH_TARGET}
          id={id('depth')}
          value={String(value.depth)}
          options={DEPTHS.map((depth) => ({ value: String(depth), label: `${depth} results` }))}
          onChange={(event) => onChange({ ...value, depth: Number(event.currentTarget.value) as RankDepth })}
          aria-describedby={hintId('depth')}
        />
        <Text as="p" size="sm" tone="muted" id={hintId('depth')}>
          Ask for up to this many search results; the page limit may stop retrieval earlier.
        </Text>
      </Field>

      <Field label="Maximum pages" htmlFor={id('maxCrawlPages')} error={errors.maxCrawlPages}>
        <Select
          style={TOUCH_TARGET}
          id={id('maxCrawlPages')}
          value={String(value.maxCrawlPages)}
          options={PAGE_CAPS.map((pages) => ({ value: String(pages), label: pages === 1 ? '1 page' : `${pages} pages` }))}
          onChange={(event) =>
            onChange({ ...value, maxCrawlPages: Number(event.currentTarget.value) as RankPageCap })
          }
          aria-describedby={hintId('maxCrawlPages')}
        />
        <Text as="p" size="sm" tone="muted" id={hintId('maxCrawlPages')}>
          Limits how many search-result pages the provider may fetch per keyword and device.
        </Text>
      </Field>

      <Text as="p" size="sm" tone="muted" id={id('closing-hint')}>
        Save these settings, then run a rank check when ready.
      </Text>
    </Fieldset>
  );
}
