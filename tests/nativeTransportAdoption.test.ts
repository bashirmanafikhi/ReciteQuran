// tests/nativeTransportAdoption.test.ts
// Requirement (f): the native engine is process-wide and stays warm between
// sessions, while every transport instance is fresh — so the first feed of a
// new transport (start(), feedAudioBase64() or processWav()) must reset the
// shared stream before any audio is decoded. Without that, the previous
// session's decode state (trailing audio, partial hypothesis) is re-emitted as
// the new session's first results and its already-matched words light up again
// the moment a second session starts.

jest.mock(
  'react-native',
  () => {
    const listeners: Array<(payload: unknown) => void> = [];
    const nativeModule = {
      initialize: jest.fn(async () => ({ ok: true })),
      prefetchModel: jest.fn(async () => '/data/recitequran/model.onnx'),
      start: jest.fn(),
      stop: jest.fn(async () => undefined),
      resetBuffer: jest.fn(),
      feedAudioBase64: jest.fn(() => true),
      processWav: jest.fn(async () => undefined),
    };
    return {
      // Not android: skips the PermissionsAndroid hop, whose absence would only
      // add awaits to flush around.
      Platform: { OS: 'ios' },
      NativeModules: { ReciteQuran: nativeModule },
      NativeEventEmitter: class {
        addListener(_event: string, listener: (payload: unknown) => void) {
          listeners.push(listener);
          return {
            remove: () => {
              const index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
            },
          };
        }
      },
      __testHooks: { nativeModule, listeners },
    };
  },
  { virtual: true }
);

import { createNativeTransport } from '../src/nativeTransport';

const hooks = (
  require('react-native') as {
    __testHooks: {
      nativeModule: {
        initialize: jest.Mock;
        start: jest.Mock;
        stop: jest.Mock;
        resetBuffer: jest.Mock;
        feedAudioBase64: jest.Mock;
        processWav: jest.Mock;
      };
      listeners: Array<(payload: unknown) => void>;
    };
  }
).__testHooks;

/** Drains the microtask chain a void `start()` leaves behind. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const feedFloat32 = (samples: number[]): string =>
  Buffer.from(new Float32Array(samples).buffer).toString('base64');

/** The first registered listener is the token-result one (attach order). */
const emitTokenResult = (payload: Record<string, unknown>): void => {
  hooks.listeners[0]({
    text: '',
    tokens: [],
    timestamps: [],
    isFinal: false,
    startTime: 0,
    streamEpoch: 0,
    ...payload,
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  hooks.listeners.length = 0;
});

describe('a fresh transport adopting the shared native stream', () => {
  it('resets the buffer before its first start opens the microphone', async () => {
    const transport = createNativeTransport();
    await transport.initialize();

    transport.start(() => {});
    await flush();

    expect(hooks.nativeModule.start).toHaveBeenCalledTimes(1);
    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(1);
    expect(hooks.nativeModule.resetBuffer.mock.invocationCallOrder[0]).toBeLessThan(
      hooks.nativeModule.start.mock.invocationCallOrder[0]
    );
  });

  it('does not reset again on a resume within the same transport', async () => {
    const transport = createNativeTransport();
    await transport.initialize();

    transport.start(() => {});
    await flush();
    await transport.stop();
    transport.start(() => {});
    await flush();

    // One reset for the adoption; the stream was never finished, so the warm
    // continuation keeps it (session.ts keeps the session reusable on stop()).
    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(1);
    expect(hooks.nativeModule.start).toHaveBeenCalledTimes(2);
  });

  it('resets the stream eagerly when a final result arrives, not only on the next start', async () => {
    const transport = createNativeTransport();
    await transport.initialize();

    transport.start(() => {});
    await flush();
    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(1); // adoption

    emitTokenResult({ isFinal: true, streamEpoch: 7 });

    // The microphone keeps feeding the engine natively, so a finished stream
    // is re-based the moment the final lands — the next 480 ms chunk must not
    // decode into the dead stream while waiting for a JS-initiated resume.
    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(2);

    await transport.stop();
    transport.start(() => {});
    await flush();

    // The stream was already fresh; the resume must not add another reset.
    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(2);
    expect(hooks.nativeModule.start).toHaveBeenCalledTimes(2);
  });

  it('stamps lastResultAt on every native result, partials included', async () => {
    const transport = createNativeTransport();
    await transport.initialize();
    expect(transport.lastResultAt).toBeNull();

    transport.start(() => {});
    await flush();
    emitTokenResult({ text: 'abc', streamEpoch: 3 });

    expect(transport.lastResultAt).not.toBeNull();
  });

  it('resets before the first feedAudioBase64 chunk, once', async () => {
    const transport = createNativeTransport();
    await transport.initialize();

    expect(transport.feedAudioBase64(feedFloat32([0.1, 0.2]))).toBe(true);
    expect(transport.feedAudioBase64(feedFloat32([0.3]))).toBe(true);

    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(1);
    expect(hooks.nativeModule.resetBuffer.mock.invocationCallOrder[0]).toBeLessThan(
      hooks.nativeModule.feedAudioBase64.mock.invocationCallOrder[0]
    );
  });

  it('resets before processWav decodes', async () => {
    const transport = createNativeTransport();
    await transport.initialize();

    await transport.processWav('/tmp/empty.wav');

    expect(hooks.nativeModule.processWav).toHaveBeenCalledTimes(1);
    expect(hooks.nativeModule.resetBuffer).toHaveBeenCalledTimes(1);
    expect(hooks.nativeModule.resetBuffer.mock.invocationCallOrder[0]).toBeLessThan(
      hooks.nativeModule.processWav.mock.invocationCallOrder[0]
    );
  });
});
