import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Building2, ChevronDown, KeyRound, PhoneCall, RefreshCw, Save, ShieldCheck, X } from "lucide-react";
import QRCode from "qrcode";
import { api as request, getStoredSession, storeSession } from "../../shared/api";
import { workspaceApi } from './workspace-api.js';
import { findActiveWorkspace } from './activeWorkspace.js';
import { loadBusinessVoiceSettings } from './voiceSettings.js';
import './admin.css';
import './admin-additions.css';
import WalletsPage from "./WalletsPage";
import { emptyUser, defaultProfile, emptyTrunk, platformNav, customerNav, sectionFeatures } from "./configuration.js";
import { Toggle, Field, Modal, Empty, PageHeader } from "./components/ui.jsx";
import { Dashboard } from "./overview/Dashboard.jsx";
import { UserEditor } from "./users/UserEditor.jsx";
import { UsersPage } from "./users/UsersPage.jsx";
import { VoicePage } from "./ai/VoicePage.jsx";
import { OutboundPage } from "./routing/OutboundPage.jsx";
import { HoursPage } from "./routing/HoursPage.jsx";
import { HandlingPage } from "./routing/HandlingPage.jsx";
import { ReportsPage } from "./diagnostics/ReportsPage.jsx";
import { EventsPage } from "./diagnostics/EventsPage.jsx";
import { DeveloperPage } from "./platform/DeveloperPage.jsx";
import { NumbersPage } from "./numbers/NumbersPage.jsx";
import { TrunksPage } from "./numbers/TrunksPage.jsx";
import { SystemPage } from "./settings/SystemPage.jsx";
import { SecurityPage } from "./settings/SecurityPage.jsx";
import { PlatformDashboard } from "./platform/PlatformDashboard.jsx";
import { OrganizationsPage } from "./platform/OrganizationsPage.jsx";
import { SubscriptionsPage } from "./platform/SubscriptionsPage.jsx";
import { FeatureAccessPage } from "./platform/FeatureAccessPage.jsx";

export default function AdminConsole({ profile }) {
  const isSuperadmin = ['superadmin', 'owner'].includes(profile?.role || '');
  const [section, setSection] = useState(isSuperadmin ? 'platform-dashboard' : 'dashboard'), [overview, setOverview] = useState(null), [extensions, setExtensions] = useState([]), [trunks, setTrunks] = useState(null), [numberData, setNumberData] = useState({ numbers: [], orders: [], messagingProfiles: [] }), [voiceData, setVoiceData] = useState(null), [platformKeys, setPlatformKeys] = useState([]), [revealedToken, setRevealedToken] = useState(''), [events, setEvents] = useState([]), [saas, setSaas] = useState(null), [walletData, setWalletData] = useState(null);
  // Null until the workspace's company voice settings have actually loaded:
  // they do not exist for an individual customer, and an empty draft shown as
  // if they did invites a save the API will refuse.
  const [business, setBusiness] = useState(null);
  const [config, setConfig] = useState(null), [userDraft, setUserDraft] = useState(null), [userProfile, setUserProfile] = useState(defaultProfile), [trunkDraft, setTrunkDraft] = useState(null), [enrollment, setEnrollment] = useState(null), [passwordDraft, setPasswordDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const workspaceRef = useRef(''), loadGeneration = useRef(0);
  const organizationId = config?.activeOrganizationId || '';
  // Stable for as long as the console is showing the same workspace. Rebuilding
  // it on every render re-ran the effects the pages key on `api` — carrier
  // trunks refetched and flashed its loading state on each keystroke, and a
  // refetch that landed mid-switch failed the staleness check and showed
  // "The customer workspace changed" when nothing had gone wrong.
  const api = useMemo(() => workspaceApi(request, organizationId, () => workspaceRef.current === organizationId), [organizationId]);
  async function load(selectedId = organizationId) {
    const generation = ++loadGeneration.current;
    workspaceRef.current = selectedId;
    setBusy(true); setError('');
    setUserDraft(null); setTrunkDraft(null); setEnrollment(null); setRevealedToken('');
    try {
      const safe = (promise, fallback) => promise.catch(() => fallback);
      const [p, s] = await Promise.all([
        request(`/api/admin/pbx${selectedId ? `?organizationId=${encodeURIComponent(selectedId)}` : ''}`),
        request('/api/admin/saas'),
      ]);
      if (generation !== loadGeneration.current) return false;
      const loadedId = p.config.activeOrganizationId;
      workspaceRef.current = loadedId;
      const api = workspaceApi(request, loadedId, () => generation === loadGeneration.current);
      const { organization: activeCustomer } = findActiveWorkspace(s.organizations, p.config.activeOrganizationId);
      const features = activeCustomer?.entitlements || {};
      const allowed = (feature) => isSuperadmin || Boolean(features[feature]);
      // These reads share an already-resolved workspace, not each other's data.
      const [u, w, o, t, n, v, k, b, e] = await Promise.all([
        api('/api/admin/extensions'),
        isSuperadmin ? safe(api('/api/admin/wallets'), null) : null,
        safe(api('/api/admin/overview'), null),
        allowed('sipTrunks') ? safe(api('/api/admin/trunks'), null) : null,
        allowed('phoneNumbers') ? safe(api('/api/admin/numbers'), { numbers: [], orders: [], messagingProfiles: [] }) : { numbers: [], orders: [], messagingProfiles: [] },
        allowed('aiReceptionist') ? safe(api('/api/admin/voices'), null) : null,
        allowed('developerApi') ? safe(api('/api/admin/api-keys'), { keys: [] }) : { keys: [] },
        loadBusinessVoiceSettings(api, allowed('aiReceptionist')),
        allowed('analytics') ? safe(api('/api/admin/events'), { events: [] }) : { events: [] },
      ]);
      if (generation !== loadGeneration.current) return false;
      setConfig(p.config); setSaas(s); setExtensions(u.extensions || []);
      setWalletData(w); setOverview(o); setTrunks(t); setNumberData(n);
      setVoiceData(v); setPlatformKeys(k.keys || []); setEvents(e.events || []);
      setBusiness(b);
      return true;
    } catch (err) {
      if (generation === loadGeneration.current) { workspaceRef.current = organizationId; setError(err.message); }
      return false;
    } finally { if (generation === loadGeneration.current) setBusy(false); }
  }
  useEffect(() => { load(); return () => { loadGeneration.current++; workspaceRef.current = ''; }; }, []);
  if (!config || !saas) return <div className="admin-loading"><RefreshCw /><strong>Loading {isSuperadmin ? 'Vocivo control plane' : 'company phone system'}</strong>{error && <span>{error}</span>}</div>;
  const saveConfig = async (next = config) => { setBusy(true); setError(''); try { const result = await api('/api/admin/pbx', { method: 'PUT', body: next }); setConfig(result.config); return result.config; } catch (err) { setError(err.message); return null; } finally { setBusy(false); } };
  const openUser = (item = emptyUser) => { setUserDraft({ ...item }); const stored = item.id ? config.userProfiles[item.id] || {} : {}; setUserProfile({ ...defaultProfile, ...stored, permissions: { ...defaultProfile.permissions, ...(stored.permissions || {}) } }); };
  const saveUser = async (event) => { event.preventDefault(); setBusy(true); setError(''); try { const editing = Boolean(userDraft.id); const result = await api('/api/admin/extensions', { method: editing ? 'PATCH' : 'POST', body: userDraft }); const saved = result.extension; setUserDraft({ ...userDraft, id: saved.id }); const fresh = await api('/api/admin/pbx'); const p = await api('/api/admin/pbx', { method: 'PUT', body: { ...fresh.config, userProfiles: { ...fresh.config.userProfiles, [saved.id]: { ...userProfile, outboundCallerId: fresh.config.userProfiles[saved.id]?.outboundCallerId || '', did: fresh.config.userProfiles[saved.id]?.did || '' } } } }); setConfig(p.config); setUserDraft(null); await load(); if (!editing) await provisionUser(saved); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const deleteUser = async (item) => { if (!confirm(`Remove ${item.name} and revoke extension ${item.extension}?`)) return; try { await api(`/api/admin/extensions?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await load(); } catch (err) { setError(err.message); } };
  const provisionUser = async (item) => { setBusy(true); try { const result = await api('/api/admin/enrollments', { method: 'POST', body: { extensionId: item.id } }); const qrDataUrl = await QRCode.toDataURL(result.provisioningUri, { width: 440, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0b315b', light: '#ffffff' } }); setEnrollment({ ...result, qrDataUrl }); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const saveBusiness = async () => { setBusy(true); setError(''); try { const result = await api('/api/voice/settings', { method: 'PUT', body: business }); setBusiness(result.config); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const saveAI = async () => { setBusy(true); setError(''); try { const result = await api('/api/admin/ai', { method: 'PUT', body: config.ai }); setConfig((current) => ({ ...current, ai: result.ai })); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const applyVoiceRouting = async () => {
    setBusy(true); setError('');
    try {
      const businessResult = await api('/api/voice/settings', { method: 'PUT', body: business });
      const aiResult = await api('/api/admin/ai', { method: 'PUT', body: config.ai });
      setBusiness(businessResult.config);
      setConfig((current) => ({ ...current, ai: aiResult.ai }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const uploadBackground = async (file) => { if (!file) return; setBusy(true); try { const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); const result = await api('/api/admin/background', { method: 'POST', body: { contentType: file.type, base64 } }); setBusiness({ ...business, backgroundImageUrl: result.url }); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const exportUsers = () => { const csv = ['Extension,Name,Email,Mobile,Department,Role', ...extensions.map((x) => [x.extension, x.name, x.email, x.mobile, x.department, x.role].map((v) => `"${String(v || '').replaceAll('"', '""')}"`).join(','))].join('\n'); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = 'vocivo-users.csv'; a.click(); URL.revokeObjectURL(url); };
  const saveTrunk = async (event) => { event.preventDefault(); setBusy(true); try { await api('/api/admin/trunks', { method: trunkDraft.id ? 'PATCH' : 'POST', body: trunkDraft }); setTrunkDraft(null); await load(); } catch (err) { setError(err.message); setBusy(false); } };
  const deleteTrunk = async (item) => { if (!confirm(`Delete SIP trunk ${item.name}?`)) return; try { await api(`/api/admin/trunks?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await load(); } catch (err) { setError(err.message); } };
  const refreshNumbers = async () => { const [result, pbx] = await Promise.all([api('/api/admin/numbers'), api('/api/admin/pbx')]); setNumberData(result); setConfig(pbx.config); };
  const createApiKey = async () => { const name = prompt('Name this server API key'); if (!name?.trim()) return; try { const result = await api('/api/admin/api-keys', { method: 'POST', body: { name: name.trim() } }); setPlatformKeys((current) => [...current, result.key]); setRevealedToken(result.token); } catch (err) { setError(err.message); } };
  const revokeApiKey = async (item) => { if (!confirm(`Revoke ${item.name}? Existing integrations using it will stop immediately.`)) return; try { const result = await api(`/api/admin/api-keys?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }); setPlatformKeys((current) => current.map((key) => key.id === item.id ? result.key : key)); } catch (err) { setError(err.message); } };
  const changePassword = async (event) => { event.preventDefault(); if (passwordDraft.newPassword !== passwordDraft.confirmPassword) { setError('The new passwords do not match.'); return; } setBusy(true); setError(''); try { const result = await api('/api/auth/password', { method: 'POST', body: { current_password: passwordDraft.currentPassword, new_password: passwordDraft.newPassword } }); if (result.token) storeSession({ ...getStoredSession(), token: result.token }); setPasswordDraft(null); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const { organization: activeCustomer } = findActiveWorkspace(saas.organizations, config.activeOrganizationId);
  const entitlements = activeCustomer?.entitlements || {};
  const sectionAllowed = (id) => isSuperadmin || id === 'voice' ? isSuperadmin || Boolean(entitlements.aiReceptionist) : id === 'handling' ? Boolean(entitlements.queues || entitlements.ivr) : !sectionFeatures[id] || Boolean(entitlements[sectionFeatures[id]]);
  const platformSection = isSuperadmin && ['platform-dashboard', 'organizations', 'subscriptions', 'wallets', 'feature-access'].includes(section);
  const visibleNav = (isSuperadmin ? platformNav : customerNav).map((group) => ({ ...group, items: group.items.filter(([id]) => sectionAllowed(id)) })).filter((group) => group.items.length);
  const saveSaas = async (body) => { setBusy(true); setError(''); try { const result = await api('/api/admin/saas', { method: 'PUT', body }); setSaas(result); return result; } catch (err) { setError(err.message); return null; } finally { setBusy(false); } };
  const saveCustomer = async (draft) => { const result = await saveSaas({ action: 'save_company', ...draft }); if (result) await load(); return Boolean(result); };
  const saveSubscription = async (organizationId, subscription) => Boolean(await saveSaas({ action: 'save_subscription', organizationId, subscription }));
  const saveEntitlements = async (organizationId, features) => Boolean(await saveSaas({ action: 'save_entitlements', organizationId, features }));
  const manageCustomer = async (organizationId) => { if (!busy && await load(organizationId)) setSection('dashboard'); };
  const walletAction = async (body, method = 'PUT') => { setBusy(true); setError(''); try { const result = await api('/api/admin/wallets', { method, body }); setWalletData(result); return true; } catch (err) { setError(err.message); return false; } finally { setBusy(false); } };
  const pages = {
    'platform-dashboard': <PlatformDashboard data={saas} onOpenCustomers={() => setSection('organizations')} onOpenSubscriptions={() => setSection('subscriptions')} />,
    dashboard: <Dashboard overview={overview} extensions={extensions} config={config} events={events} setSection={setSection} customer={activeCustomer} voices={voiceData} />, users: <UsersPage config={config} items={extensions} onAdd={() => openUser()} onEdit={openUser} onDelete={deleteUser} onProvision={provisionUser} onExport={exportUsers} />, numbers: <NumbersPage onOpenTrunks={sectionAllowed('trunks') ? () => setSection('trunks') : undefined} key={organizationId} data={numberData} config={config} extensions={extensions} onRefresh={refreshNumbers} api={api} />,
    voice: business ? <VoicePage business={business} setBusiness={setBusiness} config={config} setConfig={setConfig} voices={voiceData} onApplyRouting={applyVoiceRouting} onSaveAI={saveAI} onUpload={uploadBackground} busy={busy} /> : <div className="page"><PageHeader eyebrow="VOICE AUTOMATION" title="Voice & AI" subtitle="Menu greetings, company audio and the AI receptionist." /><Empty icon={Bot} title="Voice settings are unavailable for this workspace" copy="Greetings, voice menus and the receptionist belong to an active business customer. Refresh the console if this workspace is one." /></div>, outbound: <OutboundPage config={config} setConfig={setConfig} onSave={() => saveConfig()} />,
    hours: <HoursPage config={config} setConfig={setConfig} onSave={() => saveConfig()} />, handling: <HandlingPage config={config} setConfig={setConfig} extensions={extensions} onSave={() => saveConfig()} />, reports: <ReportsPage events={events} />, events: <EventsPage events={events} />,
    organizations: <OrganizationsPage data={saas} selectedId={config.activeOrganizationId} busy={busy} onSave={saveCustomer} onManage={manageCustomer} />, subscriptions: <SubscriptionsPage data={saas} onSave={saveSubscription} busy={busy} />, wallets: <WalletsPage data={walletData} busy={busy} onAction={walletAction} />, 'feature-access': <FeatureAccessPage data={saas} onSave={saveEntitlements} busy={busy} />, trunks: <TrunksPage onInventoryChange={refreshNumbers} data={trunks} api={api} config={config} extensions={extensions} onAdd={() => setTrunkDraft(emptyTrunk)} onEdit={(item) => setTrunkDraft({ ...emptyTrunk, ...item, password: '', policy: { ...emptyTrunk.policy, ...(item.policy || {}) } })} onDelete={deleteTrunk} />, developer: <DeveloperPage data={platformKeys} revealedToken={revealedToken} onCreate={createApiKey} onRevoke={revokeApiKey} onClearToken={() => setRevealedToken('')} />, system: <SystemPage config={config} setConfig={setConfig} overview={overview} onSave={() => saveConfig()} onChangePassword={() => setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' })} isSuperadmin={isSuperadmin} />, security: <SecurityPage onChangePassword={() => setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' })} isSuperadmin={isSuperadmin} />,
  };
  return <section className="admin-console"><aside><div className="admin-brand"><span><PhoneCall /></span><div><strong>{isSuperadmin ? saas.platform?.name || 'Vocivo Communications' : 'Vocivo'}</strong><small>{isSuperadmin ? 'Platform Superadmin' : 'Company Administration'}</small></div></div><div className="tenant"><Building2 /><div><strong>{platformSection ? saas.platform?.name || 'Vocivo Communications' : activeCustomer?.name || config.company.name}</strong><small>{platformSection ? 'Platform owner and commercial operations' : isSuperadmin ? 'Customer workspace · no platform ownership' : `${activeCustomer?.plan?.name || 'Customer'} plan`}</small></div>{isSuperadmin && <ChevronDown />}</div>{visibleNav.map((group) => <div className="nav-group" key={group.group}><p>{group.group}</p>{group.items.map(([id, Icon, label]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}><Icon />{label}</button>)}</div>)}<div className={`nav-health ${overview?.connection?.active ? '' : 'offline'}`}><i /><div><strong>{overview?.connection?.active ? 'Voice platform online' : 'Voice platform attention'}</strong><small>{isSuperadmin ? `${saas.platform?.activeSubscriptions || 0} active customers` : `${activeCustomer?.subscription?.status || 'unknown'} subscription`}</small></div></div></aside><main>{error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}><X /></button></div>}<div className="topbar"><div><span className="top-status"><i /> {isSuperadmin ? 'VOCIVO COMMUNICATIONS SUPERADMIN' : (activeCustomer?.name || config.company.name).toUpperCase()}</span><span>{platformSection ? `${saas.platform?.customers || 0} customers` : `${extensions.length} users`}</span></div><button className="icon-button" title="Refresh system" onClick={() => load()} disabled={busy}><RefreshCw className={busy ? 'spin' : ''} /></button></div>{pages[section] || (isSuperadmin ? pages['platform-dashboard'] : pages.dashboard)}</main>
    {userDraft && <UserEditor api={api} onNumbersSaved={async () => { const result = await api('/api/admin/pbx'); setConfig(result.config); }} draft={userDraft} profile={userProfile} organization={config.organizations.find((item) => item.id === config.activeOrganizationId)} onDraft={setUserDraft} onProfile={setUserProfile} onClose={() => setUserDraft(null)} onSave={saveUser} onProvision={provisionUser} busy={busy} />}
    {enrollment && <Modal title={`Set up ${enrollment.extension.name}`} subtitle={`Extension ${enrollment.extension.extension} · expires in 10 minutes`} onClose={() => setEnrollment(null)}><div className="enrollment"><img src={enrollment.qrDataUrl} alt={`Setup QR for extension ${enrollment.extension.extension}`} /><div><h3>Scan with iPhone Camera</h3><ol><li>Open Camera and scan this QR.</li><li>Tap the Vocivo setup page.</li><li>Tap Open Vocivo to finish.</li></ol><div className="info-strip"><ShieldCheck /><span>The code is single-purpose and never shows the SIP password.</span></div><button className="secondary" onClick={() => navigator.clipboard.writeText(enrollment.provisioningUri)}>Copy setup link</button></div></div></Modal>}
    {passwordDraft && <Modal title="Change administrator password" subtitle="This updates only the currently signed-in account" onClose={() => setPasswordDraft(null)}><form className="modal-form" onSubmit={changePassword}><Field label="Current password"><input type="password" autoComplete="current-password" value={passwordDraft.currentPassword} onChange={(e) => setPasswordDraft({ ...passwordDraft, currentPassword: e.target.value })} required /></Field><Field label="New password" help="At least 10 characters with upper and lowercase letters and a number."><input type="password" autoComplete="new-password" minLength="10" value={passwordDraft.newPassword} onChange={(e) => setPasswordDraft({ ...passwordDraft, newPassword: e.target.value })} required /></Field><Field label="Confirm new password"><input type="password" autoComplete="new-password" minLength="10" value={passwordDraft.confirmPassword} onChange={(e) => setPasswordDraft({ ...passwordDraft, confirmPassword: e.target.value })} required /></Field><footer><button type="button" className="secondary" onClick={() => setPasswordDraft(null)}>Cancel</button><button className="primary" disabled={busy}><KeyRound /> Update password</button></footer></form></Modal>}
    {trunkDraft && <Modal wide title={trunkDraft.id ? `Edit ${trunkDraft.name}` : 'Add SIP trunk'} subtitle="Register an external PBX and define its inbound and outbound policy" onClose={() => setTrunkDraft(null)}><form className="modal-form form-grid" onSubmit={saveTrunk}><Field label="Trunk name"><input value={trunkDraft.name} onChange={(e) => setTrunkDraft({ ...trunkDraft, name: e.target.value })} required /></Field><Field label="Registrar / proxy"><input value={trunkDraft.proxy} onChange={(e) => setTrunkDraft({ ...trunkDraft, proxy: e.target.value })} placeholder="sip:pbx.example.com:5061" required /></Field><Field label="Username"><input value={trunkDraft.username} onChange={(e) => setTrunkDraft({ ...trunkDraft, username: e.target.value })} required /></Field><Field label="Password" help={trunkDraft.id ? 'Leave blank to keep the existing secret.' : 'Stored only by the carrier; never returned to the browser.'}><input type="password" value={trunkDraft.password} onChange={(e) => setTrunkDraft({ ...trunkDraft, password: e.target.value })} required={!trunkDraft.id} /></Field><Field label="Transport"><select value={trunkDraft.transport} onChange={(e) => setTrunkDraft({ ...trunkDraft, transport: e.target.value })}><option>TLS</option><option>TCP</option><option>UDP</option></select></Field><Field label="Telnyx application destination" help="Routes calls received from the PBX into a Telnyx application."><input value={trunkDraft.destinationUri} onChange={(e) => setTrunkDraft({ ...trunkDraft, destinationUri: e.target.value })} placeholder="2000@cc-app-id.sip.telnyx.com" /></Field><Field label="Inbound DIDs" help="Comma-separated public numbers assigned to this route."><input value={(trunkDraft.policy.inboundDids || []).join(', ')} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, inboundDids: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} placeholder="+18447161777" /></Field><Field label="Default inbound destination"><input value={trunkDraft.policy.defaultDestination} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, defaultDestination: e.target.value } })} placeholder="Extension, ring group or SIP URI" /></Field><Field label="Outbound prefix"><input value={trunkDraft.policy.outboundPrefix} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, outboundPrefix: e.target.value } })} placeholder="Optional access code" /></Field><Field label="Route priority"><input type="number" min="1" max="100" value={trunkDraft.policy.priority} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, priority: Number(e.target.value) } })} /></Field><Field label="Channel limit"><input type="number" min="1" max="10000" value={trunkDraft.policy.channelLimit} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, channelLimit: Number(e.target.value) } })} /></Field><Field label="Failover trunk"><select value={trunkDraft.policy.failoverTrunkId} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, failoverTrunkId: e.target.value } })}><option value="">No failover</option>{(trunks?.externalTrunks || []).filter((x) => x.id !== trunkDraft.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field><Field label="Codecs"><input value={(trunkDraft.policy.codecs || []).join(', ')} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, codecs: e.target.value.toUpperCase().split(',').map((x) => x.trim()).filter(Boolean) } })} placeholder="PCMU, PCMA, G722, OPUS" /></Field><Field label="Notes"><input value={trunkDraft.policy.notes} onChange={(e) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, notes: e.target.value } })} /></Field><div className="setting-line wide"><div><strong>Inbound calling</strong><span>Accept calls from this PBX and apply inbound routes.</span></div><Toggle value={trunkDraft.policy.inboundEnabled} onChange={(inboundEnabled) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, inboundEnabled } })} /></div><div className="setting-line wide"><div><strong>Outbound calling</strong><span>Allow this organization to select the trunk in outbound rules.</span></div><Toggle value={trunkDraft.policy.outboundEnabled} onChange={(outboundEnabled) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, outboundEnabled } })} /></div><div className="setting-line wide"><div><strong>Encrypted media</strong><span>Require secure media where supported by both peers.</span></div><Toggle value={trunkDraft.policy.mediaEncryption} onChange={(mediaEncryption) => setTrunkDraft({ ...trunkDraft, policy: { ...trunkDraft.policy, mediaEncryption } })} /></div><footer className="wide"><button type="button" className="secondary" onClick={() => setTrunkDraft(null)}>Cancel</button><button className="primary"><Save /> Save trunk</button></footer></form></Modal>}
  </section>;
}
