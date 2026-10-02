// src/nativeModule.ts
// Thin, typed wrapper over the Task 11 Android bridge — the ONLY file in this
// package that touches `react-native`. Nothing here interprets audio, tokens or
// timestamps: it maps the Kotlin contract in
// android/src/main/java/com/recitequran/ReciteQuranModule.kt onto promises and
// typed errors, and `react-native` is required lazily inside functions so Node
// and Jest never load it (core engine behaviour, plan Task 2 note).
//
// Bridge contract consumed here (ReciteQuranModule.kt:30-39):
//
//   | JS                                        | Kotlin            |
//   |-------------------------------------------|-------------------|
//   | initialize(modelPath?) -> {ok, error?}    | initialize        |
//   | prefetchModel() -> Promise<string>        | prefetchModel     |
//   | start()                                   | start             |
//   | stop() -> Promise<void>                   | stop              |
//   | resetBuffer()                             | resetBuffer       |
//   | feedAudioBase64(b64, isFinal) -> boolean  | feedAudioBase64   |
//   | processWav(path) -> Promise<void>         | processWav        |
//   | 'ReciteQuranTokenResult' event            | emitTokenResult   |
//   | 'ReciteQuranError' event                  | emitError         |
//
// Every number crosses the bridge as a double (Arguments.putDouble,
// ReciteQuranModule.kt:509-510), so the payload fields are all `number`.

/**
 * `declare function require` rather than an `import`: `react-native` is a peer
 * dependency, importing it at module scope would make every consumer of
 * src/index.ts load React Native, and typing it would make the build depend on
 * React Native's bundled .d.ts. TypeScript erases this declaration; the call
 * itself stays inside the functions below.
 */
declare function require(moduleId: string): unknown;

export type NativeTransportErrorCode =
  /** `react-native` or `NativeModules.ReciteQuran` is absent (not linked). */
  | 'E_UNAVAILABLE'
  /** RECORD_AUDIO was not granted. */
  | 'E_PERMISSION'
  /** A lifecycle call was made before a successful initialize(). */
  | 'E_NOT_INITIALIZED'
  /** The model source could not be resolved. */
  | 'E_MODEL'
  /** `initialize()` resolved `{ok: false}`. */
  | 'E_INITIALIZE'
  /** Any other bridge failure: a `ReciteQuranError` event or a rejection. */
  | 'E_NATIVE';

/**
 * Every failure that crosses the transport boundary carries a stable code, so a
 * host can branch (retry the download, re-prompt for the microphone) without
 * string-matching engine text.
 */
export class NativeTransportError extends Error {
  readonly code: NativeTransportErrorCode;

  constructor(code: NativeTransportErrorCode, message: string) {
    super(message);
    this.name = 'NativeTransportError';
    this.code = code;
    // Restores the prototype chain under `target: ES2020` downlevel emit.
    Object.setPrototypeOf(this, NativeTransportError.prototype);
  }
}

/** `{ text, tokens, timestamps, isFinal, startTime, streamEpoch }` (:60-62). */
export interface NativeTokenResultPayload {
  text: string;
  tokens: string[];
  timestamps: number[];
  isFinal: boolean;
  startTime: number;
  streamEpoch: number;
}

/** `{ ok, error? }` (okResult/failureResult, ReciteQuranModule.kt:557-564). */
export interface NativeInitializeResult {
  ok: boolean;
  error?: string;
}

/** The seven `@ReactMethod`s plus the module lookup, typed. */
export interface ReciteQuranNativeModule {
  initialize(modelPath: string | null): Promise<NativeInitializeResult>;
  prefetchModel(): Promise<string>;
  start(): void;
  stop(): Promise<void>;
  resetBuffer(): void;
  feedAudioBase64(audioBase64: string, isFinal: boolean): boolean;
  processWav(path: string): Promise<void>;
}

interface EventSubscription {
  remove(): void;
}

interface EmitterLike {
  addListener(eventType: string, listener: (payload: unknown) => void): EventSubscription;
}

interface PermissionsAndroidLike {
  PERMISSIONS?: Record<string, string>;
  RESULTS?: Record<string, string>;
  request?(permission: string): Promise<string>;
  check?(permission: string): Promise<boolean>;
}

/**
 * The structural slice of `react-native` this package needs. Declared here
 * rather than imported so the package builds without React Native's types.
 */
interface ReactNativeLike {
  NativeModules?: Record<string, unknown>;
  NativeEventEmitter?: new (nativeModule?: unknown) => EmitterLike;
  Platform?: { OS?: string; Version?: number | string };
  PermissionsAndroid?: PermissionsAndroidLike;
}

/** `ReciteQuranModule.EVENT_TOKEN_RESULT` (ReciteQuranModule.kt:61). */
export const EVENT_TOKEN_RESULT = 'ReciteQuranTokenResult';

/** `ReciteQuranModule.EVENT_ERROR` (ReciteQuranModule.kt:67). */
export const EVENT_ERROR = 'ReciteQuranError';

const MISSING_MODULE_MESSAGE =
  'ReciteQuran: NativeModules.ReciteQuran is not available. The native module ' +
  'is Android-only and needs a development build (a config plugin or a manual ' +
  'android/ link) — it cannot run in Expo Go, a simulator or Node.';

function requireReactNative(): ReactNativeLike | null {
  try {
    return (require('react-native') as Partial<ReactNativeLike> | undefined) ?? null;
  } catch {
    // No React Native in this runtime (Node, Jest without a mock, SSR).
    return null;
  }
}

/** The React Native runtime, or a typed failure. */
export function getReactNative(): ReactNativeLike {
  const reactNative = requireReactNative();
  if (reactNative === null) {
    throw new NativeTransportError(
      'E_UNAVAILABLE',
      'ReciteQuran: `react-native` could not be loaded in this runtime.',
    );
  }
  return reactNative;
}

/** `NativeModules.ReciteQuran`, or a typed failure when it is not linked. */
export function getNativeModule(): ReciteQuranNativeModule {
  const reactNative = getReactNative();
  const nativeModule = reactNative.NativeModules?.ReciteQuran;
  if (nativeModule === undefined || nativeModule === null) {
    throw new NativeTransportError('E_UNAVAILABLE', MISSING_MODULE_MESSAGE);
  }
  return nativeModule as ReciteQuranNativeModule;
}

/**
 * `new NativeEventEmitter(module)` is only correct for modules that implement
 * `addListener`/`removeListeners`; React Native 0.87 warns and ignores anything
 * else (NativeEventEmitter.js:75-99). `ReciteQuranModule` emits straight to
 * RCTDeviceEventEmitter, so the module is passed only when it can honour the
 * listener-count protocol, and the global device emitter receives the event in
 * both cases.
 */
function emitterModuleArgument(reactNative: ReactNativeLike): unknown {
  const nativeModule = reactNative.NativeModules?.ReciteQuran as
    | { addListener?: unknown; removeListeners?: unknown }
    | undefined;
  if (
    nativeModule !== undefined &&
    typeof nativeModule.addListener === 'function' &&
    typeof nativeModule.removeListeners === 'function'
  ) {
    return nativeModule;
  }
  return undefined;
}

/**
 * Subscribes to a bridge event and returns an unsubscribe function (the
 * StreamSubscription.cancel() of the Dart facade).
 */
export function addNativeListener<T>(
  event: string,
  listener: (payload: T) => void,
): () => void {
  const reactNative = getReactNative();
  const Emitter = reactNative.NativeEventEmitter;
  if (typeof Emitter !== 'function') {
    throw new NativeTransportError(
      'E_UNAVAILABLE',
      'ReciteQuran: `NativeEventEmitter` is not available in this runtime.',
    );
  }
  const subscription = new Emitter(emitterModuleArgument(reactNative)).addListener(
    event,
    (payload: unknown) => listener(payload as T),
  );
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    subscription.remove();
  };
}

/**
 * Requests RECORD_AUDIO (Task 11 carried requirement (a): the module declares
 * the permission but never asks for it). Resolves silently where the API does
 * not exist or where the platform is not Android, and throws E_PERMISSION when
 * the user declines — the failure is never swallowed.
 */
export async function requestRecordAudioPermission(): Promise<void> {
  const reactNative = getReactNative();
  if (reactNative.Platform?.OS !== 'android') return;

  const permissions = reactNative.PermissionsAndroid;
  const permission = permissions?.PERMISSIONS?.RECORD_AUDIO;
  if (typeof permissions?.request !== 'function' || typeof permission !== 'string') {
    // Older platforms/versions without PermissionsAndroid: nothing to request.
    return;
  }

  if (typeof permissions.check === 'function') {
    try {
      if (await permissions.check(permission)) return;
    } catch {
      // A failing check must not skip the request.
    }
  }

  const status = await permissions.request(permission);
  const granted = permissions.RESULTS?.GRANTED;
  if (status !== granted) {
    throw new NativeTransportError(
      'E_PERMISSION',
      `ReciteQuran: RECORD_AUDIO was not granted (${status ?? 'unknown'}). ` +
        'The microphone cannot be opened.',
    );
  }
}

/** Wraps anything thrown by the bridge in a typed error carrying a code. */
export function toNativeTransportError(
  error: unknown,
  code: NativeTransportErrorCode,
  context: string,
): NativeTransportError {
  if (error instanceof NativeTransportError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new NativeTransportError(code, `ReciteQuran: ${context}: ${detail}`);
}
