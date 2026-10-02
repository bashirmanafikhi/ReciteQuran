import { normalConfig, easyConfig, strictConfig, copyWithConfig } from '../src/config';
test('normal preset defaults', () => {
  expect(normalConfig()).toEqual({
    defaultMaxPathCost: 0.30, shortWordPathCost: 0.25, mediumWordPathCost: 0.28,
    maxSkipWords: 2, acousticConfusionCost: 0.25, standardInsertionCost: 0.75,
    standardDeletionCost: 1.0, harakatDurationSeconds: 0.200,
    maxTokenDurationAllowed: 2.5, lookaheadDelay: 0.320,
    hideExpectedAsrNoise: true, enableEarlyMatching: true,
  });
});
test('easy preset', () => expect(easyConfig()).toMatchObject(
  { defaultMaxPathCost: 0.40, shortWordPathCost: 0.30, mediumWordPathCost: 0.35,
    maxSkipWords: 3, acousticConfusionCost: 0.15, standardInsertionCost: 0.50,
    standardDeletionCost: 0.80, harakatDurationSeconds: 0.150, maxTokenDurationAllowed: 3.0 }));
test('strict preset', () => expect(strictConfig()).toMatchObject(
  { defaultMaxPathCost: 0.25, shortWordPathCost: 0.20, mediumWordPathCost: 0.23,
    maxSkipWords: 1, acousticConfusionCost: 0.35, standardInsertionCost: 1.0,
    standardDeletionCost: 1.0, harakatDurationSeconds: 0.250, maxTokenDurationAllowed: 2.0,
    hideExpectedAsrNoise: false, enableEarlyMatching: false }));
test('copyWith keeps other fields', () =>
  expect(copyWithConfig(normalConfig(), { maxSkipWords: 5 }).defaultMaxPathCost).toBe(0.30));
