import {expect} from '@jest/globals'
import type {MatcherFunction} from 'expect'

const toBeOnSameDay: MatcherFunction<[expected: unknown]> = function (
  actual,
  expected
) {
  if (!(actual instanceof Date && expected instanceof Date)) {
    throw new TypeError('These must be of type Date!')
  }

  const {matcherHint, printReceived} = this.utils

  const pass =
    actual.getFullYear() === expected.getFullYear() &&
    actual.getMonth() === expected.getMonth() &&
    actual.getDate() === expected.getDate()

  return {
    pass,
    message: () =>
      pass
        ? matcherHint('.not.toBeOnSameDay', 'received', '') +
          '\n\n' +
          `Expected date to be not on the same day as ${printReceived(
            expected
          )} but received:\n` +
          `  ${printReceived(actual)}`
        : matcherHint('.toBeOnSameDay', 'received', '') +
          '\n\n' +
          `Expected date to be on the same day as ${printReceived(
            expected
          )} but received:\n` +
          `  ${printReceived(actual)}`
  }
}

expect.extend({
  toBeOnSameDay
})

/* eslint no-unused-vars: "off" */
declare module 'expect' {
  interface AsymmetricMatchers {
    toBeOnSameDay(expected: Date): void
  }
  interface Matchers<R> {
    toBeOnSameDay(expected: Date): R
  }
}
