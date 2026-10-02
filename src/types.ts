// src/types.ts
// Shared event/data types ported field-for-field from the Flutter engine (lib/).
// Dart sources are the read-only source of truth; nothing under lib/ is modified.

/** lib/engine/sherpa_engine_io.dart:25-41 */
export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  startTime: number;
  tokens: string[];
  timestamps: number[];
  streamEpoch: number;
}

/** lib/tracking/word/highlighting_controller.dart:38-44 (isEmpty/isNotEmpty are derived) */
export interface ProcessedAudioStream {
  tokens: string[];
  durations: number[];
}

/**
 * lib/tracking/tajweed/error_explainer.dart:26-35.
 * Declaration order frozen: tajweed=0, normal=1, tashkeel=2.
 * Ordinals match Dart `ErrorCategory.index` used in ReciterError.toMap().
 */
export enum ErrorCategory {
  tajweed = 0,
  normal = 1,
  tashkeel = 2,
}

/**
 * lib/tracking/tajweed/error_explainer.dart:38-47.
 * Declaration order frozen: insert=0, delete=1, replace=2.
 * Ordinals match Dart `SpeechErrorType.index` used in ReciterError.toMap().
 */
export enum SpeechErrorType {
  insert = 0,
  delete = 1,
  replace = 2,
}

/**
 * lib/tracking/tajweed/tajweed_rules.dart:54-63.
 * Declaration order frozen: valid=0, defect=1, surplus=2.
 * Ordinals match Dart `TajweedDurationStatus.index` used in ReciterError.toMap().
 */
export enum TajweedDurationStatus {
  valid = 0,
  defect = 1,
  surplus = 2,
}

/** Serialized TajweedRule (ReciterError._ruleToMap, error_explainer.dart:109-117) */
export interface ReciterErrorRuleMap {
  type: string;
  nameAr: string;
  nameEn: string;
  goldenLen: number;
}

/**
 * Map form of ReciterError (error_explainer.dart:78-90).
 * errorType/speechErrorType/durationStatus are enum ordinals
 * (see ErrorCategory / SpeechErrorType / TajweedDurationStatus above);
 * durationStatus is null when absent.
 */
export interface ReciterErrorMap {
  errorType: number;
  speechErrorType: number;
  durationStatus: number | null;
  expectedPh: string;
  predictedPh: string;
  expectedRule: ReciterErrorRuleMap | null;
  predictedRule: ReciterErrorRuleMap | null;
  expectedDuration: number | null;
  actualDuration: number | null;
}

/**
 * lib/tracking/word/phoneme_alignment_isolate_protocol.dart:227-254
 * (field list at :195-268). Defaults: score=0.0, isRed=false, isNeutral=false;
 * tajweedErrors is null when absent.
 */
export interface WordMatchedEvent {
  wordId: number;
  score: number;
  cleanAsr: string;
  tajweedErrors: ReciterErrorMap[] | null;
  isRed: boolean;
  isNeutral: boolean;
}

/** lib/data/quran_data.dart:10-36 (goldenLen is Dart `num`) */
export interface WordTajweedRule {
  ruleId: number;
  nameAr: string;
  nameEn: string;
  goldenLen: number;
}

/** lib/data/quran_data.dart:258-276 (rules defaults to []) */
export interface ContinuousQuranWord {
  globalIndex: number;
  surah: number;
  ayah: number;
  wordInAyah: number;
  uthmani: string;
  phoneme: string;
  rules: WordTajweedRule[];
}

/**
 * lib/tracking/tajweed/error_explainer.dart:146-156.
 * opType values: 'match' | 'replace' | 'delete' | 'insert' (kept as string per Dart String field).
 */
export interface PhonemeGroupAlignment {
  opType: string;
  refIdx: number;
  predIdx: number;
}
