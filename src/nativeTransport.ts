// src/nativeTransport.ts
// The AsrTransport implementation that binds this package to the Task 11
// Android bridge (ReciteQuranModule.kt). It owns NO recognition logic: every
// token, timestamp and decision stays native, and the only work done here is
//
//   * subscribing to `ReciteQuranTokenResult` and adapting each payload into
//     the `TranscriptionResult` the session consumes (types.ts:6-13),
//   * tracking `streamEpoch`, the reset/segment signal, so a `resetBuffer()` is
//     observable as a segment change (Task 11 carried requirement (e)),
//   * ordering the lifecycle (initialize → start → stop → resetBuffer →
//     destroy) and mapping bridge failures onto typed errors.
//
// Requirements carried from the Task 11 review, honoured here:
//
//   (a) The module declares RECORD_AUDIO in its manifest but never asks for it,
//       so acquisition is exposed to the host (`requestMicrophonePermission()`,
//       usable at app start) *and* performed before every `start()`.
//   (b) `feedAudioBase64` drops chunks and returns false while the recognizer
//       is still coming up, so nothing here treats that boolean as a queue:
//       initialization is serialized ahead of `start()`, and a feed attempted
//       too early raises E_NOT_INITIALIZED instead of silently losing audio.
//   (c) `initialize()` is always called with an explicit argument — an explicit
//       `null` model path when none is configured — because the RN interop
//       layer builds the call from the declared arity.
//   (d) After any `isFinal` result (endpoint or explicit flush) and after
//       `processWav`, the native stream is permanently finished
//       (SherpaAsrEngine.kt:206-211, :263-264). The transport resets that
//       stream eagerly, the moment the final arrives — the live microphone
//       feeds the engine natively, so its next 480 ms chunk never passes
//       through a JS feed method where the lazy "reset before the next feed"
//       could run — and keeps the lazy reset before a JS-initiated resume as a
//       second net.
//   (e) A changed `streamEpoch` is surfaced through `onSegmentChange` and
//       carried on every `TranscriptionResult`, which is what the sequencer
//       needs to re-base instead of the Dart facade's hardcoded
//       `isNewSegment: false` (session.ts:423).
//   (f) The native engine is process-wide and stays warm between sessions,
//       while every transport instance is fresh. A new transport therefore
//       adopts an unknown stream and resets the buffer once, before its first
//       feed (`start()`, `feedAudioBase64()` or `processWav()`): the previous
//       session's decode state — trailing audio and the partial hypothesis —
//       would otherwise be re-emitted as this session's first results and
//       re-commit words nobody recited here.

import {
  addNativeListener,
  EVENT_ERROR,
  EVENT_TOKEN_RESULT,
  getNativeModule,
  NativeTokenResultPayload,
  NativeInitializeResult,
  NativeTransportError,
  NativeTransportErrorCode,
  requestRecordAudioPermission,
  toNativeTransportError,
} from './nativeModule';
import { AsrTransport } from './session';
import { TranscriptionResult } from './types';

export { NativeTransportError };
export type { NativeTransportErrorCode };

/** `streamEpoch` changed: the recognizer re-based after a reset. */
export interface SegmentChangeEvent {
  streamEpoch: number;
  /** `null` for the first observed epoch — that is a first result, not a change. */
  previousStreamEpoch: number | null;
}

export interface NativeAsrTransport extends AsrTransport {
  /**
   * Acquires RECORD_AUDIO. Call it during app start-up (requirement (a)) so the
   * prompt does not appear at the moment recitation begins; it is idempotent
   * and `start()` acquires the permission again if it is still missing.
   * Rejects with E_PERMISSION when the user declines.
   */
  requestMicrophonePermission(): Promise<void>;
  /**
   * Typed asynchronous failures. `start()` returns void (like the bridge's own
   * `fun start()`), so failures that happen after it — a denied microphone, a
   * `ReciteQuranError` event, a failing recorder — are reported here instead of
   * being thrown at nobody.
   */
  onError(cb: (error: NativeTransportError) => void): () => void;
  /** Requirement (e): the reset/segment boundary. */
  onSegmentChange(cb: (event: SegmentChangeEvent) => void): () => void;
  /**
   * Epoch time (ms) of the last native result — partials included. A live
   * microphone emits a result for every 480 ms chunk even in silence, so this
   * is the liveness signal that tells "reciter paused" (results keep flowing,
   * text stays empty) from "pipeline dead" (no results at all). Null until the
   * first result of this transport arrives.
   */
  readonly lastResultAt: number | null;
  /**
   * Offline/test feed path: base64 of little-endian float32 samples in [-1, 1].
   * Returns whether the bridge accepted the chunk; because that boolean means
   * "dropped" rather than "queued" (requirement (b)), a feed before a resolved
   * initialize throws E_NOT_INITIALIZED instead of reporting a silent drop.
   */
  feedAudioBase64(audioBase64: string, isFinal?: boolean): boolean;
  /** Decodes a 16-bit WAV through the recognizer. Also finishes the stream. */
  processWav(path: string): Promise<void>;
  /** Warms/downloads the model and resolves its absolute on-device path. */
  prefetchModel(): Promise<string>;
}

export interface CreateNativeTransportOptions {
  /**
   * Acoustic model source. When given, the transport resolves a concrete
   * on-device path through `prefetchModel()` and hands that path to
   * `initialize(modelPath)`. When omitted, `initialize(null)` is called and the
   * bridge uses its own cached or bundled default.
   *
   * Note: ReciteQuranModule currently bakes in its own download URL and exposes
   * no setter, so the value selects "explicit model source" mode rather than a
   * different host. It must still be an http(s) URL, otherwise the transport
   * fails fast instead of downloading something the caller did not ask for.
   */
  modelUrl?: string;
}

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const toNumberArray = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((item) => toNumber(item)) : [];

/**
 * ReciteQuranModule.emitTokenResult (:496-512) → TranscriptionResult
 * (types.ts:6-13). Every field is normalised because the payload arrives from
 * Kotlin as an untyped `WritableMap` (arrays and doubles).
 */
const toTranscriptionResult = (payload: NativeTokenResultPayload): TranscriptionResult => ({
  text: typeof payload?.text === 'string' ? payload.text : '',
  tokens: toStringArray(payload?.tokens),
  timestamps: toNumberArray(payload?.timestamps),
  isFinal: payload?.isFinal === true,
  startTime: toNumber(payload?.startTime),
  streamEpoch: toNumber(payload?.streamEpoch),
});

/** True for an http(s) URL; anything else is a configuration mistake. */
const isHttpUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value);

class NativeAsrTransportImpl implements NativeAsrTransport {
  private readonly _modelUrl: string | null;

  private _initPromise: Promise<void> | null = null;
  private _initialized = false;
  private _starting = false;
  private _started = false;
  private _destroyed = false;
  private _permissionGranted = false;

  /**
   * Requirement (d): after a final result the native stream can no longer be
   * fed. The stream is reset eagerly when the final arrives (the live mic
   * never resumes through a JS feed); this flag still gates the lazy reset
   * before a JS-initiated resume, as a second net.
   */
  private _streamFinished = false;
  private _streamEpoch: number | null = null;

  /** Native-result liveness for the host watchdog (see the interface doc). */
  private _lastResultAt: number | null = null;

  /**
   * Requirement (f): a fresh transport adopts a shared, possibly warm native
   * engine, so its first feed must start from a reset stream. Reset exactly
   * once per transport — a later `resetBuffer()` is the caller's decision
   * (`resetBuffer()`, or the resume after a final in `_beginStart`).
   */
  private _streamAdopted = false;

  private _onResult: ((result: TranscriptionResult) => void) | null = null;
  private _detachListeners: (() => void) | null = null;

  private readonly _errorSubscribers = new Set<(error: NativeTransportError) => void>();
  private readonly _segmentSubscribers = new Set<(event: SegmentChangeEvent) => void>();

  constructor(modelUrl: string | undefined) {
    this._modelUrl = modelUrl ?? null;
  }

  get lastResultAt(): number | null {
    return this._lastResultAt;
  }

  // ── AsrTransport ───────────────────────────────────────────────────────────

  /** ReciteQuranModule.initialize (:136-168); idempotent on both sides. */
  initialize(): Promise<void> {
    if (this._initialized) return Promise.resolve();
    if (this._initPromise === null) this._initPromise = this._runInitialize();
    return this._initPromise;
  }

  start(onResult: (result: TranscriptionResult) => void): void {
    if (this._destroyed) return;
    this._onResult = onResult;
    if (this._started || this._starting) return;
    this._starting = true;
    void this._beginStart();
  }

  /** ReciteQuranModule.stop (:210-222) — the recognizer stays warm. */
  async stop(): Promise<void> {
    if (this._destroyed || !this._initialized) return;
    this._started = false;
    try {
      await getNativeModule().stop();
    } catch (error) {
      throw toNativeTransportError(error, 'E_NATIVE', 'stop() failed');
    }
  }

  /**
   * ReciteQuranModule.resetBuffer (:224-235). A no-op before initialize(),
   * matching the Dart engine's `if (!_isInitialized) return`
   * (sherpa_engine_io.dart:218).
   */
  resetBuffer(): void {
    if (this._destroyed || !this._initialized) return;
    try {
      this._resetStream();
    } catch (error) {
      this._report(toNativeTransportError(error, 'E_NATIVE', 'resetBuffer() failed'));
    }
  }

  /**
   * The bridge has no destroy method — React Native tears the engine down
   * through ReciteQuranModule.invalidate() (:299-330). What the JS side owes
   * it is a stopped microphone and no remaining listener, so both are released
   * here; a stop that was never started is left alone.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    const wasStarted = this._started;
    this._started = false;
    this._onResult = null;
    this._detach();

    if (!this._initialized || !wasStarted) return;
    try {
      void getNativeModule().stop().catch((error: unknown) => {
        this._report(toNativeTransportError(error, 'E_NATIVE', 'stop() on destroy failed'));
      });
    } catch (error) {
      this._report(toNativeTransportError(error, 'E_NATIVE', 'stop() on destroy failed'));
    }
  }

  // ── NativeAsrTransport additions ────────────────────────────────────────────

  async requestMicrophonePermission(): Promise<void> {
    await this._ensurePermission();
  }

  onError(cb: (error: NativeTransportError) => void): () => void {
    return this._subscribe(this._errorSubscribers, cb);
  }

  onSegmentChange(cb: (event: SegmentChangeEvent) => void): () => void {
    return this._subscribe(this._segmentSubscribers, cb);
  }

  feedAudioBase64(audioBase64: string, isFinal = false): boolean {
    this._assertUsable('feedAudioBase64');
    this._adoptStream();
    let accepted: boolean;
    try {
      accepted = getNativeModule().feedAudioBase64(audioBase64, isFinal);
    } catch (error) {
      throw toNativeTransportError(error, 'E_NATIVE', 'feedAudioBase64() failed');
    }
    if (accepted && isFinal) this._streamFinished = true;
    return accepted;
  }

  async processWav(path: string): Promise<void> {
    this._assertUsable('processWav');
    this._adoptStream();
    try {
      await getNativeModule().processWav(path);
    } catch (error) {
      throw toNativeTransportError(error, 'E_NATIVE', `processWav('${path}') failed`);
    }
    // processWav always runs to a final result, so the stream is finished.
    this._streamFinished = true;
  }

  async prefetchModel(): Promise<string> {
    try {
      return await getNativeModule().prefetchModel();
    } catch (error) {
      throw toNativeTransportError(error, 'E_MODEL', 'prefetchModel() failed');
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _runInitialize(): Promise<void> {
    try {
      const modelPath = await this._resolveModelPath();

      let response: NativeInitializeResult | undefined;
      try {
        response = await getNativeModule().initialize(modelPath);
      } catch (error) {
        // ReciteQuranModule.initialize always *resolves* `{ok, error?}`
        // (:161, :165); a rejection is a genuine bridge failure.
        throw toNativeTransportError(error, 'E_NATIVE', 'initialize() failed');
      }

      if (response === null || response === undefined || response.ok !== true) {
        throw new NativeTransportError(
          'E_INITIALIZE',
          `ReciteQuran: initialize() failed: ${response?.error ?? 'unknown error'}`,
        );
      }
      this._initialized = true;
      this._attach();
      this._initPromise = null;
    } catch (error) {
      this._initPromise = null;
      throw error instanceof NativeTransportError
        ? error
        : toNativeTransportError(error, 'E_INITIALIZE', 'initialize() failed');
    }
  }

  /**
   * Requirement (c): an explicit argument is always passed. With a model url the
   * path is resolved up front so a slow download happens before the recognizer
   * is created; without one, `null` tells the bridge to use its own cache or
   * default download.
   */
  private async _resolveModelPath(): Promise<string | null> {
    if (this._modelUrl === null) return null;
    if (!isHttpUrl(this._modelUrl)) {
      throw new NativeTransportError(
        'E_MODEL',
        `ReciteQuran: modelUrl must be an http(s) URL, got '${this._modelUrl}'.`,
      );
    }
    return this.prefetchModel();
  }

  private async _beginStart(): Promise<void> {
    try {
      // Requirement (b): the microphone is never opened before the recognizer
      // is up, and a failed initialization must not reach the recorder.
      if (this._initPromise !== null) await this._initPromise;
      if (!this._initialized) {
        throw new NativeTransportError(
          'E_NOT_INITIALIZED',
          'ReciteQuran: start() needs a resolved initialize(); await it first.',
        );
      }
      await this._ensurePermission();
      // Requirement (d): a stream that ended on a final cannot be fed again.
      // Requirement (f): the first feed adopts the shared engine's stream.
      this._adoptStream();
      if (this._streamFinished) this._resetStream();
      if (this._destroyed) return;
      getNativeModule().start();
      this._started = true;
    } catch (error) {
      this._report(toNativeTransportError(error, 'E_NATIVE', 'start() failed'));
    } finally {
      this._starting = false;
    }
  }

  private async _ensurePermission(): Promise<void> {
    if (this._permissionGranted) return;
    await requestRecordAudioPermission();
    this._permissionGranted = true;
  }

  /** `_resetStream` clears the finished flag whether or not the bridge answers. */
  private _resetStream(): void {
    getNativeModule().resetBuffer();
    this._streamFinished = false;
  }

  /**
   * Requirement (f): resets the native stream the first time this transport
   * feeds audio. The engine outlives the session that created it, so without
   * this the new session inherits the previous one's decode state and its
   * first results re-commit the previous session's words. A failure is
   * reported but not raised: feeding an unreset stream degrades tracking,
   * which the caller still handles, while a throw here would abort a start
   * that the bridge has already accepted.
   */
  private _adoptStream(): void {
    if (this._streamAdopted) return;
    this._streamAdopted = true;
    try {
      this._resetStream();
    } catch (error) {
      this._report(toNativeTransportError(error, 'E_NATIVE', 'stream adoption reset failed'));
    }
  }

  private _assertUsable(operation: string): void {
    if (this._destroyed) {
      throw new NativeTransportError(
        'E_NOT_INITIALIZED',
        `ReciteQuran: ${operation}() was called on a destroyed transport.`,
      );
    }
    if (!this._initialized) {
      throw new NativeTransportError(
        'E_NOT_INITIALIZED',
        `ReciteQuran: ${operation}() needs a resolved initialize(); the bridge ` +
          'drops chunks that arrive before the recognizer is ready.',
      );
    }
  }

  private _attach(): void {
    const detachResults = addNativeListener<NativeTokenResultPayload>(EVENT_TOKEN_RESULT, (payload) =>
      this._handleTokenResult(payload),
    );
    const detachErrors = addNativeListener<{ message?: unknown }>(EVENT_ERROR, (payload) => {
      const message = typeof payload?.message === 'string' ? payload.message : 'unknown error';
      this._report(new NativeTransportError('E_NATIVE', `ReciteQuran: ${message}`));
    });
    this._detachListeners = () => {
      detachResults();
      detachErrors();
    };
  }

  private _detach(): void {
    if (this._detachListeners === null) return;
    this._detachListeners();
    this._detachListeners = null;
  }

  /**
   * Requirement (e): the epoch bump is published before the result it belongs
   * to, so a subscriber can re-base before it sees the new segment's tokens.
   */
  private _handleTokenResult(payload: NativeTokenResultPayload): void {
    if (this._destroyed) return;

    const result = toTranscriptionResult(payload);
    this._lastResultAt = Date.now();
    if (result.isFinal) this._streamFinished = true;

    const previousEpoch = this._streamEpoch;
    this._streamEpoch = result.streamEpoch;
    if (previousEpoch !== null && previousEpoch !== result.streamEpoch) {
      this._emit(this._segmentSubscribers, {
        streamEpoch: result.streamEpoch,
        previousStreamEpoch: previousEpoch,
      });
    }

    const handler = this._onResult;
    if (handler !== null) {
      try {
        handler(result);
      } catch (error) {
        // A throwing subscriber must not tear down the bridge's event delivery.
        this._report(toNativeTransportError(error, 'E_NATIVE', 'onResult subscriber threw'));
      }
    }

    // Requirement (d), live-microphone leg: the final above ended the stream.
    if (result.isFinal) this._resetFinishedStream();
  }

  /**
   * Requirement (d) for the live microphone. A final result (endpoint or
   * explicit flush) leaves the native stream permanently finished, and the mic
   * keeps feeding 480 ms chunks natively — straight into `engine.feed()`, never
   * through `feedAudioBase64()`/`processWav()` — so the lazy "reset before the
   * next JS feed" contract can never run mid-session. Without this reset the
   * decoder keeps filling the finished stream: partials stay gated off after
   * the endpoint, the epoch never bumps, and the session never matches another
   * word. Resetting the moment the final lands gives the next utterance a
   * fresh stream whose epoch bump surfaces as the segment change the
   * sequencer re-bases on (requirement (e)).
   */
  private _resetFinishedStream(): void {
    if (this._destroyed || !this._initialized) return;
    try {
      this._resetStream();
    } catch (error) {
      this._report(toNativeTransportError(error, 'E_NATIVE', 'post-final stream reset failed'));
    }
  }

  private _report(error: NativeTransportError): void {
    for (const subscriber of [...this._errorSubscribers]) subscriber(error);
  }

  /** Iterates a snapshot so a subscriber may unsubscribe inside its callback. */
  private _subscribe<T>(subscribers: Set<(value: T) => void>, cb: (value: T) => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }

  private _emit<T>(subscribers: Set<(value: T) => void>, payload: T): void {
    for (const subscriber of [...subscribers]) subscriber(payload);
  }
}

/**
 * Builds the transport the React Native host injects into
 * `ReciteQuran.createSession({ transport })`. React Native itself is only
 * touched once a lifecycle method runs, so importing this module in Node (or in
 * Jest without a mocked `react-native`) is harmless.
 */
export function createNativeTransport(opts?: CreateNativeTransportOptions): NativeAsrTransport {
  return new NativeAsrTransportImpl(opts?.modelUrl);
}
