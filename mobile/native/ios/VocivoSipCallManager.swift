import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit
import WebRTC

/// CallKit and PushKit for Vocivo.
///
/// Vocivo speaks SIP to its own edge from JavaScript. Two things cannot be done
/// there, and they are the whole of this file: drawing the incoming-call screen
/// that iOS owns, and being alive when a VoIP push lands on a phone whose app
/// iOS has killed. PushKit is unforgiving about the second — an app that
/// receives a VoIP push and returns from the delegate without reporting a call
/// to CallKit is terminated, and repeat offenders stop receiving pushes at all.
/// So the call is reported here, synchronously, from the payload, long before
/// the JavaScript runtime exists.
@objc(VocivoSipCallManager)
public final class VocivoSipCallManager: NSObject {
  @objc public static let shared = VocivoSipCallManager()

  /// Set by the React Native module once JavaScript is running.
  public var onEvent: ((String, [String: Any]) -> Void)?

  private let provider: CXProvider
  private let controller = CXCallController()

  /// Vocivo call id <-> CallKit UUID. Both directions are needed: JavaScript
  /// talks in call ids, CallKit talks in UUIDs.
  private var uuidsByCallId: [String: UUID] = [:]
  private var callIdsByUuid: [UUID: String] = [:]
  private var pendingAnswers: [String: CXAnswerCallAction] = [:]
  private var mirroredActions: [UUID: String] = [:]
  private var outgoingCalls = Set<String>()
  private var connectedCalls = Set<String>()
  private var answeredCalls = Set<String>()
  private var ringback: AVAudioPlayer?
  private var ringbackCallId: String?
  private var audioActive = false
  private var speakerOverride = false
  private var ringingDeadlines: [String: DispatchWorkItem] = [:]

  /// Events raised before JavaScript attached. A push wake is the reason this
  /// exists: without it the wake is delivered to nobody and the user answers a
  /// call the app never learns about.
  private var pending: [(String, [String: Any])] = []
  private let lock = NSLock()

  /// The ringtone the user picked, as a file in the app bundle.
  private var ringtoneSound = "vocivo_classic.wav"

  private override init() {
    provider = CXProvider(configuration: VocivoSipCallManager.configuration(ringtone: "vocivo_classic.wav"))
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  private static func configuration(ringtone: String?) -> CXProviderConfiguration {
    let configuration = CXProviderConfiguration(localizedName: "Vocivo")
    configuration.supportsVideo = false
    // Vocivo has call waiting, Add caller, Swap and Merge. Allowing one call
    // per group meant the second leg never reached CallKit at all: when the
    // first ended, `didDeactivate` turned WebRTC's audio off and the call that
    // was still up went silent with nothing on screen to explain it.
    configuration.maximumCallsPerCallGroup = 2
    configuration.maximumCallGroups = 2
    configuration.supportedHandleTypes = [.phoneNumber, .generic]
    configuration.includesCallsInRecents = true
    configuration.ringtoneSound = ringtone
    if let icon = UIImage(named: "vocivo-icon") {
      configuration.iconTemplateImageData = icon.pngData()
    }
    return configuration
  }

  /// Applies the ringtone chosen in Vocivo's settings.
  ///
  /// A CallKit provider's ringtone lives in its configuration and nowhere else,
  /// so changing it means handing the provider a new one. The settings screen
  /// used to confirm a choice that never left JavaScript.
  @objc public func setRingtone(_ sound: String?) {
    let name = (sound ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    // "system" is the one choice that is not a bundled file: leaving the
    // configuration's sound unset is what asks iOS for its own ringtone.
    ringtoneSound = name.isEmpty || name == "system" ? "" : (name.hasSuffix(".wav") ? name : "\(name).wav")
    provider.configuration = VocivoSipCallManager.configuration(ringtone: ringtoneSound.isEmpty ? nil : ringtoneSound)
  }

  // MARK: - Launch

  /// AppDelegate owns the sole PushKit registry and routes pushes by provider.
  @objc public func start() {
    // Initializing the singleton installs the CallKit provider delegate.
    //
    // Manual audio is the half of the CallKit contract this file was missing.
    // WebRTC ignores `isAudioEnabled` unless it has been asked to honour it —
    // otherwise it decides for itself when to build its audio unit and takes
    // the audio session on its own, which for a CallKit call is the system's
    // job alone. On a call delivered by VoIP push those two moments are seconds
    // apart: the user answers from the lock screen and the SIP session that
    // owns the tracks only exists once the app has registered and the INVITE
    // has arrived. Whether the audio unit happened to be built against the
    // session CallKit had activated therefore came down to timing, which is
    // what "sometimes you cannot hear" was. With manual audio the flag set in
    // `didActivate` is the only thing that starts audio, and WebRTC rebuilds
    // the unit whenever permission and tracks coincide, in whichever order
    // they arrive.
    let session = RTCAudioSession.sharedInstance()
    session.useManualAudio = true
    session.isAudioEnabled = false
  }

  // MARK: - JavaScript attachment

  /// Hands over anything that happened before JavaScript was listening.
  @objc public func flushPendingEvents() {
    lock.lock()
    let queued = pending
    pending = []
    lock.unlock()
    queued.forEach { onEvent?($0.0, $0.1) }
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    if let onEvent = onEvent {
      onEvent(name, body)
      return
    }
    lock.lock()
    // Bound the queue: a phone that has been offline for a while must not
    // replay a hundred stale calls the moment the app opens.
    if pending.count >= 16 { pending.removeFirst() }
    pending.append((name, body))
    lock.unlock()
  }

  // MARK: - Call bookkeeping

  private func uuid(for callId: String) -> UUID {
    if let existing = uuidsByCallId[callId] { return existing }
    let created = UUID()
    uuidsByCallId[callId] = created
    callIdsByUuid[created] = callId
    return created
  }

  private func forget(_ callId: String) {
    mirroredActions = mirroredActions.filter { $0.value != callId }
    ringingDeadlines.removeValue(forKey: callId)?.cancel()
    pendingAnswers.removeValue(forKey: callId)?.fail()
    outgoingCalls.remove(callId)
    connectedCalls.remove(callId)
    answeredCalls.remove(callId)
    if ringbackCallId == callId { stopRingback() }
    guard let uuid = uuidsByCallId.removeValue(forKey: callId) else { return }
    callIdsByUuid.removeValue(forKey: uuid)
    // The route belongs to the call, not to the app. CallKit configures a fresh
    // session for the next one, so remembering the last call's loudspeaker
    // would put a call nobody has answered yet onto it.
    if uuidsByCallId.isEmpty { speakerOverride = false }
  }

  // MARK: - Reporting to CallKit

  @objc public func reportIncomingCall(callId: String, callerName: String?, callerNumber: String?, completion: ((Error?) -> Void)? = nil) {
    let update = CXCallUpdate()
    let number = callerNumber ?? ""
    update.remoteHandle = number.isEmpty
      ? CXHandle(type: .generic, value: callerName ?? "Vocivo call")
      : CXHandle(type: .phoneNumber, value: number)
    update.localizedCallerName = callerName?.isEmpty == false ? callerName : nil
    update.hasVideo = false
    update.supportsHolding = true
    update.supportsDTMF = true
    // Merge and Swap are Vocivo features; refusing grouping here left the
    // CallKit screen without the buttons for them.
    update.supportsGrouping = true
    update.supportsUngrouping = true
    let alreadyReported = uuidsByCallId[callId] != nil
    provider.reportNewIncomingCall(with: uuid(for: callId), update: update) { error in
      DispatchQueue.main.async {
        if error != nil && !alreadyReported { self.forget(callId) }
        if error == nil && self.uuidsByCallId[callId] != nil && !self.connectedCalls.contains(callId)
            && !self.answeredCalls.contains(callId) && self.pendingAnswers[callId] == nil {
          let deadline = DispatchWorkItem { [weak self] in
            self?.emit("callUiEnd", ["callId": callId])
            self?.reportCallEnded(callId: callId, reason: "unanswered")
          }
          self.ringingDeadlines.removeValue(forKey: callId)?.cancel()
          self.ringingDeadlines[callId] = deadline
          DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: deadline)
        }
        completion?(error)
      }
    }
  }

  @objc public func reportOutgoingCall(callId: String, handle: String) {
    outgoingCalls.insert(callId)
    let uuid = uuid(for: callId)
    let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .phoneNumber, value: handle))
    controller.request(CXTransaction(action: action)) { error in
      guard let error = error else { return }
      NSLog("Vocivo: outgoing CallKit transaction failed: \(error.localizedDescription)")
      DispatchQueue.main.async { self.claimAudioSessionWithoutCallKit() }
    }
  }

  @objc public func reportCallConnected(callId: String) {
    ringingDeadlines.removeValue(forKey: callId)?.cancel()
    guard let uuid = uuidsByCallId[callId] else { return }
    if ringbackCallId == callId { stopRingback() }
    guard connectedCalls.insert(callId).inserted else { return }
    if outgoingCalls.contains(callId) {
      provider.reportOutgoingCall(with: uuid, connectedAt: nil)
    } else if pendingAnswers[callId] == nil && !answeredCalls.contains(callId) {
      // An in-app Answer also needs a CallKit transaction to activate audio.
      // JS has already accepted SIP and will acknowledge this mirrored action.
      controller.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) { error in
        guard let error = error else { return }
        NSLog("Vocivo: in-app Answer transaction failed: \(error.localizedDescription)")
        DispatchQueue.main.async { self.claimAudioSessionWithoutCallKit() }
      }
    }
  }

  @objc public func completeAnswer(callId: String, success: Bool) {
    guard let action = pendingAnswers.removeValue(forKey: callId) else { return }
    if success {
      answeredCalls.insert(callId)
      ringingDeadlines.removeValue(forKey: callId)?.cancel()
      action.fulfill()
    } else { action.fail() }
  }

  @objc public func reportCallEnded(callId: String, reason: String) {
    guard let uuid = uuidsByCallId[callId] else { return }
    let cxReason: CXCallEndedReason
    switch reason {
    case "failed": cxReason = .failed
    case "declined": cxReason = .remoteEnded
    case "unanswered": cxReason = .unanswered
    default: cxReason = .remoteEnded
    }
    provider.reportCall(with: uuid, endedAt: nil, reason: cxReason)
    forget(callId)
  }

  @objc public func reportMuted(callId: String, muted: Bool, completion: @escaping (Error?) -> Void) {
    guard let uuid = uuidsByCallId[callId] else { completion(nil); return }
    submitMirror(CXSetMutedCallAction(call: uuid, muted: muted), callId: callId, completion: completion)
  }

  @objc public func reportHeld(callId: String, held: Bool, completion: @escaping (Error?) -> Void) {
    guard let uuid = uuidsByCallId[callId] else { completion(nil); return }
    submitMirror(CXSetHeldCallAction(call: uuid, onHold: held), callId: callId, completion: completion)
  }

  private func submitMirror(_ action: CXAction, callId: String, completion: @escaping (Error?) -> Void) {
    mirroredActions[action.uuid] = callId
    controller.request(CXTransaction(action: action)) { error in
      DispatchQueue.main.async {
        if error != nil { self.mirroredActions.removeValue(forKey: action.uuid) }
        completion(error)
      }
    }
  }

  // MARK: - Audio route

  @objc public func setRingback(callId: String, enabled: Bool) {
    if !enabled {
      if ringbackCallId == callId { stopRingback() }
      return
    }
    guard outgoingCalls.contains(callId), !connectedCalls.contains(callId) else { return }
    if ringbackCallId != callId { stopRingback(); ringbackCallId = callId }
    playRingbackIfReady()
  }

  private func playRingbackIfReady() {
    guard audioActive, ringbackCallId != nil, ringback == nil else { return }
    guard let url = Bundle.main.url(forResource: "vocivo_classic", withExtension: "wav") else {
      NSLog("Vocivo: bundled ringback audio is missing")
      return
    }
    do {
      let player = try AVAudioPlayer(contentsOf: url)
      player.numberOfLoops = -1
      player.volume = 0.35
      guard player.play() else { NSLog("Vocivo: ringback playback failed"); return }
      ringback = player
    } catch { NSLog("Vocivo: ringback failed: \(error.localizedDescription)") }
  }

  private func stopRingback() {
    ringback?.stop()
    ringback = nil
    ringbackCallId = nil
  }

  @objc public func setSpeaker(_ on: Bool) throws {
    // Remembered rather than applied and forgotten. CallKit hands over a newly
    // configured session for every call and again after every interruption, and
    // a port override survives neither, so a driver who had chosen the
    // loudspeaker was quietly put back on the earpiece by a call that came in
    // while the last one was still tidying up.
    speakerOverride = on
    guard audioActive else { return }
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    // Through RTCAudioSession rather than AVAudioSession directly: WebRTC
    // configures the same session under this lock while it builds its audio
    // unit, and a route changed outside the lock races that.
    try session.overrideOutputAudioPort(on ? .speaker : .none)
  }

  private func applySpeakerRoute() {
    guard speakerOverride else { return }
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    do { try session.overrideOutputAudioPort(.speaker) }
    catch { NSLog("Vocivo: could not restore the speaker route: \(error.localizedDescription)") }
  }

  /// Takes the audio session in the one case where CallKit never will.
  ///
  /// Under manual audio nothing is audible until `didActivate` grants it, and
  /// CallKit only grants it for a transaction it accepted. A refused
  /// transaction used to cost no more than a wrong-looking call screen; now it
  /// would cost the call its audio entirely, so this is the single place the
  /// app activates the session itself — by then there is no CallKit call left
  /// to fight over it.
  private func claimAudioSessionWithoutCallKit() {
    configureAudioSession()
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    do { try session.setActive(true) }
    catch { NSLog("Vocivo: could not take the audio session: \(error.localizedDescription)") }
    session.isAudioEnabled = true
    session.unlockForConfiguration()
    audioActive = true
    applySpeakerRoute()
    playRingbackIfReady()
  }

  /// Voice-chat mode with Bluetooth allowed: the phone in a pocket, a headset
  /// in the ear and a van's hands-free kit are the normal cases for this app.
  ///
  /// Category and mode only. Activating the session here is CallKit's job, and
  /// an app that does it for a CallKit call is competing with the system for
  /// something the system is about to hand it anyway.
  private func configureAudioSession() {
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    do {
      try session.setCategory(.playAndRecord, with: [.allowBluetooth])
      try session.setMode(.voiceChat)
      try session.setPreferredIOBufferDuration(0.02)
    } catch {
      NSLog("Vocivo: could not configure the audio session: \(error.localizedDescription)")
    }
  }
}

// MARK: - PushKit

extension VocivoSipCallManager: PKPushRegistryDelegate {
  public func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let token = credentials.token.map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set(token, forKey: "vocivo_voip_push_token")
    emit("callUiPushToken", ["token": token])
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    UserDefaults.standard.removeObject(forKey: "vocivo_voip_push_token")
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else { completion(); return }
    let data = (payload.dictionaryPayload["vocivo"] as? [AnyHashable: Any]) ?? payload.dictionaryPayload
    // The id must be the edge's own call UUID: the INVITE that follows carries
    // it in X-Vocivo-Call-UUID, and that is what makes the pushed call and the
    // signalled call one call instead of two.
    let callId = (data["callId"] as? String) ?? (data["call_id"] as? String) ?? UUID().uuidString
    let callerName = data["callerName"] as? String ?? data["caller_name"] as? String
    let callerNumber = data["callerNumber"] as? String ?? data["caller_number"] as? String

    let signedIn = UserDefaults.standard.bool(forKey: "vocivo_voice_signed_in")
    let expiresAt = (data["expiresAt"] as? String).flatMap { value -> Date? in
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    let actionable = signedIn && (expiresAt.map { $0 > Date() } ?? true)
    // Report first, tell JavaScript second. iOS requires the call on screen
    // before this delegate returns, whatever else is or is not running.
    reportIncomingCall(callId: callId, callerName: callerName, callerNumber: callerNumber) { error in
      // Even a stale push must satisfy PushKit's reporting contract. End it
      // immediately and never wake SIP or accept it for a signed-out account.
      guard error == nil, actionable else {
        if error == nil { self.reportCallEnded(callId: callId, reason: "unanswered") }
        completion()
        return
      }
      var body: [String: Any] = ["callId": callId]
      if let callerName = callerName { body["callerName"] = callerName }
      if let callerNumber = callerNumber { body["callerNumber"] = callerNumber }
      if let expiresAt = data["expiresAt"] as? String { body["expiresAt"] = expiresAt }
      self.emit("callUiPushWake", body)
      completion()
    }
  }
}

// MARK: - CallKit

extension VocivoSipCallManager: CXProviderDelegate {
  public func providerDidReset(_ provider: CXProvider) {
    // The system tore every call down; JavaScript must not think otherwise.
    let ids = Array(callIdsByUuid.values)
    pendingAnswers.values.forEach { $0.fail() }
    pendingAnswers.removeAll()
    mirroredActions.removeAll()
    ringingDeadlines.values.forEach { $0.cancel() }
    ringingDeadlines.removeAll()
    outgoingCalls.removeAll()
    connectedCalls.removeAll()
    answeredCalls.removeAll()
    stopRingback()
    audioActive = false
    speakerOverride = false
    RTCAudioSession.sharedInstance().isAudioEnabled = false
    uuidsByCallId.removeAll()
    callIdsByUuid.removeAll()
    ids.forEach { emit("callUiEnd", ["callId": $0]) }
  }

  public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let callId = callIdsByUuid[action.callUUID] else { action.fail(); return }
    ringingDeadlines.removeValue(forKey: callId)?.cancel()
    configureAudioSession()
    pendingAnswers[callId]?.fail()
    pendingAnswers[callId] = action
    emit("callUiAnswer", ["callId": callId])
    // JS resolves this action only after the matching SIP INVITE is accepted.
    // CallKit's own deadline remains authoritative if JS never starts.
  }

  public func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    mirroredActions.removeValue(forKey: action.uuid)
    guard let answer = action as? CXAnswerCallAction,
          let callId = callIdsByUuid[answer.callUUID] else { return }
    pendingAnswers.removeValue(forKey: callId)
    emit("callUiEnd", ["callId": callId])
    reportCallEnded(callId: callId, reason: "failed")
  }

  public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard let callId = callIdsByUuid[action.callUUID] else { action.fulfill(); return }
    emit("callUiEnd", ["callId": callId])
    forget(callId)
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let callId = callIdsByUuid[action.callUUID] else { action.fail(); return }
    // Acknowledging an engine update is not another user command. Correlate
    // by action UUID so even delayed/out-of-order callbacks cannot toggle SIP.
    if mirroredActions.removeValue(forKey: action.uuid) == nil {
      emit("callUiMute", ["callId": callId, "muted": action.isMuted])
    }
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    guard let callId = callIdsByUuid[action.callUUID] else { action.fail(); return }
    if mirroredActions.removeValue(forKey: action.uuid) == nil {
      emit("callUiHold", ["callId": callId, "held": action.isOnHold])
    }
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
    guard let callId = callIdsByUuid[action.callUUID] else { action.fail(); return }
    emit("callUiDtmf", ["callId": callId, "digit": action.digits])
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // Same session as an answered call: voice chat, Bluetooth allowed, so a
    // dialled call routes to the headset the way an incoming one does.
    configureAudioSession()
    action.fulfill()
    // Only now does CallKit know the call exists. Reporting it straight after
    // requesting the transaction — before this ran — was a no-op, so a dialled
    // call sat at zero seconds on the system call screen and in Recents.
    let update = CXCallUpdate()
    update.supportsHolding = true
    update.supportsDTMF = true
    update.supportsGrouping = true
    update.supportsUngrouping = true
    provider.reportCall(with: action.callUUID, updated: update)
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
  }

  public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    let rtc = RTCAudioSession.sharedInstance()
    rtc.audioSessionDidActivate(audioSession)
    rtc.isAudioEnabled = true
    audioActive = true
    // The session CallKit has just handed over is a new one, so a loudspeaker
    // the user chose before it existed — on the CallKit screen, while the
    // INVITE for a pushed call was still on its way — has to be asked for again.
    applySpeakerRoute()
    playRingbackIfReady()
    emit("callUiAudioSession", ["active": true])
  }

  public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    audioActive = false
    ringback?.stop()
    ringback = nil
    let rtc = RTCAudioSession.sharedInstance()
    // CallKit deactivates the session as one leg of a two-call group ends, with
    // the other still talking. Turning WebRTC's audio off on that signal alone
    // is what left the surviving call silent, so it waits for the last call
    // that actually has audio. A call that is merely ringing does not count:
    // WebRTC only rebuilds its audio unit when this permission changes, so
    // leaving it on across a gap where nothing is playing means the next
    // `didActivate` changes nothing and the answered call comes up silent.
    if connectedCalls.isEmpty { rtc.isAudioEnabled = false }
    rtc.audioSessionDidDeactivate(audioSession)
    emit("callUiAudioSession", ["active": false])
  }
}
