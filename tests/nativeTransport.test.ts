// tests/nativeTransport.test.ts
// Transport-only port check for the Task 11 Android bridge
// (android/src/main/java/com/recitequran/ReciteQuranModule.kt).
//
// `react-native` is mocked wholesale because it is a peer dependency: the
// transport must reach the bridge through NativeModules/NativeEventEmitter and
// through nothing else, and the engine must stay loadable in plain Node.
//
// The Kotlin contract under test (ReciteQuranModule.kt:30-39, :496-512):
//   initialize(modelPath?) -> {ok, error?}      start() / stop() -> Promise<void>
//   resetBuffer()                              feedAudioBase64(b64, isFinal) -> boolean
//   processWav(path) -> Promise<void>           prefetchModel() -> Promise<string>
//   'ReciteQuranTokenResult' -> {text, tokens, timestamps, isFinal, startTime, streamEpoch}
//   'ReciteQuranError'       -> {message}

type Listener = (payload: unknown) => void;

// ── react-native mock ─────────────────────────────────────────────────────────

const mockNative = {
  initialize: jest.fn(),
  prefetchModel: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  resetBuffer: jest.fn(),
  feedAudioBase64: jest.fn(),
  processWav: jest.fn(),
};

const mockListeners = new Map<string, Set<Listener>>();

class MockNativeEventEmitter {
  static instances: MockNativeEventEmitter[] = [];

  readonly nativeModule: unknown;

  constructor(nativeModule?: unknown) {
    this.nativeModule = nativeModule;
    MockNativeEventEmitter.instances.push(this);
  }

  addListener(eventType: string, listener: Listener): { remove: () => void } {
    const set = mockListeners.get(eventType) ?? new Set<Listener>();
    set.add(listener);
    mockListeners.set(eventType, set);
    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  removeAllListeners(eventType?: string): void {
    if (eventType === undefined) mockListeners.clear();
    else mockListeners.get(eventType)?.clear();
  }

  static listenerCount(eventType: string): number {
    return mockListeners.get(eventType)?.size ?? 0;
  }

  static emit(eventType: string, payload: unknown): void {
    for (const listener of [...(mockListeners.get(eventType) ?? [])]) listener(payload);
  }
}

const mockRequest = jest.fn();
const mockCheck = jest.fn();

const mockRn: any = {
  NativeModules: { ReciteQuran: mockNative },
  NativeEventEmitter: MockNativeEventEmitter,
  Platform: { OS: 'android', Version: 33 },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
    request: mockRequest,
    check: mockCheck,
  },
};

jest.mock('react-native', () => mockRn);

// ── helpers ───────────────────────────────────────────────────────────────────

const EVENT_TOKEN_RESULT = 'ReciteQuranTokenResult';
const EVENT_ERROR = 'ReciteQuranError';

const MODEL_PATH = '/data/user/0/app/files/recitequran/zipformer_p_arabic_v3.int8.onnx';

const tokenPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: 'بسم الله',
  tokens: ['بسم', ' الله'],
  timestamps: [0.1, 0.5],
  isFinal: false,
  startTime: 1700000000000,
  streamEpoch: 0,
  ...over,
});

const emitTokenResult = (over: Record<string, unknown> = {}): void =>
  MockNativeEventEmitter.emit(EVENT_TOKEN_RESULT, tokenPayload(over));

const emitNativeError = (message: string): void =>
  MockNativeEventEmitter.emit(EVENT_ERROR, { message });

const callLog = (): string[] => mockRn.callLog as string[];

const track = (name: string): void => {
  callLog().push(name);
};

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

async function expectRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<NativeTransportErrorShape> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeTransportError);
  const error = caught as NativeTransportErrorShape;
  expect(error.code).toBe(code);
  return error;
}

interface NativeTransportErrorShape extends Error {
  code: string;
}

// ── tests ─────────────────────────────────────────────────────────────────────

import {
  createNativeTransport,
  NativeAsrTransport,
  NativeTransportError,
} from '../src/nativeTransport';
import { TranscriptionResult } from '../src/types';

describe('createNativeTransport', () => {
  let onResult: jest.Mock<void, [TranscriptionResult]>;

  beforeEach(() => {
    mockListeners.clear();
    MockNativeEventEmitter.instances.length = 0;
    mockRequest.mockReset();
    mockCheck.mockReset();
    for (const fn of Object.values(mockNative)) fn.mockReset();

    mockNative.initialize.mockImplementation(() => Promise.resolve({ ok: true }));
    mockNative.prefetchModel.mockImplementation(() => Promise.resolve(MODEL_PATH));
    mockNative.stop.mockImplementation(() => Promise.resolve(undefined));
    mockNative.processWav.mockImplementation(() => Promise.resolve(undefined));
    mockNative.start.mockImplementation(() => undefined);
    mockNative.resetBuffer.mockImplementation(() => undefined);
    mockNative.feedAudioBase64.mockImplementation(() => true);
    mockRequest.mockImplementation(() => Promise.resolve('granted'));
    mockCheck.mockImplementation(() => Promise.resolve(false));

    mockRn.callLog = [];
    mockRn.Platform.OS = 'android';
    mockRn.NativeModules.ReciteQuran = mockNative;
    mockRn.PermissionsAndroid = {
      PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
      RESULTS: {
        GRANTED: 'granted',
        DENIED: 'denied',
        NEVER_ASK_AGAIN: 'never_ask_again',
      },
      request: mockRequest,
      check: mockCheck,
    };

    onResult = jest.fn<void, [TranscriptionResult]>();
  });

  describe('event adaptation', () => {
    it('adapts a ReciteQuranTokenResult payload into a TranscriptionResult', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);

      emitTokenResult({
        text: 'بسم الله',
        tokens: ['بسم', ' الله'],
        timestamps: [0.1, 0.5],
        startTime: 1700000000123,
      });

      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith({
        text: 'بسم الله',
        tokens: ['بسم', ' الله'],
        timestamps: [0.1, 0.5],
        isFinal: false,
        startTime: 1700000000123,
        streamEpoch: 0,
      });
      transport.destroy();
    });

    it('adapts a final result with isFinal true', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);

      emitTokenResult({ isFinal: true });

      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ isFinal: true }));
      transport.destroy();
    });

    it('normalises a payload whose arrays are missing', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);

      MockNativeEventEmitter.emit(EVENT_TOKEN_RESULT, {
        text: 'x',
        isFinal: false,
        startTime: 7,
        streamEpoch: 3,
      });

      expect(onResult).toHaveBeenCalledWith({
        text: 'x',
        tokens: [],
        timestamps: [],
        isFinal: false,
        startTime: 7,
        streamEpoch: 3,
      });
      transport.destroy();
    });

    it('builds the event emitter without a module argument when the bridge has no addListener', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      expect(MockNativeEventEmitter.instances.length).toBeGreaterThan(0);
      expect(MockNativeEventEmitter.instances[0].nativeModule).toBeUndefined();
      transport.destroy();
    });
  });

  describe('streamEpoch segment signal', () => {
    it('does not signal a segment change for the first epoch it observes', async () => {
      const onSegmentChange = jest.fn();
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onSegmentChange(onSegmentChange);
      transport.start(onResult);

      emitTokenResult({ streamEpoch: 0 });

      expect(onSegmentChange).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('signals a segment change when the epoch bumps, and still delivers the result', async () => {
      const onSegmentChange = jest.fn();
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onSegmentChange(onSegmentChange);
      transport.start(onResult);

      emitTokenResult({ streamEpoch: 0 });
      emitTokenResult({ streamEpoch: 1, text: 'الرحمن' });

      expect(onSegmentChange).toHaveBeenCalledTimes(1);
      expect(onSegmentChange).toHaveBeenCalledWith({ streamEpoch: 1, previousStreamEpoch: 0 });
      expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ streamEpoch: 1 }));
      transport.destroy();
    });

    it('does not signal a segment change while the epoch is unchanged', async () => {
      const onSegmentChange = jest.fn();
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onSegmentChange(onSegmentChange);
      transport.start(onResult);

      emitTokenResult({ streamEpoch: 2 });
      emitTokenResult({ streamEpoch: 2 });
      emitTokenResult({ streamEpoch: 2 });

      expect(onSegmentChange).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('exposes an unsubscribe for the segment signal', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      const onSegmentChange = jest.fn();
      const unsubscribe = transport.onSegmentChange(onSegmentChange);
      transport.start(onResult);

      unsubscribe();
      emitTokenResult({ streamEpoch: 0 });
      emitTokenResult({ streamEpoch: 1 });

      expect(onSegmentChange).not.toHaveBeenCalled();
      transport.destroy();
    });
  });

  describe('initialize', () => {
    it('passes an explicit null model path when no model url is given', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      expect(mockNative.initialize).toHaveBeenCalledTimes(1);
      expect(mockNative.initialize).toHaveBeenCalledWith(null);
      transport.destroy();
    });

    it('prefetchs the model and passes the resolved path when a model url is given', async () => {
      const transport = createNativeTransport({ modelUrl: 'https://example.com/model.onnx' });
      await transport.initialize();

      expect(mockNative.prefetchModel).toHaveBeenCalledTimes(1);
      expect(mockNative.initialize).toHaveBeenCalledWith(MODEL_PATH);
      transport.destroy();
    });

    it('rejects a model url that is not http(s) with a typed error', async () => {
      const transport = createNativeTransport({ modelUrl: 'file:///tmp/model.onnx' });

      await expectRejection(transport.initialize(), 'E_MODEL');
      expect(mockNative.initialize).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('reports E_MODEL when prefetching the model fails', async () => {
      mockNative.prefetchModel.mockImplementation(() =>
        Promise.reject(new Error('Model download failed: HTTP 404')),
      );
      const transport = createNativeTransport({ modelUrl: 'https://example.com/model.onnx' });

      const error = await expectRejection(transport.initialize(), 'E_MODEL');
      expect(error.message).toContain('HTTP 404');
      expect(mockNative.initialize).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('surfaces an initialize failure as a typed error carrying the native message', async () => {
      mockNative.initialize.mockImplementation(() =>
        Promise.resolve({ ok: false, error: 'tokens.txt asset is only 12 bytes' }),
      );
      const transport = createNativeTransport();

      const error = await expectRejection(transport.initialize(), 'E_INITIALIZE');
      expect(error.message).toContain('tokens.txt asset is only 12 bytes');
      transport.destroy();
    });

    it('surfaces a thrown bridge rejection as a typed error', async () => {
      mockNative.initialize.mockImplementation(() => Promise.reject(new Error('bridge is down')));
      const transport = createNativeTransport();

      const error = await expectRejection(transport.initialize(), 'E_NATIVE');
      expect(error.message).toContain('bridge is down');
      transport.destroy();
    });

    it('is idempotent: a second call does not initialize the engine twice', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      await transport.initialize();

      expect(mockNative.initialize).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('reports E_UNAVAILABLE when the native module is not linked', async () => {
      delete mockRn.NativeModules.ReciteQuran;
      const transport = createNativeTransport();

      await expectRejection(transport.initialize(), 'E_UNAVAILABLE');
    });

    it('subscribes to the token result event once initialization resolved', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      expect(MockNativeEventEmitter.listenerCount(EVENT_TOKEN_RESULT)).toBe(1);
      transport.destroy();
    });
  });

  describe('start', () => {
    it('waits for an in-flight initialize() before it touches the microphone', async () => {
      const init = deferred<{ ok: boolean }>();
      mockNative.initialize.mockImplementation(() => init.promise);
      const transport = createNativeTransport();

      const initializing = transport.initialize();
      transport.start(onResult);
      await flush();

      expect(mockNative.start).not.toHaveBeenCalled();

      init.resolve({ ok: true });
      await initializing;
      await flush();

      expect(mockNative.start).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('reports E_NOT_INITIALIZED and never starts when initialize was never called', async () => {
      const errors: NativeTransportErrorShape[] = [];
      const transport = createNativeTransport();
      transport.onError((error) => errors.push(error));

      transport.start(onResult);
      await flush();

      expect(mockNative.start).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('E_NOT_INITIALIZED');
      transport.destroy();
    });

    it('reports E_NOT_INITIALIZED and never starts when initialize failed', async () => {
      const errors: NativeTransportErrorShape[] = [];
      mockNative.initialize.mockImplementation(() => Promise.resolve({ ok: false, error: 'boom' }));
      const transport = createNativeTransport();
      transport.onError((error) => errors.push(error));

      await expectRejection(transport.initialize(), 'E_INITIALIZE');
      transport.start(onResult);
      await flush();

      expect(mockNative.start).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('E_NOT_INITIALIZED');
      transport.destroy();
    });

    it('requests RECORD_AUDIO before starting the microphone', async () => {
      mockNative.initialize.mockImplementation(async () => {
        track('initialize');
        return { ok: true };
      });
      mockCheck.mockImplementation(async () => {
        track('check');
        return false;
      });
      mockRequest.mockImplementation(async () => {
        track('request');
        return 'granted';
      });
      mockNative.start.mockImplementation(() => {
        track('start');
      });

      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);
      await flush();

      expect(mockRequest).toHaveBeenCalledWith('android.permission.RECORD_AUDIO');
      expect(callLog()).toEqual(['initialize', 'check', 'request', 'start']);
      transport.destroy();
    });

    it('does not re-request RECORD_AUDIO when it is already granted', async () => {
      mockCheck.mockImplementation(() => Promise.resolve(true));
      const transport = createNativeTransport();
      await transport.initialize();

      transport.start(onResult);
      await flush();

      expect(mockRequest).not.toHaveBeenCalled();
      expect(mockNative.start).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('reports E_PERMISSION and does not start when permission is denied', async () => {
      mockRequest.mockImplementation(() => Promise.resolve('denied'));
      const errors: NativeTransportErrorShape[] = [];
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onError((error) => errors.push(error));

      transport.start(onResult);
      await flush();

      expect(mockNative.start).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('E_PERMISSION');
      transport.destroy();
    });

    it('reports E_PERMISSION when the user chose never-ask-again', async () => {
      mockRequest.mockImplementation(() => Promise.resolve('never_ask_again'));
      const errors: NativeTransportErrorShape[] = [];
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onError((error) => errors.push(error));

      transport.start(onResult);
      await flush();

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('E_PERMISSION');
      transport.destroy();
    });

    it('starts without prompting on a platform that has no PermissionsAndroid', async () => {
      mockRn.Platform.OS = 'ios';
      delete mockRn.PermissionsAndroid;
      const transport = createNativeTransport();
      await transport.initialize();

      transport.start(onResult);
      await flush();

      expect(mockNative.start).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('starts when the platform has PermissionsAndroid but no request method', async () => {
      mockRn.PermissionsAndroid = { PERMISSIONS: { RECORD_AUDIO: 'perm' }, RESULTS: {} };
      const transport = createNativeTransport();
      await transport.initialize();

      transport.start(onResult);
      await flush();

      expect(mockNative.start).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('does not start the microphone twice', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      transport.start(onResult);
      await flush();
      transport.start(onResult);
      await flush();

      expect(mockNative.start).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('exposes microphone permission acquisition to the host', async () => {
      const transport = createNativeTransport();

      await transport.requestMicrophonePermission();

      expect(mockRequest).toHaveBeenCalledWith('android.permission.RECORD_AUDIO');
    });

    it('prompts only once for repeated permission requests', async () => {
      const transport = createNativeTransport();

      await transport.requestMicrophonePermission();
      await transport.requestMicrophonePermission();

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('reports E_PERMISSION when the host-facing permission request is denied', async () => {
      mockRequest.mockImplementation(() => Promise.resolve('denied'));
      const transport = createNativeTransport();

      await expectRejection(transport.requestMicrophonePermission(), 'E_PERMISSION');
    });
  });

  describe('stop', () => {
    it('awaits the native stop before resolving', async () => {
      const stopped = deferred<void>();
      mockNative.stop.mockImplementation(() => stopped.promise);
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);
      await flush();

      let resolved = false;
      const stopping = transport.stop().then(() => {
        resolved = true;
      });
      await flush();
      expect(resolved).toBe(false);

      stopped.resolve();
      await stopping;
      expect(resolved).toBe(true);
      transport.destroy();
    });

    it('surfaces a rejected native stop as a typed error', async () => {
      mockNative.stop.mockImplementation(() => Promise.reject(new Error('E_STOP')));
      const transport = createNativeTransport();
      await transport.initialize();

      await expectRejection(transport.stop(), 'E_NATIVE');
      transport.destroy();
    });

    it('is a no-op before initialize()', async () => {
      const transport = createNativeTransport();

      await transport.stop();

      expect(mockNative.stop).not.toHaveBeenCalled();
      transport.destroy();
    });
  });

  describe('resetBuffer', () => {
    it('forwards the reset to the bridge', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      transport.resetBuffer();

      expect(mockNative.resetBuffer).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('is a no-op before initialize()', async () => {
      const transport = createNativeTransport();

      transport.resetBuffer();

      expect(mockNative.resetBuffer).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('is a no-op after destroy()', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.destroy();

      transport.resetBuffer();

      expect(mockNative.resetBuffer).not.toHaveBeenCalled();
    });
  });

  describe('stream finished after a final result', () => {
    it('resets the buffer before resuming when a final result ended the stream', async () => {
      mockNative.start.mockImplementation(() => track('start'));
      mockNative.resetBuffer.mockImplementation(() => track('resetBuffer'));
      const transport = createNativeTransport();
      await transport.initialize();

      transport.start(onResult);
      await flush();
      emitTokenResult({ isFinal: true });
      await transport.stop();

      transport.start(onResult);
      await flush();

      expect(mockNative.resetBuffer).toHaveBeenCalledTimes(1);
      expect(callLog()).toEqual(['start', 'resetBuffer', 'start']);
      transport.destroy();
    });

    it('does not reset when the previous result was a live partial', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);
      await flush();

      emitTokenResult({ isFinal: false });
      await transport.stop();
      transport.start(onResult);
      await flush();

      expect(mockNative.resetBuffer).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('does not reset twice when resetBuffer() was already called', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);
      await flush();
      emitTokenResult({ isFinal: true });

      transport.resetBuffer();
      expect(mockNative.resetBuffer).toHaveBeenCalledTimes(1);

      await transport.stop();
      transport.start(onResult);
      await flush();

      expect(mockNative.resetBuffer).toHaveBeenCalledTimes(1);
      transport.destroy();
    });

    it('marks the stream finished after processWav resolves', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      await transport.processWav('/sdcard/recite.wav');
      transport.start(onResult);
      await flush();

      expect(mockNative.resetBuffer).toHaveBeenCalledTimes(1);
      transport.destroy();
    });
  });

  describe('feedAudioBase64', () => {
    it('forwards the chunk and the isFinal flag to the bridge', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      expect(transport.feedAudioBase64('AAAA', true)).toBe(true);

      expect(mockNative.feedAudioBase64).toHaveBeenCalledWith('AAAA', true);
      transport.destroy();
    });

    it('defaults isFinal to false', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      transport.feedAudioBase64('AAAA');

      expect(mockNative.feedAudioBase64).toHaveBeenCalledWith('AAAA', false);
      transport.destroy();
    });

    it('throws E_NOT_INITIALIZED instead of dropping the chunk', async () => {
      const transport = createNativeTransport();

      expect(() => transport.feedAudioBase64('AAAA')).toThrow(NativeTransportError);
      expect(() => transport.feedAudioBase64('AAAA')).toThrow(/initialize/);
      expect(mockNative.feedAudioBase64).not.toHaveBeenCalled();
      transport.destroy();
    });

    it('marks the stream finished when a final chunk was accepted', async () => {
      const transport = createNativeTransport();
      await transport.initialize();

      transport.feedAudioBase64('AAAA', true);
      transport.start(onResult);
      await flush();

      expect(mockNative.resetBuffer).toHaveBeenCalledTimes(1);
      transport.destroy();
    });
  });

  describe('error mapping', () => {
    it('reports a ReciteQuranError event as a typed error', async () => {
      const errors: NativeTransportErrorShape[] = [];
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onError((error) => errors.push(error));

      emitNativeError('recorder.start() failed: no permission');

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('E_NATIVE');
      expect(errors[0].message).toContain('recorder.start() failed: no permission');
      transport.destroy();
    });

    it('reports a rejected processWav as a typed error', async () => {
      mockNative.processWav.mockImplementation(() =>
        Promise.reject(new Error('E_WAV: /sdcard/missing.wav')),
      );
      const transport = createNativeTransport();
      await transport.initialize();

      const error = await expectRejection(transport.processWav('/sdcard/missing.wav'), 'E_NATIVE');
      expect(error.message).toContain('E_WAV');
      transport.destroy();
    });

    it('supports unsubscribing from errors', async () => {
      const errors: NativeTransportErrorShape[] = [];
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onError((error) => errors.push(error))();

      emitNativeError('boom');

      expect(errors).toHaveLength(0);
      transport.destroy();
    });

    it('does not throw out of the event handler when a subscriber itself throws', async () => {
      const errors: NativeTransportErrorShape[] = [];
      const transport = createNativeTransport();
      await transport.initialize();
      transport.onError((error) => errors.push(error));
      transport.start(() => {
        throw new Error('subscriber blew up');
      });

      expect(() => emitTokenResult()).not.toThrow();
      transport.destroy();
    });
  });

  describe('destroy', () => {
    it('detaches the token result listener', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);

      transport.destroy();

      expect(MockNativeEventEmitter.listenerCount(EVENT_TOKEN_RESULT)).toBe(0);
      emitTokenResult();
      expect(onResult).not.toHaveBeenCalled();
    });

    it('stops the microphone that is still running', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);
      await flush();

      transport.destroy();
      await flush();

      expect(mockNative.stop).toHaveBeenCalledTimes(1);
    });

    it('is safe to call twice', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.start(onResult);
      await flush();

      transport.destroy();
      transport.destroy();
      await flush();

      expect(mockNative.stop).toHaveBeenCalledTimes(1);
    });

    it('never touches the bridge when it was never initialized', () => {
      const transport: NativeAsrTransport = createNativeTransport();

      expect(() => transport.destroy()).not.toThrow();
      expect(mockNative.stop).not.toHaveBeenCalled();
      expect(mockNative.resetBuffer).not.toHaveBeenCalled();
    });

    it('leaves the transport unusable for events after destroy', async () => {
      const transport = createNativeTransport();
      await transport.initialize();
      transport.destroy();

      transport.start(onResult);
      await flush();

      expect(mockNative.start).not.toHaveBeenCalled();
    });
  });
});
