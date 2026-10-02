# React Native ReciteQuran

On-device Quran recitation tracking (Zipformer2-CTC + DTW + Tajweed) for React Native / Expo (Android).
This is a port of the Flutter `ReciteQuran` package, keeping the same model, algorithms, and thresholds.

## Installation

```bash
npm install react-native-recite-quran
```

Add the plugin to your `app.json` to automatically request the required Android `RECORD_AUDIO` permissions:

```json
{
  "expo": {
    "plugins": [
      "react-native-recite-quran"
    ]
  }
}
```

Since this library uses native modules (sherpa-onnx for Android), it cannot be used with Expo Go. You must create a development build:
```bash
npx expo prebuild
npx expo run:android
```

## Model Requirements

The library requires the `zipformer_p_arabic_v3.int8.onnx` model file to work. It will automatically download the model to the Android files directory upon initialization if a `modelUrl` is provided.

Alternatively, the model can be hosted locally or distributed within the app, and the URL passed during transport creation.

## Usage

Here is a minimal example using the provided `createSession` facade:

```typescript
import { useEffect, useState } from 'react';
import { ReciteQuran, createNativeTransport } from 'react-native-recite-quran';

export default function App() {
  const [session, setSession] = useState<ReciteQuran | null>(null);

  useEffect(() => {
    // 1. Create the native transport and initialize the session
    const transport = createNativeTransport({
      modelUrl: 'https://github.com/Iam-Muslim/Natlu/releases/download/models-latest/zipformer_p_arabic_v3.int8.onnx'
    });

    ReciteQuran.createSession({
      surah: 1, // Al-Fatihah
      isTajweed: true,
      transport,
    }).then(quranSession => {
      setSession(quranSession);

      // 2. Subscribe to events
      quranSession.onWordMatched(event => {
        console.log('Word matched:', event.wordId, event.cleanAsr);
      });

      quranSession.onWordSkipped(event => {
        console.log('Word skipped:', event.wordId);
      });

      quranSession.onTajweed(event => {
        console.log('Tajweed issue:', event.wordId, event.tajweedErrors);
      });

      // 3. Start listening (this prompts for microphone permission on first run)
      quranSession.start();
    });

    return () => {
      // Cleanup
      session?.dispose();
    };
  }, []);

  return null;
}
```

For more advanced usages like seeking, configuration changes, or resetting the buffer, refer to the `ReciteQuran` instance methods.
