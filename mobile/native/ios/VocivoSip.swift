import Foundation
import React

/// The `VocivoSip` React Native module.
///
/// Deliberately thin: it is a wire between JavaScript and
/// `VocivoSipCallManager`, and holds no call state of its own. Everything about
/// SIP — registration, INVITEs, media — happens in JavaScript against Vocivo's
/// own edge, so nothing about a carrier appears anywhere in this file.
@objc(VocivoSip)
final class VocivoSip: RCTEventEmitter {
  override func constantsToExport() -> [AnyHashable: Any]! {
    ["pushEnvironment": VocivoPushEnvironment.current]
  }

  private var listening = false

  override init() {
    super.init()
  }

  override static func requiresMainQueueSetup() -> Bool { true }
  override var methodQueue: DispatchQueue! { DispatchQueue.main }

  override func supportedEvents() -> [String] {
    [
      "callUiAnswer",
      "callUiEnd",
      "callUiMute",
      "callUiHold",
      "callUiDtmf",
      "callUiPushWake",
      "callUiPushToken",
      "callUiAudioSession",
    ]
  }

  override func startObserving() {
    listening = true
  }

  override func stopObserving() {
    listening = false
    VocivoSipCallManager.shared.onEvent = nil
  }

  @objc(startCallUiEvents:rejecter:)
  func startCallUiEvents(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    VocivoSipCallManager.shared.onEvent = { [weak self] name, body in
      self?.sendEvent(withName: name, body: body)
    }
    VocivoSipCallManager.shared.flushPendingEvents()
    resolve(nil)
  }

  @objc(stopCallUiEvents:rejecter:)
  func stopCallUiEvents(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    VocivoSipCallManager.shared.onEvent = nil
    resolve(nil)
  }

  @objc(completeAnswer:resolver:rejecter:)
  func completeAnswer(_ input: NSDictionary, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String else {
      reject("vocivo_sip_bad_call", "completeAnswer needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.completeAnswer(callId: callId, success: input["success"] as? Bool ?? false)
    resolve(nil)
  }

  @objc(reportIncomingCall:resolver:rejecter:)
  func reportIncomingCall(_ input: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String, !callId.isEmpty else {
      reject("vocivo_sip_bad_call", "reportIncomingCall needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.reportIncomingCall(
      callId: callId,
      callerName: input["callerName"] as? String,
      callerNumber: input["callerNumber"] as? String
    ) { error in
      if let error = error {
        reject("vocivo_sip_callkit", error.localizedDescription, error)
      } else {
        resolve(nil)
      }
    }
  }

  @objc(reportOutgoingCall:resolver:rejecter:)
  func reportOutgoingCall(_ input: NSDictionary, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String else {
      reject("vocivo_sip_bad_call", "reportOutgoingCall needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.reportOutgoingCall(callId: callId, handle: input["handle"] as? String ?? "")
    resolve(nil)
  }

  @objc(reportCallConnected:resolver:rejecter:)
  func reportCallConnected(_ callId: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    VocivoSipCallManager.shared.reportCallConnected(callId: callId)
    resolve(nil)
  }

  @objc(reportCallEnded:resolver:rejecter:)
  func reportCallEnded(_ input: NSDictionary, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String else {
      reject("vocivo_sip_bad_call", "reportCallEnded needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.reportCallEnded(callId: callId, reason: input["reason"] as? String ?? "ended")
    resolve(nil)
  }

  @objc(reportMuted:resolver:rejecter:)
  func reportMuted(_ input: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String else {
      reject("vocivo_sip_bad_call", "reportMuted needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.reportMuted(callId: callId, muted: input["muted"] as? Bool ?? false) { error in
      if let error = error { reject("vocivo_callkit_mute", "CallKit could not update mute", error) }
      else { resolve(nil) }
    }
  }

  @objc(reportHeld:resolver:rejecter:)
  func reportHeld(_ input: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String else {
      reject("vocivo_sip_bad_call", "reportHeld needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.reportHeld(callId: callId, held: input["held"] as? Bool ?? false) { error in
      if let error = error { reject("vocivo_callkit_hold", "CallKit could not update hold", error) }
      else { resolve(nil) }
    }
  }

  @objc(setSpeaker:resolver:rejecter:)
  func setSpeaker(_ on: Bool, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    do {
      try VocivoSipCallManager.shared.setSpeaker(on)
      resolve(nil)
    } catch {
      reject("vocivo_sip_audio", error.localizedDescription, error)
    }
  }

  @objc(setRingback:resolver:rejecter:)
  func setRingback(_ input: NSDictionary, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let callId = input["callId"] as? String else {
      reject("vocivo_sip_bad_call", "Ringback needs a callId", nil)
      return
    }
    VocivoSipCallManager.shared.setRingback(callId: callId, enabled: input["enabled"] as? Bool ?? false)
    resolve(nil)
  }

  @objc(setRingtone:resolver:rejecter:)
  func setRingtone(_ sound: NSString?, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    VocivoSipCallManager.shared.setRingtone(sound as String?)
    resolve(true)
  }

  @objc(isCallUiAvailable:rejecter:)
  func isCallUiAvailable(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    resolve(true)
  }

  @objc(voipPushToken:rejecter:)
  func voipPushToken(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    resolve(UserDefaults.standard.string(forKey: "vocivo_voip_push_token"))
  }

  @objc(setVoiceSignedIn:resolver:rejecter:)
  func setVoiceSignedIn(_ signedIn: Bool, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    UserDefaults.standard.set(signedIn, forKey: "vocivo_voice_signed_in")
    if !signedIn {
      // Retire legacy persisted actions without initializing a carrier manager.
      UserDefaults.standard.removeObject(forKey: "pending_voip_push")
      UserDefaults.standard.removeObject(forKey: "pending_voip_action")
    }
    resolve(true)
  }
}
