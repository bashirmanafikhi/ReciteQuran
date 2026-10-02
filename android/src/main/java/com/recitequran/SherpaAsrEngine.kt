package com.recitequran

import android.util.Log
import java.io.File
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import com.k2fsa.sherpa.onnx.WaveReader

/**
 * sherpa-onnx online Zipformer2-CTC recognizer.
 *
 * Kotlin transliteration of the Dart isolate worker in
 * `lib/engine/sherpa_engine_io.dart` (`SherpaEngine._isolateEntry`, lines 250-469):
 *
 * | Dart (sherpa_engine_io.dart) | Kotlin (this file)          |
 * |-----------------------------|-----------------------------|
 * | `tryCreateRecognizer()`     | [newRecognizer]             |
 * | `accelName = 'xnnpack'`     | [PROVIDER_XNNPACK]          |
 * | xnnpack marker files        | [start] — [MARKER_ATTEMPTED]/[MARKER_VERIFIED] |
 * | `createStream()`            | [start]                     |
 * | `Float32List(7680)` priming | [prime]                     |
 * | `acceptWaveform/decode`     | [feed] / [resetBuffer]      |
 * | `isolateStreamEpoch++`      | [streamEpoch]               |
 * | `free()`                    | [release]                   |
 *
 * Native API verified with `javap` against the pinned artifact
 * `com.github.k2-fsa.sherpa-onnx:sherpa-onnx:1.13.6`
 * (== release asset `sherpa-onnx-1.13.6.aar`, sha256 0012d9a2…4be1698):
 * `OnlineRecognizer(assetManager = null, config)` — the trailing required parameter is
 * addressed by name, `createStream(hotwords = "")`, `reset/decode/isEndpoint/isReady/getResult`,
 * `OnlineStream.acceptWaveform(samples, sampleRate)` — *samples first*,
 * `OnlineRecognizerResult.text/.tokens/.timestamps`, `WaveReader.readWave(path)`.
 *
 * THREADING: not thread-safe. Every method must be called from the same single thread
 * (ReciteQuranModule owns that thread); this replaces the Dart isolate.
 */
class SherpaAsrEngine(
    private val modelPath: String,
    private val tokensPath: String,
    private val debug: Boolean = false,
    /** Directory for the xnnpack crash-loop markers; see [start]. */
    private val markerDir: File? = null,
) {

    /** Result sink; mirrors `SherpaTranscriptionEvent`. */
    fun interface Listener {
        fun onResult(
            text: String,
            tokens: Array<String>,
            timestamps: FloatArray,
            isFinal: Boolean,
            startTime: Long,
            streamEpoch: Int,
        )
    }

    companion object {
        private const val TAG = "SherpaAsrEngine"

        /** `FeatureConfig(sampleRate: 16000)` — sherpa_engine_io.dart:277 */
        const val SAMPLE_RATE = 16000

        /** `FeatureConfig(featureDim: 80)` — sherpa_engine_io.dart:277 */
        const val FEATURE_DIM = 80

        /** `numThreads: 2` — sherpa_engine_io.dart:283 */
        const val NUM_THREADS = 2

        /** `modelType: 'zipformer2_ctc'` — sherpa_engine_io.dart:284 */
        const val MODEL_TYPE = "zipformer2_ctc"

        /** `accelName = 'xnnpack'` for Android — sherpa_engine_io.dart:303-305 */
        const val PROVIDER_XNNPACK = "xnnpack"

        /** Graceful fallback when the accelerator cannot be initialised — :318, :355 */
        const val PROVIDER_CPU = "cpu"

        /**
         * 7680 zero floats of priming = 480 ms = exactly one ONNX chunk stride
         * (48 encoder frames), sherpa_engine_io.dart:258-261, :362-366, :456-459.
         */
        const val PRIME_SAMPLES = 7680

        /** Feed/wav framing unit; identical to `AudioRecorder.CHUNK_SAMPLES`. */
        const val CHUNK_SAMPLES = 7680

        /**
         * Written BEFORE the first xnnpack attempt and never cleared — the Android equivalent of
         * Dart's `xnnpack_lock` / `xnnpack_disabled` pair. See [start].
         */
        private const val MARKER_ATTEMPTED = "_attempted"

        /** Written after xnnpack survived priming; equivalent to Dart's `xnnpack_verified`. */
        private const val MARKER_VERIFIED = "_ok"
    }

    private var recognizer: OnlineRecognizer? = null
    private var stream: OnlineStream? = null

    /** Bumped on every [resetBuffer]; mirrors `isolateStreamEpoch`. */
    var streamEpoch: Int = 0
        private set

    /** Provider actually in use (`xnnpack` or `cpu`). */
    var provider: String = PROVIDER_CPU
        private set

    val isStarted: Boolean
        get() = recognizer != null

    /**
     * Creates the recognizer (xnnpack, falling back to cpu), creates the stream and primes it
     * with 480 ms of silence — sherpa_engine_io.dart:344-366.
     *
     * XNNPACK CRASH-LOOP GUARD (sherpa_engine_io.dart:309-342, :368-374). A SIGILL/SIGSEGV inside
     * `decode()` is a native abort that Kotlin cannot catch, so it must be prevented by markers
     * rather than by `try/catch`:
     *
     * | Dart                                    | Kotlin                                   |
     * |-----------------------------------------|------------------------------------------|
     * | `xnnpack_disabled` → cpu forever        | `xnnpack_attempted` && !`xnnpack_ok`     |
     * | `xnnpack_verified` → accel unconditionally | `xnnpack_ok` → accel unconditionally  |
     * | `xnnpack_lock` written pre-attempt      | `xnnpack_attempted` written pre-attempt  |
     *
     * The attempt marker is written BEFORE the risky call, so a process that dies natively still
     * leaves it behind and every later launch takes the CPU path instead of crash-looping. When
     * [markerDir] is null (no writable directory) the guard is inert and the previous
     * try/catch-only behaviour applies.
     */
    fun start() {
        if (recognizer != null) return

        val attempted = markerFile(MARKER_ATTEMPTED)
        val verified = markerFile(MARKER_VERIFIED)

        var selected = PROVIDER_XNNPACK
        if (attempted != null && attempted.isFile && (verified == null || !verified.isFile)) {
            // A previous process started xnnpack but never recorded success, which can only
            // happen if the process died natively inside decode().
            Log.w(
                TAG,
                "xnnpack was attempted before but never verified (native crash); " +
                    "using $PROVIDER_CPU for this and every later launch",
            )
            selected = PROVIDER_CPU
        }

        var created: OnlineRecognizer? = null
        if (selected == PROVIDER_XNNPACK) {
            writeMarker(attempted)
            try {
                created = newRecognizer(PROVIDER_XNNPACK)
            } catch (error: Throwable) {
                // Graceful Kotlin/C++ exception during model loading (not a native abort). The
                // attempt marker is deliberately left in place, so later launches stay on cpu.
                Log.w(
                    TAG,
                    "provider=$PROVIDER_XNNPACK failed (${error.message}); " +
                        "falling back to $PROVIDER_CPU",
                    error,
                )
                selected = PROVIDER_CPU
            }
        }
        if (created == null) {
            // Not wrapped in try/catch on purpose: a cpu failure is fatal and must propagate to
            // the caller, exactly like `rethrow` at sherpa_engine_io.dart:358.
            created = newRecognizer(selected)
        }

        provider = selected
        recognizer = created
        stream = created.createStream()
        prime()
        // Priming decode() returned, so xnnpack is safe on this device. Only mark it verified when
        // the accelerated provider actually ran (Dart: `provider == accelName`).
        if (provider == PROVIDER_XNNPACK) writeMarker(verified)
        Log.i(TAG, "recognizer ready (provider=$provider, epoch=$streamEpoch)")
    }

    private fun markerFile(suffix: String): File? =
        markerDir?.let { File(it, PROVIDER_XNNPACK + suffix) }

    private fun writeMarker(file: File?) {
        if (file == null) return
        try {
            file.parentFile?.mkdirs()
            if (!file.exists()) file.createNewFile()
        } catch (error: Throwable) {
            Log.w(TAG, "could not write marker ${file.name}", error)
        }
    }

    /**
     * One streaming step — sherpa_engine_io.dart:388-447.
     *
     * Emits the partial result unless an endpoint was detected or [isFinal] was requested,
     * then (for `isFinal || endpointDetected`) drains and emits the final result.
     *
     * PARITY NOTE — the stream is then permanently finished. Passing `isFinal = true` calls
     * [OnlineStream.inputFinished], which drains the endpointing state machine; every later
     * [feed] on that stream is meaningless. An endpoint detected by rule1/rule2/rule3 ends the
     * utterance the same way. Call [resetBuffer] to obtain a fresh stream before resuming
     * recognition — the Dart app behaves identically (`SherpaEngine.resetBuffer` is the only way
     * to restart recognition after a final or endpointed result).
     */
    fun feed(samples: FloatArray, isFinal: Boolean, startTime: Long, listener: Listener) {
        val recognizer = this.recognizer ?: return
        val stream = this.stream ?: return

        if (samples.isNotEmpty()) {
            stream.acceptWaveform(samples, SAMPLE_RATE)
        }

        while (recognizer.isReady(stream)) {
            recognizer.decode(stream)
        }

        val partial = recognizer.getResult(stream)
        val endpointDetected = recognizer.isEndpoint(stream)

        if (!endpointDetected && !isFinal) {
            listener.onResult(
                partial.text,
                partial.tokens,
                partial.timestamps,
                false,
                startTime,
                streamEpoch,
            )
        }

        if (isFinal || endpointDetected) {
            if (isFinal) {
                stream.inputFinished()
            }
            while (recognizer.isReady(stream)) {
                recognizer.decode(stream)
            }
            val finalResult = recognizer.getResult(stream)
            listener.onResult(
                finalResult.text,
                finalResult.tokens,
                finalResult.timestamps,
                true,
                startTime,
                streamEpoch,
            )
        }
    }

    /**
     * Debug/verification path: decodes a WAV file in 480 ms frames and emits results for
     * every frame, the last one as final. [WaveReader.readWave] normalises 16-bit PCM to
     * [-1.0, 1.0] floats, matching `wav.astype(np.float32) / 32768.0` in the training pipeline.
     *
     * PARITY NOTE — always consumes the stream to a final result, so the stream is permanently
     * finished afterwards. Call [resetBuffer] before feeding further microphone audio.
     */
    fun processWav(path: String, listener: Listener) {
        val wave = WaveReader.readWave(path)
        if (wave.sampleRate != SAMPLE_RATE) {
            Log.w(TAG, "WAV is ${wave.sampleRate} Hz, model expects $SAMPLE_RATE Hz")
        }

        val samples = wave.samples
        var offset = 0
        while (offset < samples.size) {
            val end = minOf(offset + CHUNK_SAMPLES, samples.size)
            val frame = samples.copyOfRange(offset, end)
            val isLast = end >= samples.size
            feed(frame, isLast, System.currentTimeMillis(), listener)
            offset = end
        }

        // Guarantee a final event even for an empty/short file.
        if (samples.isEmpty()) {
            feed(FloatArray(0), true, System.currentTimeMillis(), listener)
        }
    }

    /**
     * Hard reset: `recognizer.reset(stream)` + re-prime, and bumps [streamEpoch] so the
     * JS side can re-base the sequencer — sherpa_engine_io.dart:217-223 & :452-460.
     */
    fun resetBuffer() {
        streamEpoch += 1
        val recognizer = this.recognizer ?: return
        val stream = this.stream ?: return
        recognizer.reset(stream)
        prime()
        Log.i(TAG, "buffer reset (epoch=$streamEpoch)")
    }

    /** `stream.free()` then `recognizer.free()` — sherpa_engine_io.dart:462-467. */
    fun release() {
        stream?.release()
        stream = null
        recognizer?.release()
        recognizer = null
    }

    private fun prime() {
        val recognizer = this.recognizer ?: return
        val stream = this.stream ?: return
        stream.acceptWaveform(FloatArray(PRIME_SAMPLES), SAMPLE_RATE)
        while (recognizer.isReady(stream)) {
            recognizer.decode(stream)
        }
    }

    /**
     * `tryCreateRecognizer(provider)` — sherpa_engine_io.dart:274-296, verbatim config.
     * Defaults that the Dart binding fills in identically (decodingMethod=greedy_search,
     * maxActivePaths=4, hotwordsScore=1.5, blankPenalty=0.0) come from the upstream
     * sherpa-onnx 1.13.6 Kotlin data classes.
     */
    private fun newRecognizer(providerName: String): OnlineRecognizer =
        OnlineRecognizer(
            config = OnlineRecognizerConfig(
                featConfig = FeatureConfig(
                    sampleRate = SAMPLE_RATE,
                    featureDim = FEATURE_DIM,
                ),
                modelConfig = OnlineModelConfig(
                    zipformer2Ctc = OnlineZipformer2CtcModelConfig(model = modelPath),
                    tokens = tokensPath,
                    numThreads = NUM_THREADS,
                    debug = debug,
                    provider = providerName,
                    modelType = MODEL_TYPE,
                ),
                // Endpoint rules, ported from sherpa_engine_io.dart:288-291. The Kotlin binding's parameter
// names come from upstream sherpa-onnx and differ from the Dart field names, so each one is
// named below to make the cross-language mapping explicit and reorder-proof.
//
// | Dart `rule1`/`rule2`/`rule3`        | EndpointRule                      |
// |-------------------------------------|-----------------------------------|
// | mustContainNonsilence               | mustContainNonSilence             |
// | mustContainNonsilenceDuration: 10/4 | minTrailingSilence                |
// | mustContainSilenceDuration: 0 / 9999| minUtteranceLength                |
endpointConfig = EndpointConfig(
                    rule1 = EndpointRule(
                        mustContainNonSilence = false,
                        minTrailingSilence = 10.0f,
                        minUtteranceLength = 0.0f,
                    ),
                    rule2 = EndpointRule(
                        mustContainNonSilence = true,
                        minTrailingSilence = 4.0f,
                        minUtteranceLength = 0.0f,
                    ),
                    rule3 = EndpointRule(
                        mustContainNonSilence = false,
                        minTrailingSilence = 0.0f,
                        minUtteranceLength = 9999.0f,
                    ),
                ),
                enableEndpoint = true,
            ),
        )
}
