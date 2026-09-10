import { NativeModules, Platform } from 'react-native';

// Shared identity and push controls belong to Vocivo. Native carrier call UI
// and Android ringtone methods remain compatibility-only in this migration slice.
type VocivoControls = {
  voipPushToken(): Promise<string | null>;
  firebasePushToken(): Promise<string | null>;
  setVoiceSignedIn(value: boolean): Promise<boolean>;
  /** iOS: rebuilds the CallKit provider around the chosen ringtone. */
  setRingtone?(value: string): Promise<boolean>;
};
function vocivo(): VocivoControls {
  const native = NativeModules.VocivoSip as VocivoControls | undefined;
  if (!native?.setVoiceSignedIn) throw new Error('Install the latest Vocivo build to enable native calling controls.');
  return native;
}
export const setNativeVoiceSignedIn = (value: boolean) => vocivo().setVoiceSignedIn(value);

type Bridge = {
  getVoipToken(): Promise<string | null>;
  getFirebaseToken(): Promise<string | null>;
  setIncomingCallRingtone(value: string): Promise<boolean>;
  isSpeakerEnabled(): Promise<boolean>;
  setSpeakerEnabled(value: boolean): Promise<boolean>;
  endCall(id: string): Promise<boolean>;
  hideIncomingCallNotification(): Promise<boolean>;
  setVocivoVoiceSignedIn(value: boolean): Promise<boolean>;
};
function bridge(): Bridge {
  if (!NativeModules.VoicePnBridge) throw new Error('Native calling controls are unavailable in this build.');
  return NativeModules.VoicePnBridge as Bridge;
}

export const VoicePnBridge = {
  getVoipToken: async () => Platform.OS === 'ios' ? vocivo().voipPushToken() : null,
  getFirebaseToken: async () => Platform.OS === 'android' ? vocivo().firebasePushToken() : null,
  clearManagedSession: () => bridge().setVocivoVoiceSignedIn(false),
  // Android keeps the installed SDK's contract; iOS goes to Vocivo's own CallKit
  // provider, whose configuration is where a ringtone lives. This used to answer
  // `true` on iOS without doing anything, so the settings screen confirmed a
  // choice that the incoming-call screen went on ignoring.
  setIncomingCallRingtone: async (value: string) => {
    if (Platform.OS === 'android') return bridge().setIncomingCallRingtone(value);
    const setRingtone = vocivo().setRingtone;
    if (!setRingtone) throw new Error('Install the latest Vocivo build to change the incoming call ringtone.');
    return setRingtone.call(vocivo(), value);
  },
  endCall: (id: string) => bridge().endCall(id),
  hideIncomingCallNotification: () => bridge().hideIncomingCallNotification(),
  toggleSpeaker: async () => {
    const native = bridge();
    const desired = !await native.isSpeakerEnabled();
    return native.setSpeakerEnabled(desired);
  },
};
