import { useEffect, useRef, useState } from "react";
import { Bot, ListFilter, PhoneIncoming, Play, Plus, Save, ShieldCheck, Trash2, Upload } from "lucide-react";
import { apiAudio } from "../../../shared/api";
import { Status, Toggle, PageHeader, Field } from '../components/ui.jsx';

export function VoicePage({ business, setBusiness, config, setConfig, voices, onApplyRouting, onSaveAI, onUpload, busy }) {
  const ai = config.ai;
  const [playingVoice, setPlayingVoice] = useState('');
  const [previewError, setPreviewError] = useState('');
  const audioRef = useRef(null);
  // The preview belongs to the page that started it. Leaving the section or
  // switching to another customer used to leave the previous workspace's
  // greeting playing with nothing on screen to stop it, and its blob held for
  // the life of the tab.
  useEffect(() => () => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (!audio) return;
    audio.pause();
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio.removeAttribute('src');
  }, []);
  const recommendedVoices = (voices?.voices || []).filter((voice) => voice.recommended !== false);
  const otherVoices = (voices?.voices || []).filter((voice) => voice.recommended === false);
  const voiceLabel = (voice) => `${voice.name} · ${voice.gender} · ${voice.accent}${voice.quality ? ` · ${voice.quality}` : ''}`;
  const voiceOptions = <><optgroup label="Recommended Vocivo voices">{recommendedVoices.map((voice) => <option key={voice.id} value={voice.id}>{voiceLabel(voice)}</option>)}</optgroup>{otherVoices.length > 0 && <optgroup label="Other Vocivo voices (noticeably synthetic)">{otherVoices.map((voice) => <option key={voice.id} value={voice.id}>{voiceLabel(voice)}</option>)}</optgroup>}<optgroup label="Carrier fallback voices">{(voices?.carrierFallbacks || []).map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.gender}</option>)}</optgroup></>;
  const previewVoice = async (voice) => {
    if (!voice || playingVoice) return;
    setPreviewError(''); setPlayingVoice(voice);
    const audio = new Audio();
    audioRef.current?.pause();
    audioRef.current = audio;
    // Authorize this audio element during the click so Safari can play the fetched preview.
    audio.src = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgA==';
    audio.volume = 0;
    const unlock = audio.play().catch(() => undefined);
    try {
      const url = await apiAudio(`/api/admin/voices?preview=1&voice=${encodeURIComponent(voice)}`);
      await unlock;
      audio.pause();
      audio.src = url;
      audio.volume = 1;
      audio.onended = () => { URL.revokeObjectURL(url); setPlayingVoice(''); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlayingVoice(''); setPreviewError('This voice preview could not be played.'); };
      await audio.play();
    } catch (error) { audio.pause(); setPlayingVoice(''); setPreviewError(error instanceof Error ? error.message : 'This voice preview could not be played.'); }
  };
  const knownVoice = (value) => [...(voices?.voices || []), ...(voices?.carrierFallbacks || [])].some((voice) => voice.id === value);
  // A voice chosen before the catalog changed is shown for what it is rather
  // than silently displayed as the first option in the list.
  const voiceField = (label, value, onChange, help) => <Field label={label} help={help}><div className="voice-select"><select value={value} onChange={(e) => onChange(e.target.value)}>{value && !knownVoice(value) && <option value={value}>{value} · legacy voice, callers hear Amina</option>}{voiceOptions}</select><button type="button" className="secondary" disabled={!value || Boolean(playingVoice) || !knownVoice(value)} onClick={() => previewVoice(value)} title="Play selected voice"><Play />{playingVoice === value ? 'Playing' : 'Preview'}</button></div></Field>;
  return <div className="page"><PageHeader eyebrow="VOICE AUTOMATION" title="Voice & AI" subtitle="Direct ringing, IVR menus, an interactive receptionist and company audio."><button className="primary" onClick={onApplyRouting} disabled={busy}><Save /> Apply routing</button></PageHeader>
    <section className="band"><div className="section-title"><div><h2>Inbound mode</h2><p>Choose exactly how the company number answers.</p></div></div><div className="mode-selector"><button className={!business.enabled && !ai.enabled ? 'active' : ''} onClick={() => { setBusiness({ ...business, enabled: false }); setConfig({ ...config, ai: { ...ai, enabled: false } }); }}><PhoneIncoming /><strong>Direct</strong><span>Ring staff immediately</span></button><button className={business.enabled && !ai.enabled ? 'active' : ''} onClick={() => { setBusiness({ ...business, enabled: true }); setConfig({ ...config, ai: { ...ai, enabled: false } }); }}><ListFilter /><strong>Voice menu</strong><span>Divisions and extensions</span></button><button className={ai.enabled ? 'active' : ''} onClick={() => { setBusiness({ ...business, enabled: false }); setConfig({ ...config, ai: { ...ai, enabled: true } }); }}><Bot /><strong>AI receptionist</strong><span>Natural conversation</span></button></div></section>
    <section className="band"><div className="section-title"><div><h2>Interactive AI receptionist</h2><p>Vocivo listens, answers approved questions and can guide callers to a human.</p></div><Toggle value={ai.enabled} label={ai.enabled ? 'Enabled' : 'Disabled'} onChange={(enabled) => { if (enabled) setBusiness({ ...business, enabled: false }); setConfig({ ...config, ai: { ...ai, enabled } }); }} /></div><div className="form-grid"><Field label="Assistant name"><input value={ai.name} onChange={(e) => setConfig({ ...config, ai: { ...ai, name: e.target.value } })} /></Field><Field label="Fallback extension"><input value={ai.fallbackExtension} onChange={(e) => setConfig({ ...config, ai: { ...ai, fallbackExtension: e.target.value.replace(/\D/g, '') } })} /></Field>{voiceField('Voice', ai.voice, (voice) => setConfig({ ...config, ai: { ...ai, voice } }), 'Choose a voice, preview it, then save. The preview is rendered by the same engine callers hear.') }<Field label="Language"><select value={ai.language} onChange={(e) => setConfig({ ...config, ai: { ...ai, language: e.target.value } })}><option value="en">English</option><option value="ar">Arabic</option><option value="fr">French</option><option value="es">Spanish</option></select></Field><Field label="Opening greeting" wide><textarea rows="3" value={ai.greeting} onChange={(e) => setConfig({ ...config, ai: { ...ai, greeting: e.target.value } })} /></Field><Field label="Assistant behavior" wide><textarea rows="5" value={ai.instructions} onChange={(e) => setConfig({ ...config, ai: { ...ai, instructions: e.target.value } })} /></Field><Field label="Approved company knowledge" wide help="Services, office information and FAQs. The assistant is instructed to stay within this source."><textarea rows="7" value={ai.knowledge} onChange={(e) => setConfig({ ...config, ai: { ...ai, knowledge: e.target.value } })} /></Field></div>{previewError && <div className="info-strip voice-error"><ShieldCheck /><span>{previewError}</span></div>}{[['transferEnabled', 'Human escalation', 'Offer to connect the caller when AI cannot answer.'], ['summariesEnabled', 'Conversation summaries', 'Create Vocivo post-call insights.']].map(([key, title, copy]) => <div className="setting-line" key={key}><div><strong>{title}</strong><span>{copy}</span></div><Toggle value={ai[key]} onChange={(value) => setConfig({ ...config, ai: { ...ai, [key]: value } })} /></div>)}<div className="section-footer"><Status good={voices?.engine === 'vocivo' ? Boolean(voices?.provider?.healthy) : Boolean(ai.assistantId)} warn={voices?.engine === 'vocivo' ? !voices?.provider?.healthy : !ai.assistantId}>{voices?.engine === 'vocivo' ? (voices?.provider?.healthy ? 'Vocivo receptionist live' : 'Voice engine unavailable') : (ai.assistantId ? 'Vocivo AI ready' : 'Not synchronized')}</Status><button className="primary" onClick={onSaveAI} disabled={busy}><Bot /> {voices?.engine === 'vocivo' ? 'Save receptionist' : 'Save and synchronize AI'}</button></div></section>
    <section className="band"><div className="section-title"><div><h2>Classic IVR and company sound</h2><p>Used when Voice menu is selected.</p></div><Status good={voices?.provider?.healthy} warn={!voices?.provider?.healthy}>{voices?.provider?.healthy ? 'Vocivo voice online' : voices?.provider?.configured ? 'Voice service unavailable' : 'Carrier fallback active'}</Status></div><div className="form-grid"><Field label="Company name"><input value={business.companyName || ''} onChange={(e) => setBusiness({ ...business, companyName: e.target.value })} /></Field>{voiceField('Voice', business.voice || '', (voice) => setBusiness({ ...business, voice }), 'Preview the exact voice before applying the IVR routing.') }<Field label="Welcome message" wide><textarea rows="3" value={business.greeting || ''} onChange={(e) => setBusiness({ ...business, greeting: e.target.value })} /></Field><Field label="Message while waiting" wide><textarea rows="3" value={business.waitingMessage || ''} onChange={(e) => setBusiness({ ...business, waitingMessage: e.target.value })} /></Field></div><div className="department-grid">{(business.departments || []).map((name, index) => <div key={index}><span>{index + 1}</span><input value={name} onChange={(e) => setBusiness({ ...business, departments: business.departments.map((x, i) => i === index ? e.target.value : x) })} />{business.departments.length > 2 && <button onClick={() => setBusiness({ ...business, departments: business.departments.filter((_, i) => i !== index) })}><Trash2 /></button>}</div>)}{business.departments?.length < 5 && <button className="add-tile" onClick={() => setBusiness({ ...business, departments: [...business.departments, ''] })}><Plus /> Add division</button>}</div><div className="branding-row"><div className="brand-preview" style={business.backgroundImageUrl ? { backgroundImage: `linear-gradient(rgba(5,29,55,.42),rgba(5,29,55,.72)),url(${business.backgroundImageUrl})` } : undefined}><strong>Ready for incoming calls</strong><span>{business.companyName}</span></div><label className="upload-control"><Upload /> Upload home background<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => onUpload(e.target.files?.[0])} /></label></div></section>
  </div>;
}
