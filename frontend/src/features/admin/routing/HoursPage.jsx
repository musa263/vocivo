import { useMemo } from "react";
import { CalendarClock, Plus, Save, Trash2 } from "lucide-react";
import { uid } from '../configuration.js';
import { Toggle, PageHeader, Empty } from '../components/ui.jsx';

// Enough of a spread to be usable on a browser too old to enumerate the zones.
const fallbackTimeZones = ['Africa/Cairo', 'Africa/Lagos', 'America/Chicago', 'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Riyadh', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/Berlin', 'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'UTC'];

/**
 * The API accepts any IANA zone, and offering four meant every customer
 * outside them had no matching option: the browser painted the first entry, so
 * the page reported a routing timezone the company does not keep, and one
 * touch of the select saved that over a perfectly correct value. The saved
 * zone is always among the choices, whatever the browser knows.
 */
function timeZoneOptions(current) {
  let zones = fallbackTimeZones;
  try { if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone'); } catch { zones = fallbackTimeZones; }
  return [...new Set([...(current ? [current] : []), ...zones])].sort();
}

export function HoursPage({ config, setConfig, onSave }) {
  const hours = config.officeHours; const setHours = (patch) => setConfig({ ...config, officeHours: { ...hours, ...patch } }); const updateDay = (day, patch) => setHours({ weekdays: { ...hours.weekdays, [day]: { ...hours.weekdays[day], ...patch } } });
  const timeZones = useMemo(() => timeZoneOptions(hours.timezone), [hours.timezone]);
  return <div className="page"><PageHeader eyebrow="ORGANIZATION SCHEDULE" title="Office hours" subtitle="Control open, closed and holiday routing in one timezone."><button className="primary" onClick={onSave}><Save /> Save schedule</button></PageHeader><section className="band"><div className="section-title"><div><h2>Weekly hours</h2><p>Applied to users and routing objects using company hours.</p></div><select value={hours.timezone} onChange={(e) => setHours({ timezone: e.target.value })} aria-label="Office hours timezone">{timeZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div><div className="hours-list">{Object.entries(hours.weekdays).map(([day, value]) => <div key={day}><Toggle value={value.enabled} onChange={(enabled) => updateDay(day, { enabled })} /><strong>{day}</strong>{value.enabled ? <><input type="time" value={value.start} onChange={(e) => updateDay(day, { start: e.target.value })} /><span>to</span><input type="time" value={value.end} onChange={(e) => updateDay(day, { end: e.target.value })} /></> : <span className="closed">Closed</span>}</div>)}</div></section><section className="band"><div className="section-title"><div><h2>Holidays and closures</h2><p>Override normal hours on company dates.</p></div><button className="secondary" onClick={() => setHours({ holidays: [...hours.holidays, { id: uid('holiday'), name: 'Company holiday', date: '', destination: 'Main voicemail' }] })}><Plus /> Add holiday</button></div>{hours.holidays.length ? <div className="compact-table">{hours.holidays.map((h) => <div key={h.id}><input value={h.name} onChange={(e) => setHours({ holidays: hours.holidays.map((x) => x.id === h.id ? { ...x, name: e.target.value } : x) })} /><input type="date" value={h.date} onChange={(e) => setHours({ holidays: hours.holidays.map((x) => x.id === h.id ? { ...x, date: e.target.value } : x) })} /><select value={h.destination} onChange={(e) => setHours({ holidays: hours.holidays.map((x) => x.id === h.id ? { ...x, destination: e.target.value } : x) })}><option>Main voicemail</option><option>Main line</option></select><button className="danger icon-button" onClick={() => setHours({ holidays: hours.holidays.filter((x) => x.id !== h.id) })}><Trash2 /></button></div>)}</div> : <Empty icon={CalendarClock} title="No holiday overrides" copy="Normal weekly hours are currently used all year." />}</section></div>;
}
