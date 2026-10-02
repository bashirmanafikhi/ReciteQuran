package com.recitequran

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import kotlin.math.min

/**
 * 16 kHz mono PCM16 microphone capture.
 *
 * Kotlin transliteration of `lib/audio/audio_processor_io.dart` (`AudioProcessor.start`):
 *
 * * `RecordConfig(encoder: pcm16bits, sampleRate: 16000, numChannels: 1,
 *   autoGain: false, echoCancel: false, noiseSuppress: false)` — audio_processor_io.dart:36-43
 * * Raw bytes are re-framed into exact 480 ms blocks (`chunkMs = 480`, 15 360 bytes =
 *   7 680 samples) before being handed on — audio_processor_io.dart:15-17, :73-91
 * * `int16 / 32768.0` float conversion — audio_processor_io.dart:85-89
 *
 * `AudioRecord` itself mirrors `record_android` 2.1.2's `PCMReader` (the plugin the Dart app
 * used): buffer size = `getMinBufferSize(...) * 2`, and AGC / AEC / NS effects are created
 * when available and then **explicitly disabled** — `AudioEffectsManager.apply()` sets
 * `effect.enabled = config.autoGain / echoCancel / noiseSuppress`, all three false.
 *
 * DEVIATION (see task-11-report.md §4): the source is `VOICE_RECOGNITION` as the Task 11
 * brief requires; the Dart app never set `androidConfig.audioSource`, so `record_android`
 * used `MediaRecorder.AudioSource.DEFAULT` (0) — `RecordConfig.kt:25,79`.
 */
class AudioRecorder(private val onChunk: (FloatArray) -> Unit) {

    companion object {
        private const val TAG = "AudioRecorder"

        /** `recordSampleRate` — audio_processor_io.dart:14 */
        const val SAMPLE_RATE = 16000

        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT

        /** `bytesPerSample` — audio_processor_io.dart:16 */
        const val BYTES_PER_SAMPLE = 2

        /** `chunkMs` — audio_processor_io.dart:15 */
        const val CHUNK_MS = 480

        /** `recordChunkBytes / bytesPerSample` — 15 360 / 2 = 7 680 samples. */
        const val CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS / 1000
        const val CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE

        /** Task 11 brief; differs from the Dart app's `AudioSource.DEFAULT` (see class docs). */
        val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_RECOGNITION
    }

    private var record: AudioRecord? = null
    private var thread: Thread? = null

    @Volatile
    private var running = false

    private var agc: AutomaticGainControl? = null
    private var aec: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    val isRecording: Boolean
        get() = running

    /**
     * Opens the microphone and starts the capture thread.
     *
     * @throws IllegalStateException when the device cannot capture 16 kHz mono PCM16 or the
     *   recorder fails to initialise (e.g. `android.permission.RECORD_AUDIO` not granted).
     */
    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return

        val minBufferSize =
            AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
            throw IllegalStateException(
                "16 kHz mono PCM16 capture is unsupported by this device " +
                    "(AudioRecord.getMinBufferSize returned $minBufferSize)",
            )
        }
        // PCMReader.kt:118 — "Double the minimum buffer size for safety margin".
        val bufferSize = minBufferSize * 2

        val recorder = try {
            AudioRecord(AUDIO_SOURCE, SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize)
        } catch (error: IllegalArgumentException) {
            throw IllegalStateException("Unable to instantiate AudioRecord.", error)
        } catch (error: SecurityException) {
            throw IllegalStateException(
                "android.permission.RECORD_AUDIO has not been granted.",
                error,
            )
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException(
                "AudioRecord failed to initialise — is RECORD_AUDIO granted?",
            )
        }

        record = recorder
        disableAudioEffects(recorder.audioSessionId)
        running = true
        thread = Thread({ captureLoop(recorder, bufferSize) }, "recitequran-audio").also {
            it.start()
        }
    }

    /** Stops capture, releases the effects and the AudioRecord, and joins the thread. */
    fun stop() {
        running = false

        val recorder = record
        record = null
        if (recorder != null) {
            try {
                if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop()
                }
            } catch (error: IllegalStateException) {
                Log.w(TAG, "AudioRecord.stop() failed", error)
            }
            releaseAudioEffects()
            recorder.release()
        }

        thread?.let { worker ->
            try {
                worker.join(500L)
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        thread = null
    }

    private fun captureLoop(recorder: AudioRecord, bufferSize: Int) {
        val readBuffer = ShortArray(bufferSize / 2)
        val frame = ShortArray(CHUNK_SAMPLES)
        var filled = 0

        try {
            recorder.startRecording()

            while (running) {
                val read = try {
                    recorder.read(readBuffer, 0, readBuffer.size)
                } catch (error: IllegalStateException) {
                    Log.e(TAG, "AudioRecord.read failed", error)
                    break
                }

                if (read < 0) {
                    Log.e(TAG, "AudioRecord.read returned error code $read")
                    break
                }
                if (read == 0) continue

                var offset = 0
                while (offset < read) {
                    val take = min(CHUNK_SAMPLES - filled, read - offset)
                    System.arraycopy(readBuffer, offset, frame, filled, take)
                    filled += take
                    offset += take

                    if (filled == CHUNK_SAMPLES) {
                        filled = 0
                        onChunk(toFloats(frame))
                    }
                }
            }
        } catch (error: Throwable) {
            Log.e(TAG, "capture loop terminated", error)
        } finally {
            running = false
        }
    }

    /** `int16samples[i] / 32768.0` — audio_processor_io.dart:85-89. */
    private fun toFloats(frame: ShortArray): FloatArray {
        val floats = FloatArray(CHUNK_SAMPLES)
        for (i in 0 until CHUNK_SAMPLES) {
            floats[i] = frame[i] / 32768.0f
        }
        return floats
    }

    /**
     * `AudioEffectsManager.apply()` with `autoGain = echoCancel = noiseSuppress = false`:
     * the effects are instantiated when the device supports them and then switched off, so
     * hardware pre-processing cannot swallow the breathy phoneme consonants this app scores
     * (audio_processor_io.dart:37-38).
     */
    private fun disableAudioEffects(audioSessionId: Int) {
        if (AutomaticGainControl.isAvailable()) {
            try {
                agc = AutomaticGainControl.create(audioSessionId)
                agc?.enabled = false
            } catch (error: RuntimeException) {
                agc = null
                Log.w(TAG, "AutomaticGainControl unavailable", error)
            }
        }
        if (AcousticEchoCanceler.isAvailable()) {
            try {
                aec = AcousticEchoCanceler.create(audioSessionId)
                aec?.enabled = false
            } catch (error: RuntimeException) {
                aec = null
                Log.w(TAG, "AcousticEchoCanceler unavailable", error)
            }
        }
        if (NoiseSuppressor.isAvailable()) {
            try {
                noiseSuppressor = NoiseSuppressor.create(audioSessionId)
                noiseSuppressor?.enabled = false
            } catch (error: RuntimeException) {
                noiseSuppressor = null
                Log.w(TAG, "NoiseSuppressor unavailable", error)
            }
        }
    }

    private fun releaseAudioEffects() {
        runCatching { agc?.release() }.onFailure { Log.w(TAG, "AGC release failed", it) }
        runCatching { aec?.release() }.onFailure { Log.w(TAG, "AEC release failed", it) }
        runCatching { noiseSuppressor?.release() }
            .onFailure { Log.w(TAG, "NS release failed", it) }
        agc = null
        aec = null
        noiseSuppressor = null
    }
}
