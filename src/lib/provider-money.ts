import { createDisplayFormatter } from '@ten98/ui'

const display = createDisplayFormatter()
const decimal = /^-?\d+(?:\.\d+)?$/

/** Provider spending arrives as exact decimal text; anything else is shown as unavailable rather than coerced through a float. */
export function providerUsd(value: unknown): string {
  return typeof value === 'string' && decimal.test(value) ? display.currency(value, 'USD') : display.missing
}
