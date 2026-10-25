import test from 'node:test'
import assert from 'node:assert/strict'
import { providerUsd } from '../src/lib/provider-money.ts'

test('provider spending shows the server decimal text exactly', () => {
  assert.equal(providerUsd('0.000123456'), '$0.000123456')
  assert.equal(providerUsd('1234.5'), '$1,234.50')
  assert.equal(providerUsd('0'), '$0.00')
})

test('provider spending never shows a float artefact or coerced value', () => {
  assert.equal(providerUsd(0.1 + 0.2), 'Unavailable')
  assert.equal(providerUsd(0.000123456), 'Unavailable')
  assert.equal(providerUsd('1e-7'), 'Unavailable')
  assert.equal(providerUsd(' 1.5'), 'Unavailable')
  assert.equal(providerUsd(null), 'Unavailable')
  assert.equal(providerUsd(undefined), 'Unavailable')
  assert.doesNotMatch(providerUsd('0.000123456'), /e-|0000000\d/)
})
