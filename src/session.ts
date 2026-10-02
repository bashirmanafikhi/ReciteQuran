// src/session.ts
// Line-by-line transliteration of the ReciteQuran session facade in
// lib/recite_quran.dart (229 lines, read-only source of truth).
//
// Dart streams (StreamController.broadcast) become subscriber sets that hand back
// an unsubscribe function, mirroring StreamSubscription.cancel(). The Dart
// PhonemeAlignmentIsolate worker (phoneme_alignment_isolate_io.dart:68-178) is
// replaced by the already-ported in-process DictationSequencer
// (src/engine/sequencer.ts): same commands, same events, minus the message-port
// hop. TrackerConfig, the shared types, AsrTokenProcessor, expandCharDurations,
// the QuranRepository and the tajweed layer are imported — never redeclared.
//
// Two deliberate, documented deviations from a mechanical transliteration:
//  1. Per-character duration expansion before syncStream. The Dart facade passes
//     token durations (recite_quran.dart:191-194), but the path the app actually
//     used expands each token into `duration / max(1, token.length)` per code unit
//     (highlighting_controller.dart:612-619). The ledger ruling (task-10 brief:38)
//     selects the latter; `AsrTokenProcessor.process()` still returns LIVE buffers,
//     which are only read here, never mutated.
//  2. The ASR engine is behind the injected `AsrTransport` seam instead of
//     `feedAudioChunk`, so the pipeline runs in Node/Jest without React Native.
//     The Kotlin/sherpa-backed transport lands in a later task.

import { normalConfig, TrackerConfig } from './config';
import {
  calculateBoundaries,
  QuranDataLoader,
  QuranMetadataService,
  QuranRepository,
} from './data/quranData';
import {
  DictationSequencer,
  SequencerEvent,
  SetSurahReferenceCmd,
  SyncStreamCmd,
} from './engine/sequencer';
import { AsrTokenProcessor, expandCharDurations } from './engine/tokenProcessor';
import {
  ContinuousQuranWord,
  ProcessedAudioStream,
  TranscriptionResult,
  WordMatchedEvent,
  WordTajweedRule,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// TS ↔ KOTLIN SEAM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The ASR side of the pipeline (recite_quran.dart:101 `await _engine.initialize()`,
 * :154-157 `feedAudioChunk`, :163 `_engine.resetBuffer()`, :220 `_engine.destroy()`).
 *
 * A native implementation owns the microphone and the sherpa-onnxruntime
 * Zipformer2-CTC model and pushes `TranscriptionResult`s into the callback given
 * to `start()`. Jest substitutes a fake, which is why this port has no sherpa or
 * microphone dependency.
 */
export interface AsrTransport {
  initialize(): Promise<void>;
  /** Starts mic capture + inference; every result arrives through `onResult`. */
  start(onResult: (r: TranscriptionResult) => void): void;
  stop(): Promise<void>;
  resetBuffer(): void;
  destroy(): void;
}

/**
 * Stand-in used when no transport is injected. It fails loudly at initialize()
 * instead of silently producing an untrackable session.
 */
class UnavailableAsrTransport implements AsrTransport {
  private static readonly MESSAGE =
    'ReciteQuran: no AsrTransport was injected. Pass `transport` to ' +
    'ReciteQuran.createSession() (on device: the native sherpa/Kotlin transport).';

  async initialize(): Promise<void> {
    throw new Error(UnavailableAsrTransport.MESSAGE);
  }

  start(_onResult: (r: TranscriptionResult) => void): void {
    throw new Error(UnavailableAsrTransport.MESSAGE);
  }

  async stop(): Promise<void> {
    throw new Error(UnavailableAsrTransport.MESSAGE);
  }

  resetBuffer(): void {
    throw new Error(UnavailableAsrTransport.MESSAGE);
  }

  destroy(): void {
    // Nothing was ever created; dispose() must stay safe.
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECITE QURAN SDK (MAIN PUBLIC FACADE) — recite_quran.dart:31-228
// ═══════════════════════════════════════════════════════════════════════════════

/** Secondary stream mirror of DebugLogEvent (phoneme_alignment_isolate_protocol.dart:256-268). */
export interface ReciteQuranDebugEvent {
  message: string;
  asrBuffer: string;
}

/** recite_quran.dart:118-121 `setTargetSurah({startGlobalWord, forceClear})`. */
export interface SetTargetSurahOptions {
  /**
   * Cursor inside the reference, relative to the (possibly sliced) ayah window.
   * Equals the absolute surah word index when no ayah window is given.
   */
  startGlobalWord?: number;
  /** First ayah of the window; the reference is built from this ayah onwards. */
  ayahFrom?: number;
  /** Last ayah of the window. Omitted ⇒ through the end of the surah. */
  ayahTo?: number;
}

export interface CreateSessionOptions extends SetTargetSurahOptions {
  /** Surah number to track (1-114). */
  surah: number;
  /** Defaults to `normalConfig()`. */
  config?: TrackerConfig;
  /** Defaults to true, exactly like the Dart constructor. */
  isTajweed?: boolean;
  /** Native ASR transport. Omitted ⇒ `initialize()` throws. */
  transport?: AsrTransport;
  /** Pre-built repository (RN: one holding the Metro-required asset). */
  repository?: QuranRepository;
  /** Loader used to build a repository when none is supplied. */
  loader?: QuranDataLoader;
  /**
   * Receives the sequencer's debug lines and any handled pipeline exception.
   * Without it, debug lines are dropped and handled exceptions go to console.warn.
   */
  onDebug?: (e: ReciteQuranDebugEvent) => void;
}

/**
 * The primary entry point for real-time Quran recitation tracking and
 * deterministic Tajweed verification (recite_quran.dart:35-37).
 */
export class ReciteQuran {
  readonly repository: QuranRepository;

  // ── 1. Initialization ──

  private readonly _transport: AsrTransport;
  private readonly _tokenProcessor: AsrTokenProcessor;
  private readonly _sequencer: DictationSequencer;
  private readonly _onDebug: ((e: ReciteQuranDebugEvent) => void) | null;

  private _config: TrackerConfig;
  private _isTajweed: boolean;
  private _isInitialized = false;
  private _isDisposed = false;
  private _isStarted = false;
  private _targetSurah = 0;

  // ── Broadcast streams (Dart StreamController.broadcast + StreamSubscription) ──

  private readonly _wordMatchedSubscribers = new Set<(e: WordMatchedEvent) => void>();
  private readonly _wordSkippedSubscribers = new Set<(e: WordMatchedEvent) => void>();
  private readonly _transcriptSubscribers = new Set<(t: string) => void>();
  private readonly _tajweedSubscribers = new Set<(e: WordMatchedEvent) => void>();

  private constructor(
    repository: QuranRepository,
    transport: AsrTransport,
    config: TrackerConfig,
    isTajweed: boolean,
    onDebug: ((e: ReciteQuranDebugEvent) => void) | null,
  ) {
    this.repository = repository;
    this._transport = transport;
    this._config = config;
    this._isTajweed = isTajweed;
    this._onDebug = onDebug;
    // recite_quran.dart:88 `_tokenProcessor = AsrTokenProcessor(config: _config)`
    this._tokenProcessor = new AsrTokenProcessor(config);
    // recite_quran.dart:109 `_wordSub = _isolate.wordStream.listen(...)`
    this._sequencer = new DictationSequencer((e) => this._onSequencerEvent(e));
  }

  /**
   * Builds and initializes a session: the Dart `ReciteQuran(...)` constructor
   * followed by `initialize()` (:94-113), then the initial `setTargetSurah` call.
   */
  static async createSession(opts: CreateSessionOptions): Promise<ReciteQuran> {
    const repository =
      opts.repository ??
      new QuranRepository(new QuranMetadataService(opts.loader));

    // The Dart repository resolves its data eagerly through its own caller; the
    // port awaits the surah before touching the pipeline so the reference is real.
    await repository.loadSurah(opts.surah);

    const session = new ReciteQuran(
      repository,
      opts.transport ?? new UnavailableAsrTransport(),
      opts.config ?? normalConfig(),
      opts.isTajweed ?? true,
      opts.onDebug ?? null,
    );

    // 1. Initialize the ASR transport (recite_quran.dart:101).
    await session._transport.initialize();

    // 2. Start the alignment pipeline and push the live settings into it
    //    (recite_quran.dart:104-106).
    session._sequencer.updateConfig(session._config);
    session._sequencer.setTajweedMode(session._isTajweed);

    // 3. Install the initial reference (:109-110 are the Dart subscriptions,
    //    already wired in the constructor above).
    await session.setTargetSurah(opts.surah, opts);

    session._isInitialized = true;
    return session;
  }

  // ── Public Streams & State ──

  /** Current active configuration. (:66) */
  get config(): TrackerConfig {
    return this._config;
  }

  /** Current target Surah number. (:69) */
  get targetSurah(): number {
    return this._targetSurah;
  }

  /** Indicates if Tajweed duration and closure evaluation is enabled. (:72) */
  get isTajweed(): boolean {
    return this._isTajweed;
  }

  /** Whether the engine and the alignment pipeline have been initialized. (:75) */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /** Whether the instance has been disposed. (:78) */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Whether `start()` has been called and `stop()` has not. */
  get isStarted(): boolean {
    return this._isStarted;
  }

  // ── 2. Audio & Tracking Control ──

  /** Starts the microphone and the recognizer feeding this session. */
  async start(): Promise<void> {
    if (this._isDisposed) {
      throw new Error('Cannot start a disposed ReciteQuran session.');
    }
    if (this._isStarted) return;
    // The callback replaces the Dart `_engine.transcriptionStream.listen(...)`
    // subscription (:110); `stop()` drops it.
    this._transport.start((result) => this._onTranscriptionResult(result));
    this._isStarted = true;
  }

  /** Stops the microphone and the recognizer, keeping the session reusable. */
  async stop(): Promise<void> {
    if (this._isDisposed) return;
    await this._transport.stop();
    this._isStarted = false;
  }

  // ── 3. Subscriptions (Dart broadcast streams) ──

  /** Green matches, red errors and neutral skips (recite_quran.dart:60). */
  onWordMatched(cb: (e: WordMatchedEvent) => void): () => void {
    return this._subscribe(this._wordMatchedSubscribers, cb);
  }

  /** Red (skipped/omitted) events only. */
  onWordSkipped(cb: (e: WordMatchedEvent) => void): () => void {
    return this._subscribe(this._wordSkippedSubscribers, cb);
  }

  /** Real-time live speech-to-text transcript (recite_quran.dart:63). */
  onTranscript(cb: (t: string) => void): () => void {
    return this._subscribe(this._transcriptSubscribers, cb);
  }

  /** Green matches that carry Tajweed errors. */
  onTajweed(cb: (e: WordMatchedEvent) => void): () => void {
    return this._subscribe(this._tajweedSubscribers, cb);
  }

  private _subscribe<T>(subscribers: Set<(t: T) => void>, cb: (t: T) => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }

  // ── 4. Surah & Ayah Target Setup ──

  /**
   * Sets the active Surah reference for recitation tracking
   * (recite_quran.dart:118-143).
   *
   * When `ayahFrom`/`ayahTo` are given, the reference is built from the words of
   * that ayah window only, with cumulative offsets rebased to 0 — the semantics
   * the Dart facade got from `setTargetSurah` + `startGlobalWord`, expressed on a
   * sliced `getSurahWords()` instead of a whole-surah reference.
   */
  async setTargetSurah(surahNumber: number, opts: SetTargetSurahOptions = {}): Promise<void> {
    if (this._isDisposed) return;
    this._targetSurah = surahNumber;
    await this.repository.loadSurah(surahNumber);
    const words = this.repository.getSurahWords(surahNumber);

    const window = this._ayahWindow(surahNumber, words, opts);
    if (window.length === 0) return; // dart:126 `if (words.isEmpty) return;`

    const phonemeWords = window.map((w) => w.phoneme);
    const wordRules = window.map((w) => w.rules);
    const boundaries = calculateBoundaries(phonemeWords);
    const fullPhonemes = phonemeWords.join('');

    const cmd: SetSurahReferenceCmd = {
      phonemes: fullPhonemes,
      boundaries,
      surahNumber,
      isTajweed: this._isTajweed,
      forceClear: true, // dart:121 default
      startGlobalWord: opts.startGlobalWord ?? 0,
      wordRules,
    };
    this._guard(() => this._sequencer.setSurahReference(cmd));
  }

  /**
   * The word slice backing the current reference (recite_quran.dart:125, narrowed
   * to an ayah range). `ayahFrom` starts at
   * `getAyahStartGlobalIndex(surah, ayahFrom)`; the window ends at the last word
   * of `ayahTo` (or of the surah when `ayahTo` is omitted).
   */
  private _ayahWindow(
    surahNumber: number,
    words: ContinuousQuranWord[],
    opts: SetTargetSurahOptions,
  ): ContinuousQuranWord[] {
    if (opts.ayahFrom === undefined && opts.ayahTo === undefined) return words;

    const start =
      opts.ayahFrom !== undefined
        ? Math.min(this.repository.getAyahStartGlobalIndex(surahNumber, opts.ayahFrom), words.length)
        : 0;

    let end = words.length;
    if (opts.ayahTo !== undefined) {
      const firstAfter = words.findIndex((w) => w.ayah > opts.ayahTo!);
      end = firstAfter === -1 ? words.length : firstAfter;
    }

    return end > start ? words.slice(start, end) : [];
  }

  /** Jumps the tracking cursor to a specific word index (recite_quran.dart:146-149). */
  jumpToWord(globalWordIndex: number): void {
    if (this._isDisposed) return;
    this._guard(() => this._sequencer.jumpToWord(globalWordIndex));
  }

  /** Resets the internal recognition buffer (recite_quran.dart:160-163). */
  resetBuffer(): void {
    if (this._isDisposed) return;
    this._transport.resetBuffer();
  }

  /** Toggles Tajweed evaluation on/off (recite_quran.dart:166-170). */
  setTajweedMode(active: boolean): void {
    if (this._isDisposed) return;
    this._isTajweed = active;
    this._guard(() => this._sequencer.setTajweedMode(active));
  }

  /** Updates difficulty and math thresholds dynamically (recite_quran.dart:173-178). */
  updateConfig(newConfig: TrackerConfig): void {
    if (this._isDisposed) return;
    this._config = newConfig;
    this._tokenProcessor.config = newConfig;
    this._guard(() => this._sequencer.updateConfig(newConfig));
  }

  // ── 5. Internal Message Pump ──

  /**
   * recite_quran.dart:182-195, with the per-character duration expansion of
   * highlighting_controller.dart:612-619 in place of the facade's token-level one.
   * `result.text` is surfaced before any filtering, then blank-only results stop
   * here (Dart `processed.isEmpty`).
   */
  private _onTranscriptionResult(result: TranscriptionResult): void {
    if (this._isDisposed) return;
    if (result.text.length > 0) {
      this._emit(this._transcriptSubscribers, result.text);
    }

    // The processor returns its live internal buffers — read-only from here on.
    const processed: ProcessedAudioStream = this._tokenProcessor.process(result);
    if (processed.tokens.length === 0) return;

    const asrString = processed.tokens.join('');
    const asrTimestamps = expandCharDurations(processed);

    const cmd: SyncStreamCmd = {
      text: asrString,
      timestamps: asrTimestamps,
      // The Dart facade never signals segment boundaries (:194 passes two args
      // only), and it has no ayah matcher to name one — kept as-is.
      isNewSegment: false,
      ayahNumber: 0,
    };
    this._guard(() => this._sequencer.syncStream(cmd));
  }

  /** recite_quran.dart:109-110 — the sequencer's events fan out to subscribers. */
  private _onSequencerEvent(event: SequencerEvent): void {
    if (this._isDisposed) return;

    if (event.type === 'debug') {
      if (this._onDebug !== null) this._onDebug(event);
      return;
    }

    const wordEvent: WordMatchedEvent = {
      wordId: event.wordId,
      score: event.score,
      cleanAsr: event.cleanAsr,
      tajweedErrors: event.tajweedErrors,
      isRed: event.isRed,
      isNeutral: event.isNeutral,
    };

    this._emit(this._wordMatchedSubscribers, wordEvent);

    // Red events are omissions: skipped, never "matched" as a recitation.
    if (wordEvent.isRed) {
      this._emit(this._wordSkippedSubscribers, wordEvent);
      return;
    }

    // highlighting_controller.dart:342-347 — only a green match that actually
    // carries errors raises a Tajweed notification.
    if (
      wordEvent.cleanAsr.length > 0 &&
      wordEvent.tajweedErrors !== null &&
      wordEvent.tajweedErrors.length > 0
    ) {
      this._emit(this._tajweedSubscribers, wordEvent);
    }
  }

  /** Iterates a snapshot so a subscriber may unsubscribe inside its callback. */
  private _emit<T>(subscribers: Set<(t: T) => void>, payload: T): void {
    for (const cb of [...subscribers]) {
      cb(payload);
    }
  }

  /**
   * phoneme_alignment_isolate_io.dart:32-59 — a command that throws inside the
   * worker is reported as a debug event instead of tearing the pipeline down.
   */
  private _guard(command: () => void): void {
    try {
      command();
    } catch (e) {
      const stack = e instanceof Error && e.stack !== undefined ? `\n${e.stack}` : '';
      const message = `⚠️ [ISOLATE ERROR] Handled exception: ${String(e)}${stack}`;
      if (this._onDebug !== null) {
        this._onDebug({ message, asrBuffer: this._sequencer.currentSegmentAsrText });
      } else {
        console.warn(`[ReciteQuran] ${message}`);
      }
    }
  }

  // ── 6. Cleanup ──

  /** recite_quran.dart:209-228. */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._isInitialized = false;
    this._isStarted = false;

    // The Dart subscriptions are cancelled (no listener registry to keep).
    this._wordMatchedSubscribers.clear();
    this._wordSkippedSubscribers.clear();
    this._transcriptSubscribers.clear();
    this._tajweedSubscribers.clear();

    this._transport.destroy();
  }
}

/** Re-exported for callers that build the reference arrays themselves. */
export type { WordTajweedRule };