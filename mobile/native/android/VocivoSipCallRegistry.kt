package app.vocivo.sip

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.telecom.DisconnectCause
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.ArrayDeque

/**
 * The bridge between Android's telecom stack and the JavaScript SIP engine.
 *
 * Vocivo speaks SIP to its own edge from JavaScript. This object exists for the
 * two things that must work before JavaScript does: putting an incoming call on
 * the system's call screen when a high-priority FCM message wakes a killed app,
 * and keeping the system's idea of the call in step with ours afterwards.
 *
 * It is a process-wide singleton on purpose. `VocivoConnectionService` is
 * created by the system, not by React Native, so the two halves can only meet
 * through something neither of them owns.
 */
object VocivoSipCallRegistry {
  private val main = Handler(Looper.getMainLooper())
  private val connections = HashMap<String, VocivoConnection>()
  private val ended = LinkedHashSet<String>()
  private val deadlines = HashMap<String, Runnable>()
  private var application: Context? = null

  @Synchronized
  fun prepare(context: Context, callId: String): Boolean {
    application = context.applicationContext
    if (ended.contains(callId) || connections.containsKey(callId) || deadlines.containsKey(callId)) return false
    val timeout = Runnable {
      emit("callUiEnd", "callId" to callId)
      end(callId, DisconnectCause.MISSED)
    }
    deadlines[callId] = timeout
    main.postDelayed(timeout, 45_000)
    return true
  }

  @Synchronized
  fun connected(callId: String) {
    deadlines.remove(callId)?.let { main.removeCallbacks(it) }
  }

  @Synchronized
  fun end(callId: String, cause: Int) {
    val call = connections[callId]
    if (call != null) call.finish(cause) else forget(callId)
  }

  @Synchronized
  fun hasCalls() = connections.isNotEmpty() || deadlines.isNotEmpty()

  // The microphone mute and the communication audio mode are device-wide
  // settings, not per-call ones. Vocivo used to set both and restore neither,
  // so a call ended while muted left the microphone muted for every other app
  // on the phone until it was rebooted, and the phone stayed in call audio mode
  // long after the call.
  private var mutedMicrophone = false
  private var claimedAudioMode = false

  private fun audioManager(context: Context) =
    context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  @Synchronized
  fun setMicrophoneMuted(context: Context, muted: Boolean) {
    application = context.applicationContext
    audioManager(context)?.isMicrophoneMute = muted
    mutedMicrophone = muted
  }

  /**
   * Puts the device into call audio mode before there is any media to carry.
   *
   * WebRTC builds its recorder and its player the moment the answered session
   * hands it tracks, and it builds them for whatever mode the device is in at
   * that instant. On a call woken by FCM the user can answer while the INVITE
   * is still being waited for, so the tracks arrive seconds later and, until
   * this ran on answer, the only thing that ever claimed the mode was the
   * Speaker button — a call nobody pressed it on came up recorded and played
   * against the media stream. `releaseAudio` gives the mode back through the
   * same flag, so claiming it early costs the rest of the phone nothing.
   */
  @Synchronized
  fun claimAudio(context: Context) {
    application = context.applicationContext
    val manager = audioManager(context) ?: return
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    claimedAudioMode = true
  }

  @Synchronized
  fun setSpeakerphone(context: Context, on: Boolean) {
    claimAudio(context)
    val manager = audioManager(context) ?: return
    @Suppress("DEPRECATION")
    manager.isSpeakerphoneOn = on
  }

  /** Gives the device's audio back to whatever else is using the phone. */
  @Synchronized
  fun releaseAudio() {
    val context = application ?: return
    val manager = audioManager(context) ?: return
    if (mutedMicrophone) manager.isMicrophoneMute = false
    mutedMicrophone = false
    if (claimedAudioMode && manager.mode == AudioManager.MODE_IN_COMMUNICATION) manager.mode = AudioManager.MODE_NORMAL
    claimedAudioMode = false
  }

  /** Events raised before the JavaScript runtime attached. */
  private val pending = ArrayDeque<Pair<String, WritableMap>>()
  private const val MAX_PENDING = 16

  @Volatile
  private var reactContext: ReactContext? = null

  @Synchronized
  fun attach(context: ReactContext) {
    reactContext = context
    // Hand over everything that happened while the app was still starting —
    // above all the wake-up that put this call on screen in the first place.
    while (pending.isNotEmpty()) {
      val (name, body) = pending.removeFirst()
      send(context, name, body)
    }
  }

  @Synchronized
  fun detach() {
    reactContext = null
  }

  @Synchronized
  fun emit(name: String, body: WritableMap) {
    val context = reactContext
    if (context != null && context.hasActiveReactInstance()) {
      send(context, name, body)
      return
    }
    if (pending.size >= MAX_PENDING) pending.removeFirst()
    pending.addLast(name to body)
  }

  fun emit(name: String, vararg entries: Pair<String, Any?>) {
    val body = Arguments.createMap()
    entries.forEach { (key, value) ->
      when (value) {
        null -> body.putNull(key)
        is Boolean -> body.putBoolean(key, value)
        is Int -> body.putInt(key, value)
        is Double -> body.putDouble(key, value)
        else -> body.putString(key, value.toString())
      }
    }
    emit(name, body)
  }

  private fun send(context: ReactContext, name: String, body: WritableMap) {
    main.post {
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, body)
    }
  }

  /**
   * `context` is what lets the registry clean up after a call it did not
   * `prepare`: a dialled call never goes through the incoming path, so without
   * this the application context was null and its foreground service and audio
   * mode were never given back.
   */
  @Synchronized
  fun register(context: Context, callId: String, connection: VocivoConnection) {
    application = context.applicationContext
    if (ended.contains(callId)) { connection.finish(DisconnectCause.CANCELED); return }
    connections[callId] = connection
  }

  @Synchronized
  fun connection(callId: String): VocivoConnection? = connections[callId]

  @Synchronized
  fun forget(callId: String) {
    connections.remove(callId)
    deadlines.remove(callId)?.let { main.removeCallbacks(it) }
    ended.add(callId)
    if (ended.size > 128) ended.remove(ended.first())
    application?.let { context ->
      VocivoSipCallNotification.cancel(context, callId)
      if (!hasCalls()) {
        releaseAudio()
        context.stopService(Intent(context, VocivoSipCallService::class.java))
      }
    }
  }

  @Synchronized
  fun forgetAll() {
    (connections.keys + deadlines.keys).toList().forEach { end(it, DisconnectCause.CANCELED) }
  }
}
