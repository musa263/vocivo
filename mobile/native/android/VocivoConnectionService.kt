package app.vocivo.sip

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Hands Android a `Connection` whenever Telecom decides a Vocivo call should
 * exist. The system creates this service itself, which is why the call id
 * travels in the request extras rather than through anything React Native owns.
 */
class VocivoConnectionService : ConnectionService() {

  override fun onCreateIncomingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest,
  ): Connection = build(request, incoming = true)

  override fun onCreateOutgoingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest,
  ): Connection = build(request, incoming = false)

  override fun onCreateIncomingConnectionFailed(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?,
  ) {
    // Telecom refused the call — most often because a cellular call is already
    // up. JavaScript has to hear about it or the caller rings into nothing.
    request?.extras?.getString(EXTRA_CALL_ID)?.let {
      VocivoSipCallRegistry.emit("callUiEnd", "callId" to it)
      VocivoSipCallRegistry.end(it, DisconnectCause.ERROR)
    }
  }

  private fun build(request: ConnectionRequest, incoming: Boolean): Connection {
    val callId = request.extras?.getString(EXTRA_CALL_ID)
      ?: return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))

    val connection = VocivoConnection(callId, applicationContext)
    connection.setAddress(request.address, TelecomManager.PRESENTATION_ALLOWED)
    request.extras?.getString(EXTRA_CALLER_NAME)?.let { connection.setCallerDisplayName(it, TelecomManager.PRESENTATION_ALLOWED) }
    connection.setExtras(request.extras)
    VocivoSipCallRegistry.register(applicationContext, callId, connection)
    if (connection.state == Connection.STATE_DISCONNECTED) return connection
    if (incoming) connection.markRinging() else connection.markDialing()
    return connection
  }

  companion object {
    const val EXTRA_CALL_ID = "app.vocivo.sip.CALL_ID"
    const val EXTRA_CALLER_NAME = "app.vocivo.sip.CALLER_NAME"
  }
}
