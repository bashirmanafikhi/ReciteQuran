// src/index.ts
// Public entry point: everything a React Native app (or a Node script) needs to
// open a tracking session and read its events. The engine internals
// (matcher / sequencer / tokenProcessor / tajweed internals) are deliberately
// not re-exported — they are reachable through the session only.

export { ReciteQuran } from './session';
export type {
  AsrTransport,
  CreateSessionOptions,
  ReciteQuranDebugEvent,
  SetTargetSurahOptions,
} from './session';

// React Native binding. Importing this is safe in Node: `react-native` is only
// required once a lifecycle method runs (src/nativeModule.ts).
export { createNativeTransport, NativeTransportError } from './nativeTransport';
export type {
  CreateNativeTransportOptions,
  NativeAsrTransport,
  NativeTransportErrorCode,
  SegmentChangeEvent,
} from './nativeTransport';

export {
  copyWithConfig,
  easyConfig,
  normalConfig,
  strictConfig,
  TrackerConfigPresets,
} from './config';
export type { TrackerConfig } from './config';

export {
  QURAN_PHONEME_ASSET_PATHS,
  QuranMetadataService,
  QuranRepository,
  QuranVerse,
  calculateBoundaries,
} from './data/quranData';
export type { QuranDataLoader, QuranVerseInit } from './data/quranData';

export { ErrorCategory, SpeechErrorType, TajweedDurationStatus } from './types';
export type {
  ContinuousQuranWord,
  ProcessedAudioStream,
  ReciterErrorMap,
  ReciterErrorRuleMap,
  TranscriptionResult,
  WordMatchedEvent,
  WordTajweedRule,
} from './types';