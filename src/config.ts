// src/config.ts
// Port of lib/tracking/tracker_config.dart — literal values frozen from the Dart source.

/** Unified immutable configuration for recitation tracking, thresholds, and Tajweed. */
export interface TrackerConfig {
  /** 0.30: Base acceptance error threshold */
  defaultMaxPathCost: number;
  /** 0.25: Strict threshold for words <= 3 chars */
  shortWordPathCost: number;
  /** 0.28: Strict threshold for words <= 7 chars */
  mediumWordPathCost: number;
  /** 2: Lookahead word skips for omissions */
  maxSkipWords: number;
  /** 0.25: Cost for acoustic confusion pairs (e.g. ص vs س) */
  acousticConfusionCost: number;
  /** 0.75: Cost for extra ASR phonemes */
  standardInsertionCost: number;
  /** 1.00: Cost for missing reference phonemes */
  standardDeletionCost: number;
  /** 0.200s: Duration of 1 Harakah vowel beat */
  harakatDurationSeconds: number;
  /** 2.5s: Maximum ceiling for a single token */
  maxTokenDurationAllowed: number;
  /** 0.320s: CTC blank lookahead delay */
  lookaheadDelay: number;
  /** true: Hide acceptable ASR slips from UI */
  hideExpectedAsrNoise: boolean;
  /** Fast word committing before reciter finishes trailing Madd/Waqf vowels (Tajweed OFF only). */
  enableEarlyMatching: boolean;
}

/** TrackerConfig() constructor defaults = normal preset (tracker_config.dart:39-52). */
const NORMAL_CONFIG: TrackerConfig = {
  defaultMaxPathCost: 0.30,
  shortWordPathCost: 0.25,
  mediumWordPathCost: 0.28,
  maxSkipWords: 2,
  acousticConfusionCost: 0.25,
  standardInsertionCost: 0.75,
  standardDeletionCost: 1.0,
  harakatDurationSeconds: 0.200,
  maxTokenDurationAllowed: 2.5,
  lookaheadDelay: 0.320,
  hideExpectedAsrNoise: true,
  enableEarlyMatching: true,
};

/** Standard baseline configuration (identical to original engine calibration). tracker_config.dart:55 */
export function normalConfig(): TrackerConfig {
  return { ...NORMAL_CONFIG };
}

/** Easy mode for beginners, children, or noisy microphones. tracker_config.dart:58-71 */
export function easyConfig(): TrackerConfig {
  return {
    defaultMaxPathCost: 0.40,
    shortWordPathCost: 0.30,
    mediumWordPathCost: 0.35,
    maxSkipWords: 3,
    acousticConfusionCost: 0.15,
    standardInsertionCost: 0.50,
    standardDeletionCost: 0.80,
    harakatDurationSeconds: 0.150,
    maxTokenDurationAllowed: 3.0,
    lookaheadDelay: 0.320,
    hideExpectedAsrNoise: true,
    enableEarlyMatching: true,
  };
}

/** Strict mode for advanced reciters, exams, or Tajweed certification. tracker_config.dart:74-87 */
export function strictConfig(): TrackerConfig {
  return {
    defaultMaxPathCost: 0.25,
    shortWordPathCost: 0.20,
    mediumWordPathCost: 0.23,
    maxSkipWords: 1,
    acousticConfusionCost: 0.35,
    standardInsertionCost: 1.0,
    standardDeletionCost: 1.0,
    harakatDurationSeconds: 0.250,
    maxTokenDurationAllowed: 2.0,
    lookaheadDelay: 0.320,
    hideExpectedAsrNoise: false,
    enableEarlyMatching: false,
  };
}

/**
 * Creates a copy of this config with replaced fields.
 * Mirrors Dart copyWith (tracker_config.dart:90-118): null/undefined keeps the original value.
 */
export function copyWithConfig(
  cfg: TrackerConfig,
  partial: Partial<TrackerConfig>,
): TrackerConfig {
  return {
    defaultMaxPathCost: partial.defaultMaxPathCost ?? cfg.defaultMaxPathCost,
    shortWordPathCost: partial.shortWordPathCost ?? cfg.shortWordPathCost,
    mediumWordPathCost: partial.mediumWordPathCost ?? cfg.mediumWordPathCost,
    maxSkipWords: partial.maxSkipWords ?? cfg.maxSkipWords,
    acousticConfusionCost: partial.acousticConfusionCost ?? cfg.acousticConfusionCost,
    standardInsertionCost: partial.standardInsertionCost ?? cfg.standardInsertionCost,
    standardDeletionCost: partial.standardDeletionCost ?? cfg.standardDeletionCost,
    harakatDurationSeconds: partial.harakatDurationSeconds ?? cfg.harakatDurationSeconds,
    maxTokenDurationAllowed: partial.maxTokenDurationAllowed ?? cfg.maxTokenDurationAllowed,
    lookaheadDelay: partial.lookaheadDelay ?? cfg.lookaheadDelay,
    hideExpectedAsrNoise: partial.hideExpectedAsrNoise ?? cfg.hideExpectedAsrNoise,
    enableEarlyMatching: partial.enableEarlyMatching ?? cfg.enableEarlyMatching,
  };
}

export const TrackerConfigPresets = {
  normal: normalConfig,
  easy: easyConfig,
  strict: strictConfig,
};
