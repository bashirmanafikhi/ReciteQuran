import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sherpa_onnx from 'sherpa-onnx';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ReciteQuran } = require('../../dist/index.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHUNK_SAMPLES = 7680; // 480 ms
const PRIME_SAMPLES = 7680;
const SAMPLE_RATE = 16000;

class FileAsrTransport {
  constructor() {
    this._onResult = null;
  }

  async initialize() {}

  start(onResult) {
    this._onResult = onResult;
  }

  async stop() {}

  resetBuffer() {}

  destroy() {}

  emitResult(result) {
    if (this._onResult) {
      this._onResult(result);
    }
  }
}

export async function runHarness(wavPath, options = {}) {
  const surah = options.surah ?? 1;
  const ayahFrom = options.ayahFrom;
  const ayahTo = options.ayahTo;
  const isTajweed = options.isTajweed ?? true;

  const modelPath = path.resolve(__dirname, '../../assets/model/zipformer_p_arabic_v3.int8.onnx');
  const tokensPath = path.resolve(__dirname, '../../assets/model/tokens.txt');
  const quranDataPath = path.resolve(__dirname, '../../assets/model/ordered_quran_phonemes.json');

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model not found at ${modelPath}. Run verification/download-model.mjs first.`);
  }
  if (!fs.existsSync(tokensPath)) {
    throw new Error(`Tokens not found at ${tokensPath}`);
  }
  if (!fs.existsSync(wavPath)) {
    throw new Error(`WAV file not found at ${wavPath}`);
  }

  const wave = sherpa_onnx.readWave(wavPath);
  if (wave.sampleRate !== SAMPLE_RATE) {
    console.warn(`Warning: WAV is ${wave.sampleRate} Hz, expected ${SAMPLE_RATE} Hz`);
  }

  // 1. Configure sherpa-onnx recognizer
  const config = {
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: 80,
    },
    modelConfig: {
      zipformer2Ctc: { model: modelPath },
      tokens: tokensPath,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
      modelType: 'zipformer2_ctc',
    },
    endpointConfig: {
      rule1: {
        mustContainNonSilence: false,
        minTrailingSilence: 10.0,
        minUtteranceLength: 0.0,
      },
      rule2: {
        mustContainNonSilence: true,
        minTrailingSilence: 4.0,
        minUtteranceLength: 0.0,
      },
      rule3: {
        mustContainNonSilence: false,
        minTrailingSilence: 0.0,
        minUtteranceLength: 9999.0,
      },
    },
    enableEndpoint: 1,
  };

  const recognizer = sherpa_onnx.createOnlineRecognizer(config);
  const stream = recognizer.createStream();

  // 2. Prime with 7,680 zero floats
  const primeBuffer = new Float32Array(PRIME_SAMPLES);
  stream.acceptWaveform(SAMPLE_RATE, primeBuffer);
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }

  // 3. Set up TS ReciteQuran session
  const transport = new FileAsrTransport();
  const capturedEvents = [];
  const capturedTokens = [];

  const session = await ReciteQuran.createSession({
    surah,
    ayahFrom,
    ayahTo,
    isTajweed,
    transport,
    loader: () => JSON.parse(fs.readFileSync(quranDataPath, 'utf8')),
  });

  session.onWordMatched((e) => {
    capturedEvents.push({
      t: 'highlight',
      wordId: e.wordId,
      score: e.score,
      cleanAsr: e.cleanAsr,
      isRed: Boolean(e.isRed),
      isNeutral: Boolean(e.isNeutral),
      tajweedErrors: e.tajweedErrors ?? null,
    });
  });

  session.onWordSkipped((e) => {
    capturedEvents.push({
      t: 'highlight',
      wordId: e.wordId,
      score: e.score,
      cleanAsr: e.cleanAsr,
      isRed: true,
      isNeutral: Boolean(e.isNeutral),
      tajweedErrors: e.tajweedErrors ?? null,
    });
  });

  await session.start();

  // 4. Feed audio in 480 ms frames
  const samples = wave.samples;
  let offset = 0;
  let streamEpoch = 0;

  function handleResult(res, isFinal) {
    const payload = {
      text: res.text || '',
      tokens: res.tokens || [],
      timestamps: res.timestamps || [],
      isFinal,
      startTime: 0,
      streamEpoch,
    };
    capturedTokens.push(payload);
    transport.emitResult(payload);
  }

  while (offset < samples.length) {
    const end = Math.min(offset + CHUNK_SAMPLES, samples.length);
    const frame = samples.subarray(offset, end);
    const isLast = end >= samples.length;

    stream.acceptWaveform(SAMPLE_RATE, frame);
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }

    const partial = recognizer.getResult(stream);
    const endpointDetected = recognizer.isEndpoint(stream);

    if (!endpointDetected && !isLast) {
      handleResult(partial, false);
    }

    if (isLast || endpointDetected) {
      if (isLast) {
        stream.inputFinished();
      }
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const finalResult = recognizer.getResult(stream);
      handleResult(finalResult, true);
    }

    offset = end;
  }

  if (samples.length === 0) {
    handleResult({ text: '', tokens: [], timestamps: [] }, true);
  }

  session.dispose();
  stream.free();
  recognizer.free();

  // 5. Write output JSON
  const outDir = path.resolve(__dirname, '../out');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const eventsOutPath = path.join(outDir, 'rn-events.json');
  const tokensOutPath = path.join(outDir, 'rn-tokens.json');

  fs.writeFileSync(eventsOutPath, JSON.stringify(capturedEvents, null, 2), 'utf8');
  fs.writeFileSync(tokensOutPath, JSON.stringify(capturedTokens, null, 2), 'utf8');

  console.log(`RN Harness complete.`);
  console.log(`- Events saved: ${eventsOutPath} (${capturedEvents.length} events)`);
  console.log(`- Tokens saved: ${tokensOutPath} (${capturedTokens.length} token frames)`);

  return { events: capturedEvents, tokens: capturedTokens };
}

async function main() {
  const wavArg = process.argv[2];
  const surahArg = process.argv[3] ? parseInt(process.argv[3], 10) : 1;

  if (!wavArg) {
    console.log('Usage: node run.mjs <path-to-wav> [surah-number]');
    process.exit(1);
  }

  try {
    await runHarness(path.resolve(process.cwd(), wavArg), { surah: surahArg });
  } catch (e) {
    console.error('Harness execution failed:', e);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
