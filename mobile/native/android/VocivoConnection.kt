package app.vocivo.sip

import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.content.Context

/**
 * One call, as Android's telecom stack sees it.
 *
 * Every override here turns a press on the system call screen into an event the
 * JavaScript engine acts on. The connection deliberately does not touch SIP
 * itself: if the two ever disagree about what a call is doing, the SIP side is
 * the one telling the truth, and it corrects this one through the module.
 */
class VocivoConnection(private val callId: String, private val context: Context) : Connection() {
  private var answering = false
  private var mirroredMute: Boolean? = null
  private val main = android.os.Handler(android.os.Looper.getMainLooper())
  private val answerDeadline = Runnable {
    VocivoSipCallRegistry.emit("callUiEnd", "callId" to callId)
    finish(DisconnectCause.ERROR)
  }

  init {
    connectionProperties = PROPERTY_SELF_MANAGED
    connectionCapabilities = CAPABILITY_HOLD or CAPABILITY_SUPPORT_HOLD or CAPABILITY_MUTE
    audioModeIsVoip = true
    setInitializing()
  }

  override fun onShowIncomingCallUi() {
    VocivoSipCallNotification.show(context, callId, callerDisplayName ?: "Incoming call", true)
  }

  override fun onAnswer() {
    if (answering || state != STATE_RINGING) return
    if (!context.getSharedPreferences("vocivo_auth", Context.MODE_PRIVATE).getBoolean("voice_signed_in", false)) {
      finish(DisconnectCause.CANCELED)
      return
    }
    answering = true
    main.postDelayed(answerDeadline, 12_000)
    VocivoSipCallRegistry.emit("callUiAnswer", "callId" to callId)
  }

  override fun onAnswer(videoState: Int) = onAnswer()

  override fun onReject() {
    VocivoSipCallRegistry.emit("callUiEnd", "callId" to callId)
    finish(DisconnectCause.REJECTED)
  }

  override fun onDisconnect() {
    VocivoSipCallRegistry.emit("callUiEnd", "callId" to callId)
    finish(DisconnectCause.LOCAL)
  }

  override fun onAbort() {
    VocivoSipCallRegistry.emit("callUiEnd", "callId" to callId)
    finish(DisconnectCause.CANCELED)
  }

  override fun onHold() {
    VocivoSipCallRegistry.emit("callUiHold", "callId" to callId, "held" to true)
    setOnHold()
  }

  override fun onUnhold() {
    VocivoSipCallRegistry.emit("callUiHold", "callId" to callId, "held" to false)
    setActive()
  }

  override fun onPlayDtmfTone(c: Char) {
    VocivoSipCallRegistry.emit("callUiDtmf", "callId" to callId, "digit" to c.toString())
  }

  override fun onCallAudioStateChanged(state: CallAudioState) {
    // Telecom reports our own mute back to us along with every route change.
    // Passing that on made the engine mute a second time and, on a route change
    // during a muted call, unmute one the user had asked to keep muted.
    if (mirroredMute == state.isMuted) {
      mirroredMute = null
    } else {
      VocivoSipCallRegistry.emit(
        "callUiMute",
        "callId" to callId,
        "muted" to state.isMuted,
      )
    }
    VocivoSipCallRegistry.emit(
      "callUiAudioSession",
      "callId" to callId,
      "active" to true,
      "route" to when (state.route) {
        CallAudioState.ROUTE_SPEAKER -> "speaker"
        CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
        CallAudioState.ROUTE_WIRED_HEADSET -> "headset"
        else -> "earpiece"
      },
    )
  }

  /** The engine muted or unmuted; remember it so Telecom's echo is not a command. */
  fun applyMuted(muted: Boolean) {
    mirroredMute = muted
  }

  /** Called by the module when SIP — not the user — ended the call. */
  fun finish(cause: Int) {
    if (state == STATE_DISCONNECTED) return
    main.removeCallbacks(answerDeadline)
    setDisconnected(DisconnectCause(cause))
    destroy()
    VocivoSipCallRegistry.forget(callId)
  }

  fun markRinging() = setRinging()

  fun markDialing() = setDialing()

  fun markActive() {
    if (state == STATE_DISCONNECTED) return
    main.removeCallbacks(answerDeadline)
    VocivoSipCallRegistry.connected(callId)
    VocivoSipCallNotification.show(context, callId, callerDisplayName ?: "Vocivo", false)
    setActive()
  }
}
