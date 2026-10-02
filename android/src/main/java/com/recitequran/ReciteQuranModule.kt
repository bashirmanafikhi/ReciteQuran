package com.recitequran

import android.content.pm.ApplicationInfo
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * React Native bridge for the sherpa-onnx + AudioRecord engine (Task 11).
 *
 * Bridge contract (consumed by Task 12's `createNativeTransport()`):
 *
 * | JS                                                                   | Kotlin                              |
 * |----------------------------------------------------------------------|-------------------------------------|
 * | `initialize(modelPath?) → {ok, error?}`                                | [initialize]                         |
 * | `prefetchModel() → Promise<string>`                                    | [prefetchModel] (+ progress event)   |
 * | `start()`                                                              | [start]                              |
 * | `stop() → Promise<void>`                                               | [stop]                               |
 * | `resetBuffer()`                                                        | [resetBuffer]                        |
 * | `feedAudioBase64(b64, isFinal) → boolean`                              | [feedAudioBase64]                    |
 * | `processWav(path) → Promise<void>`                                     | [processWav]                         |
 * | `ReciteQuranTokenResult` event                                         | [emitTokenResult]                    |
 *
 * Every recognizer interaction is funnelled through [asrThread], which replaces the Dart
 * isolate (`SherpaEngine._isolateEntry`): sherpa's native objects are single-thread bound and
 * `decode()` must never run on the JS thread.
 *
 * Two RN-specific notes:
 * * the brief's `prefetchModel(onProgress?)` cannot take a JS function, so download progress
 *   is delivered as a `ReciteQuranModelProgress` event instead;
 * * `streamEpoch` in every `ReciteQuranTokenResult` is the reset/segment signal — it is bumped
 *   by [resetBuffer], so the JS sequencer can re-base after a reset (see Task 10's ledger flag).
 */
class ReciteQuranModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "ReciteQuran"

        /** `NativeModules.ReciteQuran` */
        const val NAME = "ReciteQuran"

        /** `{ text, tokens, timestamps, isFinal, startTime, streamEpoch }` */
        const val EVENT_TOKEN_RESULT = "ReciteQuranTokenResult"

        /** `{ loaded, total, progress }` — progress is an integer percentage 0..100. */
        const val EVENT_MODEL_PROGRESS = "ReciteQuranModelProgress"

        /** `{ message }` — asynchronous failure of a `void` bridge method. */
        const val EVENT_ERROR = "ReciteQuranError"

        /** `ModelDownloader.defaultModelFileName` — bin/download_model.dart:13 */
        const val MODEL_FILE_NAME = "zipformer_p_arabic_v3.int8.onnx"

        /** `ModelDownloader.remoteModelUrl` — bin/download_model.dart:16-17 */
        const val MODEL_URL =
            "https://github.com/Iam-Muslim/Natlu/releases/download/models-latest/" +
                "zipformer_p_arabic_v3.int8.onnx"

        /** Bundled npm asset (package.json `files` → `assets/model/tokens.txt`). */
        private const val TOKENS_ASSET_PATH = "model/tokens.txt"
        private const val TOKENS_FILE_NAME = "tokens.txt"
        private const val CACHE_DIR_NAME = "recitequran"

        /** sherpa_engine_io.dart:74 — a cached file at or below 1 KB is re-extracted. */
        private const val MIN_PLAUSIBLE_BYTES = 1024L

        private const val MAX_REDIRECTS = 5
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
        private const val PROGRESS_STEP_PCT = 1
        private const val SHUTDOWN_TIMEOUT_S = 2L

        private const val ERR_MODEL = "E_MODEL"
        private const val ERR_NOT_INITIALIZED = "E_NOT_INITIALIZED"
        private const val ERR_WAV = "E_WAV"
        private const val ERR_STOP = "E_STOP"
    }

    private val asrThread: ExecutorService =
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "recitequran-asr") }

    private val cacheDir = File(reactApplicationContext.filesDir, CACHE_DIR_NAME)

    @Volatile
    private var engine: SherpaAsrEngine? = null

    private val resultListener = SherpaAsrEngine.Listener {
            text, tokens, timestamps, isFinal, startTime, streamEpoch ->
        emitTokenResult(text, tokens, timestamps, isFinal, startTime, streamEpoch)
    }

    private val recorder = AudioRecorder { chunk ->
        // Capture thread → ASR thread. startTime is stamped when the chunk is handed over,
        // exactly like `DateTime.now().millisecondsSinceEpoch` at sherpa_engine_io.dart:200.
        val startTime = System.currentTimeMillis()
        asrThread.execute {
            try {
                engine?.feed(chunk, false, startTime, resultListener)
            } catch (error: Throwable) {
                Log.e(TAG, "feed() failed", error)
                emitError(describe(error))
            }
        }
    }

    override fun getName(): String = NAME

    // ─── Bridge methods ───────────────────────────────────────────────────────────────

    /**
     * Resolves `{ok: true}` once the model, the tokens and the recognizer are ready, or
     * `{ok: false, error}` — the Dart app extracted both files before spawning the isolate
     * (sherpa_engine_io.dart:142-156). Idempotent, like `SherpaEngine.initialize()`.
     *
     * @param modelPath optional pre-existing `.onnx` on device; when omitted the model is
     *   taken from the files-dir cache or downloaded from [MODEL_URL].
     */
    @ReactMethod
    fun initialize(modelPath: String?, promise: Promise) {
        asrThread.execute {
            if (engine != null) {
                promise.resolve(okResult())
                return@execute
            }

            var created: SherpaAsrEngine? = null
            try {
                val model = resolveModelFile(modelPath)
                val tokens = extractTokens()
                created = SherpaAsrEngine(
                    model.absolutePath,
                    tokens.absolutePath,
                    isDebuggableApp(),
                    markerDir = cacheDir,
                )
                created.start()
                engine = created
                Log.i(
                    TAG,
                    "initialized (model=${model.name}, provider=${created.provider}, " +
                        "epoch=${created.streamEpoch})",
                )
                promise.resolve(okResult())
            } catch (error: Throwable) {
                runCatching { created?.release() }
                Log.e(TAG, "initialize() failed", error)
                promise.resolve(failureResult(describe(error)))
            }
        }
    }

    /**
     * Downloads the acoustic model (with `ReciteQuranModelProgress` events) and resolves its
     * absolute path. Runs even when the recognizer is already up, so the JS layer can warm the
     * cache during idle time.
     */
    @ReactMethod
    fun prefetchModel(promise: Promise) {
        asrThread.execute {
            try {
                promise.resolve(ensureModelFile().absolutePath)
            } catch (error: Throwable) {
                Log.e(TAG, "prefetchModel() failed", error)
                promise.reject(ERR_MODEL, describe(error), error)
            }
        }
    }

    /** Opens the microphone and streams into the recognizer. Requires a resolved [initialize]. */
    @ReactMethod
    fun start() {
        asrThread.execute {
            if (engine == null) {
                emitError(
                    "ReciteQuran.start() was called before initialize() resolved — " +
                        "await initialize() (or prefetchModel()) first.",
                )
                return@execute
            }
            if (recorder.isRecording) return@execute
            try {
                recorder.start()
                Log.i(TAG, "recording started")
            } catch (error: Throwable) {
                Log.e(TAG, "start() failed", error)
                emitError(describe(error))
            }
        }
    }

    /** Stops capture. The recognizer stays warm — parity with `AudioProcessor.stop()`. */
    @ReactMethod
    fun stop(promise: Promise) {
        asrThread.execute {
            try {
                recorder.stop()
                Log.i(TAG, "recording stopped")
                promise.resolve(null)
            } catch (error: Throwable) {
                Log.e(TAG, "stop() failed", error)
                promise.reject(ERR_STOP, describe(error), error)
            }
        }
    }

    /** Wipes the sherpa stream, re-primes it and bumps `streamEpoch`. */
    @ReactMethod
    fun resetBuffer() {
        asrThread.execute {
            try {
                engine?.resetBuffer()
            } catch (error: Throwable) {
                Log.e(TAG, "resetBuffer() failed", error)
                emitError(describe(error))
            }
        }
    }

    /**
     * Offline/test path: decodes `base64(little-endian float32 samples, [-1.0, 1.0])` and feeds
     * it exactly like a captured chunk. Returns whether the chunk was accepted (the recognizer
     * must be initialized); results still arrive asynchronously as `ReciteQuranTokenResult`.
     */
    @ReactMethod
    fun feedAudioBase64(audioBase64: String, isFinal: Boolean): Boolean {
        val current = engine
        if (current == null) {
            Log.w(TAG, "feedAudioBase64() ignored: initialize() has not resolved yet")
            return false
        }

        val samples = try {
            decodeFloatSamples(audioBase64)
        } catch (error: Throwable) {
            Log.e(TAG, "feedAudioBase64() got malformed base64", error)
            return false
        }

        val startTime = System.currentTimeMillis()
        try {
            // The executor is shut down by invalidate(); a late call from JS must not throw a
            // RejectedExecutionException back across the bridge, and `current` must not be
            // handed to a queue that will never run.
            asrThread.execute {
                try {
                    current.feed(samples, isFinal, startTime, resultListener)
                } catch (error: Throwable) {
                    Log.e(TAG, "feedAudioBase64() failed", error)
                    emitError(describe(error))
                }
            }
        } catch (rejected: RejectedExecutionException) {
            Log.w(TAG, "feedAudioBase64() ignored: the module is being invalidated")
            return false
        }
        return true
    }

    /**
     * Debug/verification aid: decodes a 16-bit WAV file through the recognizer in 480 ms
     * frames, emitting a `ReciteQuranTokenResult` per frame plus a final one.
     */
    @ReactMethod
    fun processWav(path: String, promise: Promise) {
        asrThread.execute {
            val current = engine
            if (current == null) {
                promise.reject(ERR_NOT_INITIALIZED, "ReciteQuran.initialize() has not resolved yet")
                return@execute
            }
            try {
                current.processWav(path, resultListener)
                promise.resolve(null)
            } catch (error: Throwable) {
                Log.e(TAG, "processWav() failed for $path", error)
                promise.reject(ERR_WAV, describe(error), error)
            }
        }
    }

    override fun invalidate() {
        var drained = false
        try {
            recorder.stop()
            asrThread.shutdown()
            try {
                if (asrThread.awaitTermination(SHUTDOWN_TIMEOUT_S, TimeUnit.SECONDS)) {
                    drained = true
                } else {
                    // A task is still inside engine.feed(), touching the native recognizer and
                    // stream. shutdownNow() only interrupts, so releasing now would free those
                    // objects underneath the running call. Leaking is the safer failure mode.
                    Log.w(
                        TAG,
                        "ASR thread did not drain within ${SHUTDOWN_TIMEOUT_S}s; " +
                            "skipping engine release (leaking native recognizer)",
                    )
                    asrThread.shutdownNow()
                }
            } catch (interrupted: InterruptedException) {
                asrThread.shutdownNow()
                Thread.currentThread().interrupt()
            }
            if (drained) {
                engine?.release()
                engine = null
            }
        } catch (error: Throwable) {
            Log.e(TAG, "invalidate() failed", error)
        }
        super.invalidate()
    }

    // ─── Model management (sherpa_engine_io.dart:63-120, bin/download_model.dart) ──────────

    private fun resolveModelFile(modelPath: String?): File {
        if (!modelPath.isNullOrBlank()) {
            val provided = File(modelPath)
            if (!provided.isFile) {
                throw IOException("initialize(modelPath): '$modelPath' does not exist")
            }
            if (provided.length() < MIN_PLAUSIBLE_BYTES) {
                throw IOException(
                    "initialize(modelPath): '$modelPath' is only ${provided.length()} bytes " +
                        "(< $MIN_PLAUSIBLE_BYTES)",
                )
            }
            return provided
        }
        return ensureModelFile()
    }

    /** Cached copy wins; otherwise download to `.tmp`, verify, then atomic rename. */
    private fun ensureModelFile(): File {
        ensureCacheDir()

        val target = File(cacheDir, MODEL_FILE_NAME)
        if (target.isFile && target.length() > MIN_PLAUSIBLE_BYTES) {
            Log.i(TAG, "model cached (${target.length()} bytes)")
            return target
        }
        if (target.exists() && !target.delete()) {
            Log.w(TAG, "could not delete truncated model ${target.absolutePath}")
        }

        val tmp = File(cacheDir, "$MODEL_FILE_NAME.tmp")
        if (tmp.exists() && !tmp.delete()) {
            throw IOException("Could not clear ${tmp.absolutePath}")
        }

        val connection = openDownload(MODEL_URL)
        try {
            // getContentLengthLong() is API 24; getContentLength() works from API 1.
            val total = connection.contentLength.toLong()
            var received = 0L
            var lastPercent = -1

            connection.inputStream.use { input ->
                FileOutputStream(tmp).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        received += read

                        if (total > 0) {
                            val percent = ((received * 100L) / total).toInt()
                            if (percent - lastPercent >= PROGRESS_STEP_PCT) {
                                lastPercent = percent
                                emitModelProgress(received, total, percent)
                            }
                        }
                    }
                    output.flush()
                    output.fd.sync()
                }
            }

            if (total > 0 && received != total) {
                tmp.delete()
                throw IOException("Partial model download: expected $total bytes, got $received")
            }
            if (received < MIN_PLAUSIBLE_BYTES) {
                tmp.delete()
                throw IOException("Downloaded model is only $received bytes")
            }
            if (!tmp.renameTo(target)) {
                throw IOException("Could not move ${tmp.absolutePath} to ${target.absolutePath}")
            }

            emitModelProgress(received, if (total > 0) total else received, 100)
            Log.i(TAG, "model downloaded ($received bytes)")
            return target
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Copies the bundled `model/tokens.txt` asset into the files dir, mirroring
     * `SherpaEngine._extractAsset` (sherpa_engine_io.dart:63-114): a suspiciously small cached
     * copy (< 1 KB) is deleted and re-extracted, and the write goes through `.tmp` + rename.
     */
    private fun extractTokens(): File {
        ensureCacheDir()

        val target = File(cacheDir, TOKENS_FILE_NAME)
        if (target.isFile && target.length() > MIN_PLAUSIBLE_BYTES) {
            return target
        }
        if (target.exists() && !target.delete()) {
            Log.w(TAG, "could not delete truncated ${target.absolutePath}")
        }

        val tmp = File(cacheDir, "$TOKENS_FILE_NAME.tmp")
        reactApplicationContext.assets.open(TOKENS_ASSET_PATH).use { input ->
            FileOutputStream(tmp).use { output ->
                input.copyTo(output)
                output.flush()
                output.fd.sync()
            }
        }

        val written = tmp.length()
        if (written < MIN_PLAUSIBLE_BYTES) {
            tmp.delete()
            throw IOException("tokens.txt asset is only $written bytes")
        }
        if (!tmp.renameTo(target)) {
            throw IOException("Could not move ${tmp.absolutePath} to ${target.absolutePath}")
        }
        return target
    }

    private fun ensureCacheDir() {
        if (!cacheDir.isDirectory && !cacheDir.mkdirs()) {
            throw IOException("Could not create ${cacheDir.absolutePath}")
        }
    }

    /** GET with an explicit redirect loop, mirroring bin/download_model.dart:55-78. */
    private fun openDownload(url: String): HttpURLConnection {
        var current = url
        var redirects = 0

        while (true) {
            val connection = URL(current).openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.instanceFollowRedirects = true
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Accept", "application/octet-stream")

            val code = connection.responseCode
            if (code == HttpURLConnection.HTTP_OK) return connection

            val redirecting = code == HttpURLConnection.HTTP_MOVED_PERM ||
                code == HttpURLConnection.HTTP_MOVED_TEMP ||
                code == HttpURLConnection.HTTP_SEE_OTHER ||
                code == 307 ||
                code == 308
            val location = connection.getHeaderField("Location")
            connection.disconnect()

            if (!redirecting) {
                throw IOException("Model download failed: HTTP $code ($current)")
            }
            if (location.isNullOrBlank() || ++redirects > MAX_REDIRECTS) {
                throw IOException("Model download gave up after $redirects redirects ($current)")
            }
            current = URL(URL(current), location).toString()
        }
    }

    // ─── Emitters ──────────────────────────────────────────────────────────────────────

    private fun emitTokenResult(
        text: String,
        tokens: Array<String>,
        timestamps: FloatArray,
        isFinal: Boolean,
        startTime: Long,
        streamEpoch: Int,
    ) {
        val payload = Arguments.createMap()
        payload.putString("text", text)
        payload.putArray("tokens", Arguments.fromList(tokens.toList()))
        payload.putArray("timestamps", Arguments.fromList(timestamps.map { it.toDouble() }))
        payload.putBoolean("isFinal", isFinal)
        payload.putDouble("startTime", startTime.toDouble())
        payload.putDouble("streamEpoch", streamEpoch.toDouble())
        emit(EVENT_TOKEN_RESULT, payload)
    }

    private fun emitModelProgress(loaded: Long, total: Long, percent: Int) {
        val payload = Arguments.createMap()
        payload.putDouble("loaded", loaded.toDouble())
        payload.putDouble("total", total.toDouble())
        payload.putDouble("progress", percent.toDouble())
        emit(EVENT_MODEL_PROGRESS, payload)
    }

    private fun emitError(message: String) {
        val payload = Arguments.createMap()
        payload.putString("message", message)
        emit(EVENT_ERROR, payload)
    }

    private fun emit(event: String, payload: WritableMap) {
        if (!reactApplicationContext.hasActiveReactInstance()) {
            Log.w(TAG, "dropping $event: no active React instance")
            return
        }
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, payload)
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────────────

    private fun decodeFloatSamples(audioBase64: String): FloatArray {
        val bytes = Base64.decode(audioBase64, Base64.DEFAULT)
        if (bytes.isEmpty()) return FloatArray(0)
        if (bytes.size % 4 != 0) {
            throw IllegalArgumentException(
                "float32 payload must be a multiple of 4 bytes, got ${bytes.size}",
            )
        }
        val floats = FloatArray(bytes.size / 4)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(floats)
        return floats
    }

    /** `kDebugMode` in the Dart source (sherpa_engine_io.dart:286). */
    private fun isDebuggableApp(): Boolean =
        (reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private fun okResult(): WritableMap =
        Arguments.createMap().apply { putBoolean("ok", true) }

    private fun failureResult(message: String): WritableMap =
        Arguments.createMap().apply {
            putBoolean("ok", false)
            putString("error", message)
        }

    private fun describe(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: error.toString()
}
