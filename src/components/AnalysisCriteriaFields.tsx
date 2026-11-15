import type * as React from 'react';
import { Button, Combobox, Disclosure, Field, Fieldset, Inline, Input, Option, Select, Stack, Text } from '@ten98/ui';

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
  /** Pages and events already seen, offered so people pick instead of recalling exact names. */
  suggestions?: { path: string[]; event: string[] };
}): React.JSX.Element {
  const { value, onChange, disabled, idPrefix, pathLabel, suggestions } = props;
  const actionId = `${idPrefix}-action`;
  const matchId = `${idPrefix}-match`;
  return (
    <Fieldset legend="Match criteria" disabled={disabled}>
      <Field label="Action" htmlFor={actionId}>
        <Select
          id={actionId}
          value={value.type}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, type: event.target.value as MatchDraft['type'] })
          }
        >
          <Option value="path">{pathLabel}</Option>
          <Option value="event">Custom event</Option>
        </Select>
      </Field>
      <Field label="Match" htmlFor={matchId}>
        <Select
          id={matchId}
          value={value.match}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, match: event.target.value as MatchDraft['match'] })
          }
        >
          <Option value="exact">Exactly matches</Option>
          <Option value="prefix">Starts with</Option>
          <Option value="suffix">Ends with</Option>
          <Option value="contains">Contains</Option>
        </Select>
      </Field>
      <Combobox
        label={value.type === 'path' ? 'Page path' : 'Event name'}
        options={suggestions?.[value.type] ?? []}
        value={value.value}
        onValueChange={(next) => onChange({ ...value, value: next.slice(0, value.type === 'path' ? 2048 : 64) })}
        allowCustom
        required
        disabled={disabled}
        description={suggestions ? 'Pick one seen in the last 30 days, or type your own. Text is matched literally.' : 'Text is matched literally; wildcards are not expanded.'}
        emptyMessage="Nothing like this seen yet. You can still use what you typed."
      />
    </Fieldset>
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
    <Disclosure summary={`Property filters (${items.length})`}>
      <Stack gap={3}>
        <Text as="p" tone="muted" size="sm">All filters must match. A missing property only matches Is missing.</Text>
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
            <Fieldset key={index} legend={`Property filter ${row}`} disabled={disabled}>
              <Field label="Property key" htmlFor={keyId}>
                <Input
                  id={keyId}
                  type="text"
                  value={item.key}
                  minLength={1}
                  maxLength={320}
                  disabled={disabled}
                  onChange={(event) => update(index, { key: event.target.value })}
                />
              </Field>
              <Field label="Operator" htmlFor={operatorId}>
                <Select
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
                  <Option value="missing">Is missing</Option>
                  <Option value="eq">Equals</Option>
                  <Option value="neq">Does not equal</Option>
                  <Option value="contains">Contains</Option>
                  <Option value="not_contains">Does not contain</Option>
                </Select>
              </Field>
              {!isMissing && (
                <Field label="Type" htmlFor={typeId}>
                  <Select
                    id={typeId}
                    value={item.type}
                    disabled={disabled || isContains}
                    onChange={(event) => {
                      const type = event.target.value as PropertyDraft['type'];
                      update(index, type === 'null' ? { type, valueText: 'null' } : { type });
                    }}
                  >
                    <Option value="string">String</Option>
                    <Option value="number">Number</Option>
                    <Option value="boolean">Boolean</Option>
                    <Option value="null">Null</Option>
                    <Option value="date">Date</Option>
                    <Option value="array">Array</Option>
                  </Select>
                </Field>
              )}
              {!isMissing && !isNull && (
                <>
                  <Field label="JSON value" htmlFor={valueId}>
                    <Input
                      id={valueId}
                      type="text"
                      value={item.valueText}
                      disabled={disabled}
                      aria-describedby={valueHintId}
                      onChange={(event) => update(index, { valueText: event.target.value })}
                    />
                  </Field>
                  <Text as="p" tone="muted" size="sm" id={valueHintId}>
                    Enter a JSON value; strings need quotes.
                  </Text>
                </>
              )}
              {!isMissing && isNull && <Text as="p" tone="muted" size="sm">Null is a stored value, distinct from a missing property.</Text>}
              <Inline>
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Remove property filter ${row}`}
                  disabled={disabled}
                  onClick={() => onChange(items.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </Inline>
            </Fieldset>
          );
        })}
        <Inline>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || items.length >= MAX_PROPERTY_FILTERS}
            onClick={() =>
              onChange([...items, { key: '', operator: 'eq', type: 'string', valueText: '""' }])
            }
          >
            Add property filter
          </Button>
        </Inline>
      </Stack>
    </Disclosure>
  );
}
