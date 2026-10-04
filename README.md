# React Native ReciteQuran

On-device Quran recitation tracking (Zipformer2-CTC + DTW + Tajweed) for React Native / Expo (Android).
This is a port of the Flutter [`recite_quran`](https://github.com/Iam-Muslim/ReciteQuran) package, keeping the same model, algorithms, and thresholds — everything runs on-device, with no audio or transcription leaving the phone.

## Requirements

- Android (iOS is not wired up yet — the native module is Kotlin/sherpa-onnx)
- A development build — the library uses native modules, so **Expo Go is not supported**:

  ```bash
  npx expo prebuild
  npx expo run:android
  ```

## Installation

```bash
npm install react-native-recite-quran
```

The native module autolinks. Add the Expo plugin to your `app.json` to automatically request the Android `RECORD_AUDIO` permission:

```json
{
  "expo": {
    "plugins": ["react-native-recite-quran"]
  }
}
```

> If your host app's `settings.gradle` uses `dependencyResolutionManagement` with `RepositoriesMode.FAIL_ON_PROJECT_REPOS`, also add `maven { url 'https://jitpack.io' }` there — the Android module pulls `com.github.k2-fsa.sherpa-onnx:sherpa-onnx:1.13.6` from JitPack.

## Model & Data Requirements

Two runtime inputs are required. Neither is bundled with the package (the ONNX model alone is ~70 MB):

1. **ASR model** — `zipformer_p_arabic_v3.int8.onnx` (~70 MB). It is downloaded automatically to the Android files directory on initialization if a `modelUrl` is provided to the transport:

   ```typescript
   const transport = createNativeTransport({
     modelUrl: 'https://github.com/Iam-Muslim/Natlu/releases/download/models-latest/zipformer_p_arabic_v3.int8.onnx',
   });
   ```

   Alternatively, distribute the model inside your app and pass a `file://` URL.

2. **Quran phoneme data** — `ordered_quran_phonemes.json` (~13 MB, from the [original Flutter package](https://github.com/Iam-Muslim/ReciteQuran)). The session loads it through a `loader` you pass to `createSession` (read it from your app bundle with `expo-asset`/`expo-file-system`):

   ```typescript
   ReciteQuran.createSession({
     surah: 1,
     isTajweed: true,
     transport,
     loader: async () => {
       // return the JSON string (or parsed object) of ordered_quran_phonemes.json
     },
   });
   ```

   If no loader is provided, a descriptive error is thrown at load time.

## Usage

Minimal example using the `createSession` facade:

```typescript
import { useEffect } from 'react';
import { ReciteQuran, createNativeTransport } from 'react-native-recite-quran';

export default function App() {
  useEffect(() => {
    let session: ReciteQuran | null = null;
    const unsubscribers: Array<() => void> = [];

    const transport = createNativeTransport({
      modelUrl: 'https://github.com/Iam-Muslim/Natlu/releases/download/models-latest/zipformer_p_arabic_v3.int8.onnx',
    });

    ReciteQuran.createSession({
      surah: 1, // Al-Fatihah
      isTajweed: true,
      transport,
    }).then((quranSession) => {
      session = quranSession;

      // 1. Subscribe to events (each returns an unsubscribe function)
      unsubscribers.push(
        quranSession.onWordMatched((event) => {
          console.log('Word matched:', event.wordId, event.cleanAsr);
        }),
        quranSession.onWordSkipped((event) => {
          console.log('Word skipped:', event.wordId);
        }),
        quranSession.onTajweed((event) => {
          console.log('Tajweed issue:', event.wordId, event.tajweedErrors);
        }),
      );

      // 2. Start listening (prompts for microphone permission on first run)
      quranSession.start();
    });

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      session?.dispose();
    };
  }, []);
}
```

## API Overview

### `ReciteQuran.createSession(options)`

| Option | Type | Description |
| --- | --- | --- |
| `surah` | `number` | Surah to track (1–114). |
| `transport` | `AsrTransport` | Pass `createNativeTransport(...)`; without it `initialize()` throws. |
| `isTajweed` | `boolean` | Tajweed verification (default `true`). |
| `config` | `TrackerConfig` | Thresholds; defaults to `normalConfig()`. |
| `loader` | `QuranDataLoader` | Supplies `ordered_quran_phonemes.json` (string or parsed object). |
| `ayahFrom` / `ayahTo` | `number` | Restrict tracking to an ayah window. |
| `startGlobalWord` | `number` | Start mid-surah at this reference word index. |
| `onDebug` | `(e) => void` | Sequencer debug lines and handled pipeline exceptions. |

### Session methods

- `start()` / `stop()` — microphone capture lifecycle.
- `dispose()` — release the recognizer and native resources.
- `setTargetSurah(surah, opts?)` — retarget without recreating the session.
- `resetBuffer()` — clear the audio buffer (e.g. after a long pause).

### Events

`onWordMatched`, `onWordSkipped`, `onTranscript`, `onTajweed` — each takes a callback and returns an unsubscribe function. Match/skip/tajweed events carry `wordId`, `score`, `cleanAsr`, `tajweedErrors`, `isRed`, `isNeutral`.

### Config presets

`easyConfig()`, `normalConfig()`, `strictConfig()` (also as `TrackerConfigPresets`), plus `copyWithConfig()` for tweaks — same presets and thresholds as the Dart package.

### Quran data

`QuranRepository` / `QuranMetadataService` parse verses lazily from the phoneme JSON (`QuranVerse` fields: Uthmani words, phonemes, per-word Tajweed rules). Build one repository per app run and pass it via `createSession({ repository })` to avoid re-parsing the 13 MB asset on every session.

## License

This package is dedicated for the sake of Allah alone. It is 100% free for end users; commercialization, paywalls, ads, or any monetization of this code, its models, or its outputs is strictly forbidden — see [LICENSE](./LICENSE) for the full terms, which pass through to forks and derivatives.

Based on the Flutter [`recite_quran`](https://github.com/Iam-Muslim/ReciteQuran) package by the same author.
