package app.vocivo.sip

import android.content.Intent
import android.app.Service
import android.os.IBinder
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Boots SIP without waiting for a React screen or /auth/session response. */
class VocivoSipWakeService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? = intent?.extras?.let {
    HeadlessJsTaskConfig("VocivoSipWake", Arguments.fromBundle(it), 45_000, true)
  }
}

/** Separate lifetime: finishing the bootstrap task must not stop active audio. */
class VocivoSipCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra("callId")
    if (id == null || !getSharedPreferences("vocivo_auth", MODE_PRIVATE).getBoolean("voice_signed_in", false)) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    val notification = VocivoSipCallNotification.build(this, id, "Vocivo", false)
    if (Build.VERSION.SDK_INT >= 29) startForeground(VocivoSipCallNotification.SERVICE_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
    else startForeground(VocivoSipCallNotification.SERVICE_ID, notification)
    // A dialled call was placed by JavaScript that is already running; asking
    // for the bootstrap task again would register the phone a second time for
    // no reason. It is only an incoming call that arrives before the runtime.
    if (intent.getBooleanExtra("wakeRuntime", true)) {
      startService(Intent(this, VocivoSipWakeService::class.java).putExtras(intent.extras!!))
    }
    return START_NOT_STICKY
  }
}
