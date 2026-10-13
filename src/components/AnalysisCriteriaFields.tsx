import type * as React from 'react';

export type MatchDraft = {
  type: 'path' | 'event';
  match: 'exact' | 'prefix' | 'suffix' | 'contains';
  value: string;
};

export type PropertyDraft = {
  key: string;
  operator: 'missing' | 'eq' | 'neq' | 'contains' | 'not_contains';
  type: 'string' | 'number' | 'boolean' | 'null' | 'date' | 'array';
  valueText: string;
};

const MAX_PROPERTY_FILTERS = 10;

export function MatchFields(props: {
  value: MatchDraft;
  onChange: (value: MatchDraft) => void;
  disabled: boolean;
  idPrefix: string;
  pathLabel: string;
}): React.JSX.Element {
  const { value, onChange, disabled, idPrefix, pathLabel } = props;
  const actionId = `${idPrefix}-action`;
  const matchId = `${idPrefix}-match`;
  const valueId = `${idPrefix}-value`;
  const valueHintId = `${idPrefix}-value-hint`;
  return (
    <fieldset className="field conversion-match" disabled={disabled}>
      <legend>Match criteria</legend>
      <div className="row">
        <label htmlFor={actionId}>Action</label>
        <select
          id={actionId}
          value={value.type}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, type: event.target.value as MatchDraft['type'] })
          }
        >
          <option value="path">{pathLabel}</option>
          <option value="event">Custom event</option>
        </select>
      </div>
      <div className="row">
        <label htmlFor={matchId}>Match</label>
        <select
          id={matchId}
          value={value.match}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, match: event.target.value as MatchDraft['match'] })
          }
        >
          <option value="exact">Exactly matches</option>
          <option value="prefix">Starts with</option>
          <option value="suffix">Ends with</option>
          <option value="contains">Contains</option>
        </select>
      </div>
      <div className="row">
        <label htmlFor={valueId}>Value</label>
        <input
          id={valueId}
          type="text"
          value={value.value}
          required
          maxLength={value.type === 'path' ? 2048 : 64}
          disabled={disabled}
          aria-describedby={valueHintId}
          onChange={(event) => onChange({ ...value, value: event.target.value })}
        />
      </div>
      <p className="hint" id={valueHintId}>
        Match text is literal. Wildcards are not expanded.
      </p>
    </fieldset>
  );
}

export function PropertyFields(props: {
  items: PropertyDraft[];
  onChange: (items: PropertyDraft[]) => void;
  disabled: boolean;
  idPrefix: string;
}): React.JSX.Element {
  const { items, onChange, disabled, idPrefix } = props;
  const update = (index: number, patch: Partial<PropertyDraft>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  return (
    <details className="field">
      <summary>Property filters ({items.length})</summary>
      <p className="hint">All filters must match. A missing property only matches Is missing.</p>
      {items.map((item, index) => {
        const row = index + 1;
        const keyId = `${idPrefix}-prop-${row}-key`;
        const operatorId = `${idPrefix}-prop-${row}-operator`;
        const typeId = `${idPrefix}-prop-${row}-type`;
        const valueId = `${idPrefix}-prop-${row}-value`;
        const valueHintId = `${idPrefix}-prop-${row}-value-hint`;
        const isMissing = item.operator === 'missing';
        const isContains = item.operator === 'contains' || item.operator === 'not_contains';
        const isNull = item.type === 'null';
        return (
          <fieldset key={index} className="field conversion-property" disabled={disabled}>
            <legend>Property filter {row}</legend>
            <div className="row">
              <label htmlFor={keyId}>Property key</label>
              <input
                id={keyId}
                type="text"
                value={item.key}
                minLength={1}
                maxLength={320}
                disabled={disabled}
                onChange={(event) => update(index, { key: event.target.value })}
              />
            </div>
            <div className="row">
              <label htmlFor={operatorId}>Operator</label>
              <select
                id={operatorId}
                value={item.operator}
                disabled={disabled}
                onChange={(event) => {
                  const operator = event.target.value as PropertyDraft['operator'];
                  update(
                    index,
                    operator === 'contains' || operator === 'not_contains'
                      ? { operator, type: 'string' }
                      : { operator },
                  );
                }}
              >
                <option value="missing">Is missing</option>
                <option value="eq">Equals</option>
                <option value="neq">Does not equal</option>
                <option value="contains">Contains</option>
                <option value="not_contains">Does not contain</option>
              </select>
            </div>
            {!isMissing && (
              <div className="row">
                <label htmlFor={typeId}>Type</label>
                <select
                  id={typeId}
                  value={item.type}
                  disabled={disabled || isContains}
                  onChange={(event) => {
                    const type = event.target.value as PropertyDraft['type'];
                    update(index, type === 'null' ? { type, valueText: 'null' } : { type });
                  }}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="null">Null</option>
                  <option value="date">Date</option>
                  <option value="array">Array</option>
                </select>
              </div>
            )}
            {!isMissing && !isNull && (
              <>
                <div className="row">
                  <label htmlFor={valueId}>JSON value</label>
                  <input
                    id={valueId}
                    type="text"
                    value={item.valueText}
                    disabled={disabled}
                    aria-describedby={valueHintId}
                    onChange={(event) => update(index, { valueText: event.target.value })}
                  />
                </div>
                <p className="hint" id={valueHintId}>
                  Enter a JSON value; strings need quotes.
                </p>
              </>
            )}
            {!isMissing && isNull && <p className="hint">Null is a stored value, distinct from a missing property.</p>}
            <button
              type="button"
              className="btn"
              aria-label={`Remove property filter ${row}`}
              disabled={disabled}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="btn"
        disabled={disabled || items.length >= MAX_PROPERTY_FILTERS}
        onClick={() =>
          onChange([...items, { key: '', operator: 'eq', type: 'string', valueText: '""' }])
        }
      >
        Add property filter
      </button>
    </details>
  );
}
