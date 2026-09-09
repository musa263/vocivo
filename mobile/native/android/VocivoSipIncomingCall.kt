package app.vocivo.sip

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * Wakes Vocivo for an incoming call on Android.
 *
 * The counterpart to PushKit: a high-priority FCM data message starts the app
 * process even after the app has been swiped away. The call goes onto the
 * system call screen straight from the payload, because the JavaScript runtime
 * — and therefore SIP registration — will not exist for another second or two,
 * and the caller should hear ringback throughout.
 *
 * This lives in an object rather than in a `FirebaseMessagingService` because
 * Android delivers messages to exactly one such service, and the app has to
 * share that one service with the carrier SDK until the SIP edge is the only
 * path in production.
 */
object VocivoSipIncomingCall {
  private const val ACCOUNT_ID = "app.vocivo.sip.account"

  /**
   * Puts the call under a phone-call foreground service.
   *
   * `wake` is what separates the two callers: an incoming call arrives at a
   * process that may have no JavaScript runtime yet and needs one started, a
   * dialled call already has one and only needs the foreground service, which
   * is what stops an aggressive OEM from killing the app mid-conversation once
   * the user leaves Vocivo for another app.
   */
  fun startRuntime(context: Context, callId: String, wake: Boolean = true) {
    val service = Intent(context, VocivoSipCallService::class.java)
      .putExtra("callId", callId)
      .putExtra("wakeRuntime", wake)
    if (android.os.Build.VERSION.SDK_INT >= 26) context.startForegroundService(service) else context.startService(service)
  }

  /** True when the message was a Vocivo call and has been handled here. */
  @SuppressLint("MissingPermission")
  fun handle(context: Context, data: Map<String, String>): Boolean {
    if (data["type"] !in setOf("vocivo.incoming_call", "vocivo.call")) return false

    val signedIn = context.getSharedPreferences("vocivo_auth", Context.MODE_PRIVATE)
      .getBoolean("voice_signed_in", false)
    // A signed-out handset must not ring. Whether to send the push is the
    // server's business; who is holding the phone is ours.
    if (!signedIn) return true

    val callId = data["callId"] ?: data["call_id"] ?: return true
    if (callId.length > 256) return true
    val expiresAt = data["expiresAt"]
    if (expiresAt != null && runCatching {
      val pattern = if (expiresAt.contains('.')) "yyyy-MM-dd'T'HH:mm:ss.SSSX" else "yyyy-MM-dd'T'HH:mm:ssX"
      java.text.SimpleDateFormat(pattern, java.util.Locale.US).apply { isLenient = false }.parse(expiresAt)?.time ?: 0L
    }.getOrDefault(0L) <= System.currentTimeMillis()) return true
    if (!VocivoSipCallRegistry.prepare(context, callId)) return true
    val callerName = data["callerName"] ?: data["caller_name"]
    val callerNumber = data["callerNumber"] ?: data["caller_number"]

    val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    val handle = PhoneAccountHandle(ComponentName(context, VocivoConnectionService::class.java), ACCOUNT_ID)
    try {
      if (telecom.getPhoneAccount(handle) == null) {
        telecom.registerPhoneAccount(
          PhoneAccount.builder(handle, "Vocivo")
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
            .addSupportedUriScheme(PhoneAccount.SCHEME_TEL)
            .build(),
        )
      }

      val extras = Bundle().apply {
        putString(VocivoConnectionService.EXTRA_CALL_ID, callId)
        callerName?.let { putString(VocivoConnectionService.EXTRA_CALLER_NAME, it) }
        putParcelable(
          TelecomManager.EXTRA_INCOMING_CALL_ADDRESS,
          Uri.fromParts(PhoneAccount.SCHEME_SIP, callerNumber ?: callId, null),
        )
      }

      telecom.addNewIncomingCall(handle, extras)
      startRuntime(context, callId)
    } catch (error: SecurityException) {
      // Fail visibly rather than leave an unanswerable Telecom call behind.
      Log.w("VocivoSip", "Telecom refused the incoming call: ${error.message}")
      VocivoSipCallRegistry.end(callId, android.telecom.DisconnectCause.ERROR)
      return true
    } catch (error: IllegalStateException) {
      Log.e("VocivoSip", "Android denied background call startup", error)
      VocivoSipCallRegistry.end(callId, android.telecom.DisconnectCause.ERROR)
      return true
    }

    // Queued until the JavaScript engine attaches, which is what makes it
    // register with the SIP edge and pick up the INVITE the server is holding.
    VocivoSipCallRegistry.emit(
      "callUiPushWake",
      "callId" to callId,
      "callerName" to callerName,
      "callerNumber" to callerNumber,
      "expiresAt" to expiresAt,
    )
    return true
  }
}
