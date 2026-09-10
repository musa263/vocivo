package app.vocivo.sip

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Bundle
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.google.firebase.messaging.FirebaseMessaging

/**
 * The `VocivoSip` React Native module on Android.
 *
 * The mirror of the iOS one, and just as thin. SIP registration, INVITEs and
 * media all happen in JavaScript against Vocivo's own edge; this class only
 * teaches Android's telecom stack about calls that already exist, and reports
 * back what the user does on the system call screen.
 */
class VocivoSipModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  private val telecom by lazy { reactContext.getSystemService(Context.TELECOM_SERVICE) as TelecomManager }
  private var ringback: ToneGenerator? = null
  private var ringbackCallId: String? = null

  private fun stopRingback() {
    ringback?.stopTone()
    ringback?.release()
    ringback = null
    ringbackCallId = null
  }

  @ReactMethod
  fun setRingback(input: ReadableMap, promise: Promise) {
    val id = input.getString("callId") ?: return promise.reject("vocivo_sip_bad_call", "Missing callId")
    try {
      if (!input.getBoolean("enabled")) {
        if (ringbackCallId == id) stopRingback()
      } else if (ringbackCallId != id) {
        stopRingback()
        val tone = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 35)
        if (!tone.startTone(ToneGenerator.TONE_SUP_RINGTONE)) {
          tone.release()
          throw IllegalStateException("Could not start ringback")
        }
        ringback = tone
        ringbackCallId = id
      }
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("vocivo_ringback", "Ringback playback failed", error) }
  }

  override fun getName() = "VocivoSip"

  override fun initialize() {
    super.initialize()
  }

  @ReactMethod
  fun startCallUiEvents(promise: Promise) { VocivoSipCallRegistry.attach(reactContext); promise.resolve(null) }

  @ReactMethod
  fun stopCallUiEvents(promise: Promise) { VocivoSipCallRegistry.detach(); promise.resolve(null) }

  @ReactMethod
  fun completeAnswer(input: ReadableMap, promise: Promise) {
    val id = input.getString("callId") ?: return promise.reject("vocivo_sip_bad_call", "Missing callId")
    if (input.getBoolean("success")) VocivoSipCallRegistry.connection(id)?.markActive()
    else VocivoSipCallRegistry.end(id, DisconnectCause.ERROR)
    promise.resolve(null)
  }

  override fun invalidate() {
    stopRingback()
    // The module going away with a mute or a communication mode still set would
    // leave both on the device, where every other app hears the consequences.
    VocivoSipCallRegistry.releaseAudio()
    VocivoSipCallRegistry.detach()
    super.invalidate()
  }

  /** Required by `NativeEventEmitter`; the registry does the actual emitting. */
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Int) = Unit

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun reportIncomingCall(input: ReadableMap, promise: Promise) {
    val callId = input.getString("callId")
    if (callId.isNullOrEmpty()) {
      promise.reject("vocivo_sip_bad_call", "reportIncomingCall needs a callId")
      return
    }
    try {
      if (!VocivoSipCallRegistry.prepare(reactContext, callId)) { promise.resolve(null); return }
      registerPhoneAccount()
      val extras = Bundle().apply {
        putString(VocivoConnectionService.EXTRA_CALL_ID, callId)
        input.getString("callerName")?.let { putString(VocivoConnectionService.EXTRA_CALLER_NAME, it) }
        putParcelable(
          TelecomManager.EXTRA_INCOMING_CALL_ADDRESS,
          Uri.fromParts(PhoneAccount.SCHEME_SIP, input.getString("callerNumber") ?: callId, null),
        )
      }
      telecom.addNewIncomingCall(handle(), extras)
      VocivoSipIncomingCall.startRuntime(reactContext, callId)
      promise.resolve(null)
    } catch (error: SecurityException) {
      // The user can revoke MANAGE_OWN_CALLS. Falling over here would lose the
      // call entirely, so report it and let JavaScript ring in-app instead.
      promise.reject("vocivo_sip_telecom", error.message ?: "Telecom refused the call", error)
      VocivoSipCallRegistry.end(callId, DisconnectCause.ERROR)
    } catch (error: IllegalStateException) {
      VocivoSipCallRegistry.end(callId, DisconnectCause.ERROR)
      promise.reject("vocivo_sip_startup", "Android could not start the calling service", error)
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun reportOutgoingCall(input: ReadableMap, promise: Promise) {
    val callId = input.getString("callId")
    if (callId.isNullOrEmpty()) {
      promise.reject("vocivo_sip_bad_call", "reportOutgoingCall needs a callId")
      return
    }
    try {
      registerPhoneAccount()
      val extras = Bundle().apply {
        putBundle(
          TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS,
          Bundle().apply { putString(VocivoConnectionService.EXTRA_CALL_ID, callId) },
        )
        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle())
      }
      val address = Uri.fromParts(PhoneAccount.SCHEME_SIP, input.getString("handle") ?: callId, null)
      telecom.placeCall(address, extras)
      // A dialled call needs the same phone-call foreground service an incoming
      // one gets. Without it, a call backgrounded mid-conversation had nothing
      // telling Android the app was on a call, and an aggressive OEM was free
      // to kill it.
      VocivoSipIncomingCall.startRuntime(reactContext, callId, wake = false)
      promise.resolve(null)
    } catch (error: SecurityException) {
      promise.reject("vocivo_sip_telecom", error.message ?: "Telecom refused the call", error)
    }
  }

  @ReactMethod
  fun reportCallConnected(callId: String, promise: Promise) {
    if (ringbackCallId == callId) stopRingback()
    VocivoSipCallRegistry.connection(callId)?.markActive()
    promise.resolve(null)
  }

  @ReactMethod
  fun reportCallEnded(input: ReadableMap, promise: Promise) {
    val callId = input.getString("callId")
    if (callId.isNullOrEmpty()) {
      promise.reject("vocivo_sip_bad_call", "reportCallEnded needs a callId")
      return
    }
    val cause = when (input.getString("reason")) {
      "failed" -> DisconnectCause.ERROR
      "declined" -> DisconnectCause.REJECTED
      "unanswered" -> DisconnectCause.MISSED
      else -> DisconnectCause.REMOTE
    }
    if (ringbackCallId == callId) stopRingback()
    VocivoSipCallRegistry.end(callId, cause)
    promise.resolve(null)
  }

  @ReactMethod
  fun reportMuted(input: ReadableMap, promise: Promise) {
    val callId = input.getString("callId")
    if (callId.isNullOrEmpty()) {
      promise.reject("vocivo_sip_bad_call", "reportMuted needs a callId")
      return
    }
    val muted = input.getBoolean("muted")
    // Tell the connection first: the microphone mute is device-wide, so Telecom
    // reports it straight back as a state change, and the connection has to
    // know the change was ours before it treats it as the user's.
    VocivoSipCallRegistry.connection(callId)?.applyMuted(muted)
    VocivoSipCallRegistry.setMicrophoneMuted(reactContext, muted)
    promise.resolve(null)
  }

  @ReactMethod
  fun reportHeld(input: ReadableMap, promise: Promise) {
    val connection = VocivoSipCallRegistry.connection(input.getString("callId") ?: "")
    if (input.getBoolean("held")) connection?.setOnHold() else connection?.markActive()
    promise.resolve(null)
  }

  @ReactMethod
  fun setSpeaker(on: Boolean, promise: Promise) {
    // Through the registry, which is the one thing that outlives every call and
    // can therefore put the audio mode back when the last of them ends.
    VocivoSipCallRegistry.setSpeakerphone(reactContext, on)
    promise.resolve(null)
  }

  @ReactMethod
  fun isCallUiAvailable(promise: Promise) {
    promise.resolve(runCatching { registerPhoneAccount(); true }.getOrDefault(false))
  }

  @ReactMethod
  fun voipPushToken(promise: Promise) {
    // Android wakes on FCM, whose token the app already collects elsewhere.
    promise.resolve(null)
  }

  @ReactMethod
  fun setVoiceSignedIn(signedIn: Boolean, promise: Promise) {
    val saved = reactContext.getSharedPreferences("vocivo_auth", Context.MODE_PRIVATE)
      .edit().putBoolean("voice_signed_in", signedIn).commit()
    if (saved) promise.resolve(true)
    else promise.reject("vocivo_auth_store", "Could not persist the native calling sign-in state")
  }

  @ReactMethod
  fun firebasePushToken(promise: Promise) {
    val preferences = reactContext.getSharedPreferences("vocivo_push", Context.MODE_PRIVATE)
    try {
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (task.isSuccessful && !task.result.isNullOrBlank()) {
          preferences.edit().putString("fcm_token", task.result).apply()
          promise.resolve(task.result)
        } else {
          val stored = preferences.getString("fcm_token", null)
          if (!stored.isNullOrBlank()) promise.resolve(stored)
          else promise.reject("vocivo_push_token", "Firebase push token is unavailable", task.exception)
        }
      }
    } catch (error: Exception) {
      promise.reject("vocivo_push_token", "Firebase push token is unavailable", error)
    }
  }

  private fun handle() = PhoneAccountHandle(
    ComponentName(reactContext, VocivoConnectionService::class.java),
    ACCOUNT_ID,
  )

  /**
   * Registers Vocivo as a self-managed calling account.
   *
   * Self-managed rather than call-provider: Vocivo is not replacing the phone
   * app, it is another app that happens to make calls, and self-managed is what
   * lets it coexist with a cellular call instead of fighting it.
   */
  private fun registerPhoneAccount() {
    val existing = telecom.getPhoneAccount(handle())
    if (existing != null) return
    val account = PhoneAccount.builder(handle(), "Vocivo")
      .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
      .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
      .addSupportedUriScheme(PhoneAccount.SCHEME_TEL)
      .build()
    telecom.registerPhoneAccount(account)
  }

  companion object {
    private const val ACCOUNT_ID = "app.vocivo.sip.account"
  }
}
