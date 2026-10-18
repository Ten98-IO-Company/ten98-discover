import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPromptQuestions, promptDiscoveryIntents} from '../src/lib/prompt-discovery.ts';

test('local prompt discovery covers distinct intents without invented demand measurements', () => {
  const firstQuestions = new Set<string>();
  for (const intent of promptDiscoveryIntents) {
    const result = buildPromptQuestions({topic: 'organic search', audience: 'small businesses', intent});
    assert.equal(result.length, 4);
    assert.equal(new Set(result).size, result.length);
    assert.ok(result.every(value => value.includes('organic search') && value.includes('small businesses') && value.endsWith('?') && value.length <= 2000));
    firstQuestions.add(result[0]);
  }
  assert.equal(firstQuestions.size, 4);
  assert.equal(buildPromptQuestions({topic: 'search', intent: 'learn'})[0], 'What is search?');
});

test('brand and competitor context is optional, literal and bounded', () => {
  const brand = '<img src=x onerror=alert(1)>', competitor = '研究 👩🏽‍💻';
  const result = buildPromptQuestions({topic: '検索エンジン', intent: 'compare', brand, competitor});
  assert.equal(result.length, 6);
  assert.ok(result.some(value => value.includes(brand) && value.includes(competitor)));
  assert.equal(buildPromptQuestions({topic: 'search', intent: 'choose', brand: ' Acme ', competitor: 'acme'}).length, 5);
  assert.equal(buildPromptQuestions({topic: 'search', intent: 'use', brand: '', competitor: 'Other'}).length, 5);
  assert.equal(buildPromptQuestions({topic: 'search', intent: 'use', audience: ' ', brand: ' ', competitor: ' '}).length, 4);
});

test('manual topics remain valid prompt-library inputs and cannot inject extra bulk lines', () => {
  const questions = buildPromptQuestions({topic: '  customer\n support\tsoftware  ', audience: ' remote\n teams ', intent: 'learn', brand: 'Some\nBrand'});
  assert.equal(questions[0], 'What is customer support software for remote teams?');
  assert.ok(questions.every(value => !/[\r\n\t]/u.test(value)));
  const maximum = buildPromptQuestions({topic: 'x'.repeat(100), audience: 'a'.repeat(100), intent: 'compare', brand: 'b'.repeat(120), competitor: 'c'.repeat(253)});
  assert.ok(maximum.every(value => value.length <= 2000));
  for (const topic of ['', ' ', 'x'.repeat(101), '\0', '\ud800', '\udfff']) assert.throws(() => buildPromptQuestions({topic, intent: 'learn'}));
  for (const input of [
    {topic: 'search', intent: 'unknown'},
    {topic: 'search', intent: 'learn', audience: 'a'.repeat(101)},
    {topic: 'search', intent: 'learn', brand: 'b'.repeat(121)},
    {topic: 'search', intent: 'learn', competitor: 'c'.repeat(254)},
    {topic: 'search', intent: 'learn', audience: '\ud800'},
    {topic: 'search', intent: 'learn', brand: '\0'},
    {topic: 42, intent: 'learn'},
    null,
  ]) assert.throws(() => buildPromptQuestions(input as Parameters<typeof buildPromptQuestions>[0]));
});
