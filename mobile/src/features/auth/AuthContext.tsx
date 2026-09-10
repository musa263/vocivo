import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { api } from '../../shared/api';
import type { CallerNumber, CallLog, CallRate, Profile } from '../../shared/types';
import { fallbackRates } from '../billing/data/fallbackRates';
import { setVoiceSignedIn, signOutVoiceDevice } from '../calling/runtime/voipClient';
import { unregisterVocivoSip } from '../calling/runtime/sipNative';
import { normalizeHistoryIdentity } from '../calling/engine/historyIdentity';
import { clearSessionSnapshot, readSessionSnapshot, saveSessionSnapshot } from './sessionSnapshot';
import { colors } from '../../shared/theme';

type AuthContextValue = {
  loading: boolean;
  isAuthenticated: boolean;
  profile: Profile | null;
  rates: CallRate[];
  callerNumbers: CallerNumber[];
  history: CallLog[];
  signIn: (email: string, password: string) => Promise<void>;
  enrollWithQr: (token: string) => Promise<void>;
  signInWithPhone: (challengeId: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  addHistory: (call: CallLog) => Promise<void>;
  updateProfile: (input: { fullName: string; jobTitle: string; department: string; mobile: string; location: string; bio: string; photo?: { base64: string; mimeType: string } }) => Promise<void>;
};

type LoginResponse = { token: string; profile: Omit<Profile, 'balance'> };
type SessionResponse = { profile: Omit<Profile, 'balance'> };
type AccountResponse = { balance: number | null; currency: string; rates: CallRate[]; can_call?: boolean };
type HistoryResponse = { calls: CallLog[] };
type DirectoryResponse = { users: Array<{ id: string; extension: string; name: string; sipUsername: string }> };
type UserProfileResponse = { profile: { id: string; fullName: string; email: string; jobTitle: string; department: string; mobile: string; location: string; bio: string; photoUrl?: string } };
type BootstrapResponse = {
  profile: Omit<Profile, 'balance'>;
  account: AccountResponse;
  numbers: CallerNumber[];
  directory: DirectoryResponse['users'];
  calls: CallLog[];
};

function mobileProfile(value: UserProfileResponse['profile']): Omit<Profile, 'balance' | 'currency'> {
  return { id: value.id, email: value.email, full_name: value.fullName, photo_url: value.photoUrl, job_title: value.jobTitle, department: value.department, mobile: value.mobile, location: value.location, bio: value.bio };
}

/**
 * Every country, with the server's rates laid over the ones it names.
 *
 * The server's table lists only the destinations it has a price for, and it
 * used to replace the directory outright — so a country it had no line for,
 * the United Arab Emirates among them, could not be searched or dialled at
 * all. The web app has always merged; the phone now does the same.
 */
function normalizeRates(values: CallRate[]) {
  const known = new Map<string, CallRate>();
  for (const rate of values) {
    if (!rate?.id || !/^[A-Z]{2}$/.test(rate.country_code) || !/^\+\d{1,4}$/.test(rate.dial_code) || known.has(rate.country_code)) continue;
    known.set(rate.country_code, { ...rate, rate_per_min: Number(rate.rate_per_min) || 0 });
  }
  return fallbackRates.map((fallback) => {
    const rate = known.get(fallback.country_code);
    return rate ? { ...fallback, ...rate, id: fallback.id, flag: fallback.flag } : fallback;
  });
}

const legacyHistoryKey = 'vocivo.secure-history';
const historyKey = (userId: string) => `vocivo.history.v3.${userId}`;
const AuthContext = createContext<AuthContextValue | null>(null);

function initialProfile(baseProfile: Omit<Profile, 'balance'>): Profile {
  if (!baseProfile.id) throw new Error('Account identity was not returned.');
  if (baseProfile.admin_only) throw new Error('This administrator account uses the Vocivo web portal. Assign a calling extension before using the mobile app.');
  return { ...baseProfile, balance: null, currency: baseProfile.currency || 'USD' };
}

async function readHistory(userId: string) {
  const scopedKey = historyKey(userId);
  const value = await AsyncStorage.getItem(scopedKey) ?? (userId === 'vocivo-owner' ? await SecureStore.getItemAsync(legacyHistoryKey) : null);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as CallLog[];
    await AsyncStorage.setItem(scopedKey, JSON.stringify(parsed));
    return parsed;
  } catch { return []; }
}

function mergeHistory(local: CallLog[], server: CallLog[]) {
  const result: CallLog[] = [];
  for (const item of [...local, ...server].sort((a, b) => b.started_at.localeCompare(a.started_at))) {
    const digits = /^\+?[\d ().-]+$/.test(item.destination_number) ? item.destination_number.replace(/\D/g, '') : '';
    const started = new Date(item.started_at).getTime();
    // A row with no direction matches either way: older locally logged calls
    // were written without one, and refusing to match them left every call in
    // Recents twice once the server's copy arrived.
    const sameDirection = (candidate: CallLog) => !candidate.direction || !item.direction || candidate.direction === item.direction;
    const duplicateIndex = result.findIndex((candidate) => candidate.id === item.id || Boolean(digits && /^\+?[\d ().-]+$/.test(candidate.destination_number) && sameDirection(candidate) && candidate.destination_number.replace(/\D/g, '') === digits && Math.abs(new Date(candidate.started_at).getTime() - started) < 30_000));
    if (duplicateIndex < 0) {
      result.push(item);
    } else {
      const existing = result[duplicateIndex];
      if (existing && item.destination_name && !existing.destination_name) result[duplicateIndex] = { ...existing, ...item };
    }
  }
  return result.slice(0, 100);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rates, setRates] = useState<CallRate[]>(fallbackRates);
  const [callerNumbers, setCallerNumbers] = useState<CallerNumber[]>([]);
  const [history, setHistory] = useState<CallLog[]>([]);
  const historyRef = useRef<CallLog[]>([]);
  const directoryRef = useRef<DirectoryResponse['users']>([]);
  const activeUserIdRef = useRef<string | null>(null);
  const [nativeBridgeError, setNativeBridgeError] = useState<Error | null>(null);
  const authEpochRef = useRef(0);
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logFailure = (operation: string, failure: unknown) => console.warn(`[Vocivo Auth] ${operation}`, { name: failure instanceof Error ? failure.name : 'UnknownError' });

  // Named rather than inlined in the effect so the banner can offer a retry:
  // this used to be rethrown from render, and the launch boundary's "try again"
  // re-rendered the provider, which threw again with no way back into the app.
  const syncNativeVoiceState = useCallback(() => {
    if (loading) return;
    setVoiceSignedIn(isAuthenticated)
      .then(() => setNativeBridgeError(null))
      .catch((failure) => {
        const error = failure instanceof Error ? failure : new Error(String(failure));
        console.error('[Vocivo Auth] native voice state synchronization failed', { message: error.message, stack: error.stack });
        setNativeBridgeError(error);
      });
  }, [isAuthenticated, loading]);

  useEffect(() => { syncNativeVoiceState(); }, [syncNativeVoiceState]);

  const refreshServerHistory = useCallback(async (userId: string, directory: DirectoryResponse['users']) => {
    const server = await api.get<HistoryResponse>('/api/voice/history');
    if (activeUserIdRef.current !== userId) return;
    const merged = mergeHistory(
      historyRef.current.map((call) => normalizeHistoryIdentity(call, directory)),
      (server.calls ?? []).map((call) => normalizeHistoryIdentity(call, directory)),
    );
    historyRef.current = merged;
    setHistory(merged);
    await AsyncStorage.setItem(historyKey(userId), JSON.stringify(merged));
  }, []);

  const loadAccount = useCallback(async (baseProfile?: Omit<Profile, 'balance'>) => {
    if (!baseProfile) throw new Error('Account identity was not returned.');
    const basicProfile = initialProfile(baseProfile);
    const epoch = authEpochRef.current;
    activeUserIdRef.current = baseProfile.id;
    try {
      const bootstrap = await api.get<BootstrapResponse>('/api/mobile/bootstrap');
      if (epoch !== authEpochRef.current || activeUserIdRef.current !== baseProfile.id) return;
      const mergedProfile = { ...baseProfile, ...bootstrap.profile };
      setProfile({ ...mergedProfile, balance: bootstrap.account.balance == null ? null : Number(bootstrap.account.balance), can_call: bootstrap.account.can_call !== false, currency: bootstrap.account.currency });
      if (bootstrap.account.rates?.length) setRates(normalizeRates(bootstrap.account.rates));
      setCallerNumbers(bootstrap.numbers ?? []);
      const storedHistory = await readHistory(mergedProfile.id);
      if (epoch !== authEpochRef.current || activeUserIdRef.current !== baseProfile.id) return;
      directoryRef.current = bootstrap.directory || [];
      const mergedHistory = mergeHistory(
        storedHistory.map((call) => normalizeHistoryIdentity(call, directoryRef.current)),
        (bootstrap.calls ?? []).map((call) => normalizeHistoryIdentity(call, directoryRef.current)),
      );
      historyRef.current = mergedHistory;
      setHistory(mergedHistory);
      await AsyncStorage.setItem(historyKey(mergedProfile.id), JSON.stringify(mergedHistory));
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = setTimeout(() => {
        if (epoch === authEpochRef.current) void refreshServerHistory(mergedProfile.id, bootstrap.directory || []).catch(failure => logFailure('history refresh', failure));
      }, 5_000);
      return;
    } catch (failure) {
      logFailure('account refresh', failure);
      const storedHistory = await readHistory(baseProfile.id);
      if (epoch !== authEpochRef.current || activeUserIdRef.current !== baseProfile.id) return;
      setProfile({ ...basicProfile, can_call: false });
      setCallerNumbers([]);
      historyRef.current = storedHistory;
      setHistory(storedHistory);
      return;
    }
  }, [refreshServerHistory]);

  useEffect(() => {
    const epoch = ++authEpochRef.current;
    let cached = false;
    const restore = async () => {
      try {
        const token = await api.getSessionToken();
        if (!token || epoch !== authEpochRef.current) return;
        const snapshot = await readSessionSnapshot(token).catch(failure => { logFailure('read account snapshot', failure); return null; });
        if (epoch !== authEpochRef.current) return;
        if (snapshot) {
          cached = true;
          activeUserIdRef.current = snapshot.id;
          setProfile(initialProfile(snapshot));
          setAuthenticated(true);
          setLoading(false);
        }
        const session = await api.get<SessionResponse>('/api/auth/session');
        if (epoch !== authEpochRef.current) return;
        setProfile(initialProfile(session.profile));
        setAuthenticated(true);
        setLoading(false);
        void saveSessionSnapshot(token, session.profile).catch(failure => logFailure('save account snapshot', failure));
        void loadAccount(session.profile).catch(failure => logFailure('account bootstrap', failure));
      } catch (restoreError) {
        if (epoch !== authEpochRef.current) return;
        // Only discard the stored token when the server rejected it; a network
        // or server outage at launch must not sign the user out.
        const status = (restoreError as { status?: number } | null)?.status;
        if (status !== 401 && status !== 403 && cached) { logFailure('session revalidation deferred', restoreError); return; }
        activeUserIdRef.current = null;
        setAuthenticated(false);
        setProfile(null);
        if (status === 401 || status === 403) {
          ++authEpochRef.current;
          await Promise.all([api.clearSessionToken(), clearSessionSnapshot()]);
        }
      } finally {
        if (epoch === authEpochRef.current || !cached) setLoading(false);
      }
    };
    restore();
    return () => { ++authEpochRef.current; if (historyTimerRef.current) clearTimeout(historyTimerRef.current); };
  }, [loadAccount]);

  const signIn = useCallback(async (email: string, password: string) => {
    ++authEpochRef.current;
    setLoading(true);
    try {
      const result = await api.post<LoginResponse>('/api/auth/login', { email: email.trim(), password });
      await api.saveSessionToken(result.token);
      void saveSessionSnapshot(result.token, result.profile).catch(failure => logFailure('save account snapshot', failure));
      setProfile(initialProfile(result.profile));
      setAuthenticated(true);
      setLoading(false);
      void loadAccount(result.profile).catch(() => undefined);
    } catch (error) {
      await api.clearSessionToken();
      setAuthenticated(false);
      setProfile(null);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [loadAccount]);

  const enrollWithQr = useCallback(async (token: string) => {
    ++authEpochRef.current;
    setLoading(true);
    try {
      const result = await api.post<LoginResponse>('/api/auth/enroll', { token });
      await api.saveSessionToken(result.token);
      void saveSessionSnapshot(result.token, result.profile).catch(failure => logFailure('save account snapshot', failure));
      setProfile(initialProfile(result.profile));
      setAuthenticated(true);
      setLoading(false);
      void loadAccount(result.profile).catch(() => undefined);
    } catch (error) {
      await api.clearSessionToken();
      setAuthenticated(false);
      setProfile(null);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [loadAccount]);

  const signOut = useCallback(async () => {
    // Both revocations have to reach the server while this session's bearer
    // token still authenticates them, and both used to be started rather than
    // awaited: the token was cleared underneath them, the SIP credential DELETE
    // was skipped because the cached session no longer matched, and the local
    // cache was then thrown away so it could never be retried. A seven-day
    // Digest password stayed valid on Kamailio for a handset that had signed
    // out, and the push registration went on ringing it.
    await unregisterVocivoSip().catch((failure) => {
      console.warn('[Vocivo Auth] SIP credential revocation failed', failure);
    });
    await signOutVoiceDevice();
    ++authEpochRef.current;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    setAuthenticated(false);
    setProfile(null);
    activeUserIdRef.current = null;
    setCallerNumbers([]);
    historyRef.current = [];
    setHistory([]);
    await api.clearSessionToken();
    await clearSessionSnapshot();
  }, []);

  const signInWithPhone = useCallback(async (challengeId: string, code: string) => {
    ++authEpochRef.current;
    const result = await api.post<LoginResponse>('/api/auth/phone', { step: 'verify', challengeId, code });
    if (result.profile.account_type !== 'individual' || result.profile.role !== 'individual') throw new Error('Individual account verification failed.');
    const next = initialProfile(result.profile);
    await api.saveSessionToken(result.token);
    void saveSessionSnapshot(result.token, result.profile).catch(failure => logFailure('save account snapshot', failure));
    setProfile(next);
    setAuthenticated(true);
    void loadAccount(result.profile).catch(() => console.warn('[Vocivo Auth] Account refresh failed.'));
  }, [loadAccount]);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    const session = await api.get<SessionResponse>('/api/auth/session');
    await loadAccount(session.profile);
    await refreshServerHistory(session.profile.id, directoryRef.current).catch(() => undefined);
  }, [isAuthenticated, loadAccount, refreshServerHistory]);

  const addHistory = useCallback(async (call: CallLog) => {
    const next = [normalizeHistoryIdentity(call, directoryRef.current), ...historyRef.current.filter((item) => item.id !== call.id)].slice(0, 100);
    historyRef.current = next;
    setHistory(next);
    if (profile?.id) await AsyncStorage.setItem(historyKey(profile.id), JSON.stringify(next));
  }, [profile?.id]);

  const updateProfile = useCallback(async (input: { fullName: string; jobTitle: string; department: string; mobile: string; location: string; bio: string; photo?: { base64: string; mimeType: string } }) => {
    const result = await api.put<UserProfileResponse>('/api/auth/profile', input);
    setProfile((current) => current ? { ...current, ...mobileProfile(result.profile) } : current);
  }, []);

  const value = useMemo(() => ({ loading, isAuthenticated, profile, rates, callerNumbers, history, signIn, enrollWithQr, signInWithPhone, signOut, refresh, addHistory, updateProfile }), [addHistory, callerNumbers, enrollWithQr, signInWithPhone, history, isAuthenticated, loading, profile, rates, refresh, signIn, signOut, updateProfile]);
  // Thrown from render, this reached the launch boundary, whose "Try again"
  // re-rendered this provider — which threw the same error again, with no way
  // out but force-quitting the app. The failure is worth saying out loud, but
  // it is not worth the app: the rest of Vocivo works without the native
  // calling bridge, so it is shown as something to retry or put aside.
  return (
    <AuthContext.Provider value={value}>
      <View style={styles.host}>
        {nativeBridgeError ? (
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>Calling could not be set up on this device</Text>
            <Text style={styles.bannerBody}>{nativeBridgeError.message}</Text>
            <View style={styles.bannerActions}>
              <Pressable accessibilityLabel="Retry calling setup" onPress={syncNativeVoiceState} style={styles.bannerButton}>
                <Text style={styles.bannerButtonText}>Try again</Text>
              </Pressable>
              <Pressable accessibilityLabel="Dismiss calling setup warning" onPress={() => setNativeBridgeError(null)} style={styles.bannerDismiss}>
                <Text style={styles.bannerDismissText}>Dismiss</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {children}
      </View>
    </AuthContext.Provider>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  banner: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.panelRaised, borderBottomWidth: 1, borderBottomColor: colors.coral },
  bannerTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  bannerBody: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  bannerActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  bannerButton: { height: 32, paddingHorizontal: 14, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue },
  bannerButtonText: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  bannerDismiss: { height: 32, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  bannerDismissText: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
});

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
