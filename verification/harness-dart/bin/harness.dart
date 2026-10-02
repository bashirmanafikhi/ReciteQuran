// verification/harness-dart/bin/harness.dart
//
// Dart Reference Verification Harness
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors harness-rn/run.mjs exactly:
//   • Creates OnlineRecognizer with same config (sampleRate=16000, featureDim=80)
//   • Primes with 7,680 zero samples
//   • Feeds the WAV in 7,680-sample chunks
//   • Collects partial and final transcription results (tokens + timestamps)
//   • Writes dart-events.json and dart-tokens.json to verification/out/
//
// Usage:
//   dart run bin/harness.dart [wav_path] [surah_number]
//
// Defaults:
//   wav_path  = ../../verification/fixtures/test_silence.wav   (repo root relative)
//   surah     = 1

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:sherpa_onnx/sherpa_onnx.dart';

// ─── Paths (relative to the script's working directory = verification/harness-dart)
const String _defaultWavPath = '../../verification/fixtures/test_silence.wav';
const String _modelPath =
    '../../assets/model/zipformer_p_arabic_v3.int8.onnx';
const String _tokensPath = '../../assets/model/tokens.txt';

// Must match Node harness
const int _chunkSize = 7680; // 480 ms @ 16 kHz
const int _primeSamples = 7680;

// ─── WAV reader ───────────────────────────────────────────────────────────────
Float32List _readWavSamples(String wavPath) {
  final file = File(wavPath);
  if (!file.existsSync()) {
    throw Exception('WAV file not found at: $wavPath');
  }

  final bytes = file.readAsBytesSync();
  if (bytes.length < 44) {
    throw Exception('Invalid WAV file: size < 44 bytes');
  }

  final bd = bytes.buffer.asByteData();
  final sampleRate = bd.getUint32(24, Endian.little);
  if (sampleRate != 16000) {
    stderr.writeln(
        'Warning: WAV sample rate is $sampleRate, expected 16000');
  }

  // Find 'data' sub-chunk
  int dataOffset = 44;
  for (int i = 12; i < bytes.length - 8; i++) {
    if (bytes[i] == 0x64 &&
        bytes[i + 1] == 0x61 &&
        bytes[i + 2] == 0x74 &&
        bytes[i + 3] == 0x61) {
      dataOffset = i + 8;
      break;
    }
  }

  final int16Data = Int16List.view(
    bytes.buffer,
    bytes.offsetInBytes + dataOffset,
    (bytes.length - dataOffset) ~/ 2,
  );

  final floatSamples = Float32List(int16Data.length);
  for (int i = 0; i < int16Data.length; i++) {
    floatSamples[i] = int16Data[i] / 32768.0;
  }
  return floatSamples;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
void main(List<String> args) {
  final wavPath =
      args.isNotEmpty ? args[0] : _defaultWavPath;
  // surah arg unused in this low-level harness (no DictationSequencer),
  // but kept for parity with the env-var interface the flutter test used.

  print('====================================================');
  print(' Dart Reference Verification Harness');
  print(' WAV:    $wavPath');
  print(' Model:  $_modelPath');
  print(' Tokens: $_tokensPath');
  print('====================================================');

  // Validate model files
  if (!File(_modelPath).existsSync()) {
    stderr.writeln('ERROR: ONNX model not found at $_modelPath');
    stderr.writeln('Run: node ../../verification/download-model.mjs');
    exit(1);
  }
  if (!File(_tokensPath).existsSync()) {
    stderr.writeln('ERROR: tokens.txt not found at $_tokensPath');
    exit(1);
  }

  // Build recognizer config — identical to Node harness and SherpaEngine
  final config = OnlineRecognizerConfig(
    feat: FeatureConfig(sampleRate: 16000, featureDim: 80),
    model: OnlineModelConfig(
      zipformer2Ctc: OnlineZipformer2CtcModelConfig(model: _modelPath),
      tokens: _tokensPath,
      numThreads: 2,
      modelType: 'zipformer2_ctc',
      provider: 'cpu',
      debug: false,
    ),
    enableEndpoint: true,
    rule1MinTrailingSilence: 10.0,
    rule2MinTrailingSilence: 4.0,
    rule3MinUtteranceLength: 9999.0,
  );

  final recognizer = OnlineRecognizer(config);
  final stream = recognizer.createStream();

  // Prime with silence (mirrors Node harness PRIME_SAMPLES)
  final primingBuffer = Float32List(_primeSamples);
  stream.acceptWaveform(sampleRate: 16000, samples: primingBuffer);
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }
  print('Priming done.');

  // Read WAV samples
  final samples = _readWavSamples(wavPath);
  print('WAV: ${samples.length} samples (${(samples.length / 16000).toStringAsFixed(3)}s)');

  // ─── Token/event capture ───────────────────────────────────────────────────
  // We capture at the same granularity as the Node harness:
  //   capturedTokens: one entry per chunk that produces a non-empty result
  //   capturedEvents: word-level events (empty for silence-only test)
  final List<Map<String, dynamic>> capturedTokens = [];
  final List<Map<String, dynamic>> capturedEvents = [];

  int chunkIndex = 0;
  int offset = 0;
  String lastText = '';

  while (offset < samples.length || chunkIndex == 0 && samples.isEmpty) {
    final int end = offset + _chunkSize < samples.length
        ? offset + _chunkSize
        : samples.length;
    final bool isLast = end >= samples.length;
    final chunk = samples.sublist(offset, end);

    stream.acceptWaveform(sampleRate: 16000, samples: chunk);
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }

    final partial = recognizer.getResult(stream);
    final bool endpointDetected = recognizer.isEndpoint(stream);

    // Emit partial if tokens present
    if (partial.tokens.isNotEmpty || partial.text.isNotEmpty) {
      if (partial.text != lastText || partial.tokens.isNotEmpty) {
        capturedTokens.add({
          'text': partial.text,
          'tokens': partial.tokens,
          'timestamps': partial.timestamps,
          'isFinal': false,
          'startTime': 0,
          'streamEpoch': 0,
        });
        lastText = partial.text;
      }
    }

    // Emit final on endpoint or last chunk
    if (endpointDetected || isLast) {
      if (isLast) {
        stream.inputFinished();
      }
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      final finalResult = recognizer.getResult(stream);

      capturedTokens.add({
        'text': finalResult.text,
        'tokens': finalResult.tokens,
        'timestamps': finalResult.timestamps,
        'isFinal': true,
        'startTime': 0,
        'streamEpoch': 0,
      });
      lastText = '';

      if (endpointDetected && !isLast) {
        recognizer.reset(stream);
      }
    }

    chunkIndex++;
    if (samples.isEmpty) break;
    offset = end;
    if (offset >= samples.length) break;
  }

  stream.free();
  recognizer.free();

  // ─── Write output ──────────────────────────────────────────────────────────
  final outDir = Directory('../../verification/out');
  if (!outDir.existsSync()) {
    outDir.createSync(recursive: true);
  }

  const encoder = JsonEncoder.withIndent('  ');
  File('../../verification/out/dart-events.json')
      .writeAsStringSync(encoder.convert(capturedEvents));
  File('../../verification/out/dart-tokens.json')
      .writeAsStringSync(encoder.convert(capturedTokens));

  print('');
  print('Dart Harness Complete.');
  print('- Events: ${capturedEvents.length}');
  print('- Token frames: ${capturedTokens.length}');
  print('- Output: verification/out/dart-events.json, dart-tokens.json');
}
