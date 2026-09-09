import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Bot,
  Building2,
  Check,
  ChevronRight,
  CircleDollarSign,
  Cloud,
  Database,
  Gauge,
  Globe2,
  Headphones,
  KeyRound,
  Layers3,
  LockKeyhole,
  Menu,
  MessageSquareText,
  Mic2,
  Network,
  Phone,
  PhoneCall,
  Route,
  ServerCog,
  ShieldCheck,
  Sparkles,
  UserCog,
  Users,
  Video,
  Workflow,
  X,
} from 'lucide-react';
import './landing.css';

const pagePath = {
  home: '/landing',
  platform: '/platform',
  business: '/business',
  why: '/why-vocivo',
  pricing: '/pricing',
  security: '/security',
  contact: '/contact',
};

const capabilities = [
  { icon: PhoneCall, title: 'Global voice', copy: 'Personal and business calling across mobile, browser and compatible SIP environments.' },
  { icon: Network, title: 'Company extensions', copy: 'Private extension calling, transfer, hold, call waiting and colleague-to-colleague conversations.' },
  { icon: Users, title: 'Meetings and conferences', copy: 'Add, merge and manage participants with clear controls for every active line.' },
  { icon: Bot, title: 'Intelligent reception', copy: 'Create greetings, voice menus, call routing and assisted customer conversations.' },
  { icon: MessageSquareText, title: 'Business messaging', copy: 'Keep customer and team conversations organized across dedicated threads.' },
  { icon: Video, title: 'Video collaboration', copy: 'Move naturally from voice to face-to-face conversations on supported devices.' },
];

const planData = [
  {
    id: 'launch', name: 'Launch', monthly: 39, annual: 390, members: 10, calls: 4,
    description: 'A complete company phone workspace for a focused team.',
    features: ['10 team members', '4 active calls', 'Extensions and transfers', 'Web and mobile access', 'Voicemail and office hours'],
  },
  {
    id: 'operate', name: 'Operate', monthly: 129, annual: 1290, members: 50, calls: 16, featured: true,
    description: 'More routing, capacity and control for an active operation.',
    features: ['50 team members', '16 active calls', 'Queues and ring groups', 'Conference controls', 'Configurable voice menus'],
  },
  {
    id: 'scale', name: 'Scale', monthly: 349, annual: 3490, members: 200, calls: 50,
    description: 'A multi-team communications layer with advanced governance.',
    features: ['200 team members', '50 active calls', 'Multiple departments', 'Advanced administration', 'API and SIP controls'],
  },
];

function Brand() {
  return <a className="landing-brand" href={pagePath.home} aria-label="Vocivo home"><img src="/vocivo-icon-192.png" alt="" /><span>Vocivo</span></a>;
}

function SiteHeader({ current }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const links = [['platform', 'Platform'], ['business', 'Business'], ['why', 'Why Vocivo'], ['pricing', 'Pricing'], ['security', 'Security']];
  return <header className="landing-header">
    <Brand />
    <nav className={menuOpen ? 'landing-nav open' : 'landing-nav'} aria-label="Primary navigation">
      {links.map(([id, label]) => <a key={id} className={current === id ? 'active' : ''} href={pagePath[id]} onClick={close}>{label}</a>)}
      <a className="nav-contact" href={pagePath.contact} onClick={close}>Contact</a>
      <a className="nav-login" href="/">Sign in</a>
      <a className="nav-cta" href={pagePath.contact}>Talk to our team <ArrowRight size={16} /></a>
    </nav>
    <button className="menu-button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}>{menuOpen ? <X /> : <Menu />}</button>
  </header>;
}

function SiteFooter() {
  return <footer className="landing-footer">
    <div className="footer-brand"><Brand /><p>Connect. Talk. Anywhere.</p><small>One modern workspace for personal and business communications.</small></div>
    <div className="footer-column"><strong>Product</strong><a href={pagePath.platform}>Platform</a><a href={pagePath.business}>Business</a><a href={pagePath.pricing}>Pricing</a></div>
    <div className="footer-column"><strong>Company</strong><a href={pagePath.why}>Why Vocivo</a><a href={pagePath.security}>Security</a><a href={pagePath.contact}>Contact</a></div>
    <div className="footer-column"><strong>Access</strong><a href="/">Web phone</a><a href="/admin">Administration</a><a href={pagePath.contact}>Request a demo</a></div>
    <div className="footer-legal"><span>Copyright {new Date().getFullYear()} Vocivo. All rights reserved.</span><span>Telecom usage and availability vary by destination and carrier.</span></div>
  </footer>;
}

function PageShell({ page, children }) {
  return <div className={`landing-page page-${page}`}><SiteHeader current={page} /><main>{children}</main><SiteFooter /></div>;
}

function SectionHeading({ eyebrow, title, copy, align = 'center' }) {
  return <div className={`section-intro ${align === 'left' ? 'left' : ''}`}><p className="section-label">{eyebrow}</p><h2>{title}</h2>{copy && <p>{copy}</p>}</div>;
}

function ProductStage() {
  return <div className="product-stage" aria-label="Vocivo active call interface preview">
    <div className="product-topbar"><span><img src="/vocivo-icon-192.png" alt="" /> VOCIVO VOICE</span><em>HD</em></div>
    <div className="product-call"><span className="call-avatar"><Building2 /></span><p>NORTHWIND SAMPLE CO</p><h3>Avery Sample · Extension 1200</h3><strong>CONNECTED</strong><time>08:42</time></div>
    <div className="product-controls"><button title="Audio"><Headphones /><span>Audio</span></button><button title="Add caller"><Users /><span>Add</span></button><button title="Messages"><MessageSquareText /><span>Message</span></button><button title="Video"><Video /><span>Video</span></button></div>
    <div className="active-device"><span><Phone size={17} /></span><div><strong>Ringing everywhere you work</strong><small>iPhone · Web · SIP endpoint</small></div><em>3 devices</em></div>
  </div>;
}

function HomePage() {
  const operatingPoints = ['One identity across iPhone, Android and web', 'Tenant controls for companies, teams and roles', 'Programmable SIP trunks and business numbers', 'Call queues, IVR, voicemail and office hours'];
  return <PageShell page="home">
    <section className="landing-hero" aria-labelledby="hero-title"><div className="hero-copy"><p className="hero-kicker"><span /> CLOUD COMMUNICATIONS, SIMPLIFIED</p><h1 id="hero-title">Vocivo</h1><p className="hero-slogan">Connect. Talk. Anywhere.</p><p className="hero-summary">A secure calling platform that brings personal voice, company extensions, messaging, conferences and intelligent reception into one beautifully simple workspace.</p><div className="hero-actions"><a className="primary-action" href={pagePath.contact}>Request a demo <ArrowRight size={18} /></a><a className="secondary-action" href={pagePath.platform}>Explore the platform <ChevronRight size={18} /></a></div><div className="hero-proof" aria-label="Platform availability"><span><Check size={15} /> iOS and Android</span><span><Check size={15} /> Browser calling</span><span><Check size={15} /> Business PBX</span></div></div></section>
    <section className="signal-band" aria-label="Vocivo platform highlights"><div><strong>200+</strong><span>international destinations</span></div><div><strong>5</strong><span>devices per extension</span></div><div><strong>One</strong><span>identity across channels</span></div><div><strong>Live</strong><span>routing and policy control</span></div></section>
    <section className="platform-section"><SectionHeading eyebrow="THE VOCIVO PLATFORM" title="Serious communications, without the complexity." copy="Vocivo gives individuals, growing teams and international companies the controls they expect from a modern phone system, presented in a calm, focused interface." /><div className="capability-grid">{capabilities.map(({ icon: Icon, title, copy }) => <article key={title} className="capability-item"><span><Icon /></span><h3>{title}</h3><p>{copy}</p><a href={pagePath.platform}>Learn more <ArrowRight /></a></article>)}</div></section>
    <section className="workspace-section"><div className="workspace-copy"><p className="section-label">BUILT FOR BUSINESS</p><h2>Your company phone system, wherever your people work.</h2><p>Give every employee an extension and professional identity. Route one company number across teams, devices and locations, while administrators stay in control.</p><ul>{operatingPoints.map((point) => <li key={point}><Check /> <span>{point}</span></li>)}</ul><a href={pagePath.business}>See business workflows <ArrowRight size={17} /></a></div><ProductStage /></section>
    <section className="why-preview"><div><p className="section-label">WHY VOCIVO</p><h2>Built around the conversation, not the hardware.</h2></div><div className="why-preview-points"><article><Gauge /><h3>Faster to operate</h3><p>Daily calling controls stay close to the people who use them.</p></article><article><Layers3 /><h3>Clearer to manage</h3><p>Company, team and platform permissions remain separate by design.</p></article><article><Route /><h3>Ready to evolve</h3><p>Connect carriers, numbers, devices and workflows without replacing the user experience.</p></article></div><a className="text-link" href={pagePath.why}>Why teams choose Vocivo <ArrowRight /></a></section>
    <ClosingCta />
  </PageShell>;
}

function PlatformMap() {
  return <div className="platform-map" aria-label="Vocivo platform architecture"><div className="map-core"><img src="/vocivo-icon-192.png" alt="" /><strong>Vocivo</strong><small>Communications control</small></div><span className="map-node node-mobile"><Phone /> Mobile</span><span className="map-node node-web"><Globe2 /> Web</span><span className="map-node node-ai"><Sparkles /> Voice AI</span><span className="map-node node-sip"><Network /> SIP</span></div>;
}

function PlatformPage() {
  const layers = [
    { icon: PhoneCall, title: 'Calls that travel with you', copy: 'Place and receive personal, company and extension calls from a consistent workspace on mobile and web.' },
    { icon: Workflow, title: 'Routing that reflects the business', copy: 'Shape office hours, divisions, queues, greetings, voicemail and escalation paths from administration.' },
    { icon: MessageSquareText, title: 'Conversations with context', copy: 'Keep call history, contacts, messages and customer identity together instead of scattering work across apps.' },
    { icon: Mic2, title: 'Voice automation with a purpose', copy: 'Configure spoken menus and assisted responses that help callers reach a person or answer sooner.' },
  ];
  return <PageShell page="platform">
    <section className="subpage-hero platform-hero"><div><p className="hero-kicker"><span /> VOCIVO PLATFORM</p><h1>One communications layer. Every way your team connects.</h1><p>Voice, extensions, conferencing, messaging, video and intelligent reception come together in a workspace designed for fast decisions.</p><div className="hero-actions"><a className="primary-action" href={pagePath.contact}>See Vocivo in action <ArrowRight /></a><a className="secondary-action" href={pagePath.pricing}>View pricing <ChevronRight /></a></div></div><PlatformMap /></section>
    <section className="feature-bands">{layers.map(({ icon: Icon, title, copy }, index) => <article key={title}><span className="feature-index">0{index + 1}</span><Icon /><div><h2>{title}</h2><p>{copy}</p></div></article>)}</section>
    <section className="platform-detail-section"><SectionHeading eyebrow="FROM APP TO INFRASTRUCTURE" title="A complete operating surface for communications." copy="The user experience stays simple while administrators retain the controls needed to run a serious phone environment." /><div className="detail-matrix"><article><Phone /><h3>People and devices</h3><p>Profiles, extensions, presence, contacts, caller identity and multiple registered devices.</p></article><article><Network /><h3>Calling and routing</h3><p>Inbound and outbound policies, queues, departments, transfer, hold, merge and conference.</p></article><article><ServerCog /><h3>Carriers and SIP</h3><p>Bring supported trunks and numbers into a governed workspace with explicit inbound and outbound configuration.</p></article><article><BarChart3 /><h3>Operational insight</h3><p>Call records, account activity, service events and administrator visibility in one place.</p></article></div></section>
    <section className="two-tone-cta"><div><p className="section-label">MOBILE, WEB AND SIP</p><h2>Start on one screen. Continue on another.</h2><p>An extension can ring on multiple registered devices, giving people a practical way to work across locations without changing their business identity.</p></div><div className="device-row"><span><Phone /> Mobile</span><span><Globe2 /> Browser</span><span><Network /> SIP</span></div></section>
    <ClosingCta />
  </PageShell>;
}

function BusinessPage() {
  const flows = [
    ['01', 'Give every person a professional identity', 'Create extensions, assign roles and keep employee details consistent across calling devices.'],
    ['02', 'Route the company number intelligently', 'Direct callers by schedule, division, queue or voice menu while preserving a clear fallback path.'],
    ['03', 'Handle the conversation as a team', 'Transfer, hold, add colleagues, merge calls and move into a conference without losing context.'],
    ['04', 'Improve the system without interrupting work', 'Company administrators can update users, prompts, trunks and policies within their permitted scope.'],
  ];
  return <PageShell page="business">
    <section className="business-hero"><div><p className="hero-kicker"><span /> BUSINESS COMMUNICATIONS</p><h1>A company phone system made for work in motion.</h1><p>Give customers one dependable way to reach your business and give employees the freedom to answer from the device that makes sense.</p><div className="hero-actions"><a className="primary-action" href={pagePath.contact}>Plan your workspace <ArrowRight /></a><a className="secondary-action" href={pagePath.pricing}>Compare plans <ChevronRight /></a></div></div></section>
    <section className="business-model"><SectionHeading eyebrow="ONE COMPANY, MANY WAYS TO ANSWER" title="Make every extension part of the same operation." copy="Vocivo separates the company account, administrator controls and employee identities so each person sees what they need without inheriting platform-level complexity." /><div className="business-flow">{flows.map(([number, title, copy]) => <article key={number}><strong>{number}</strong><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></section>
    <section className="business-console"><div className="console-visual"><div className="console-sidebar"><span><img src="/vocivo-icon-192.png" alt="" /> Vocivo</span>{['Overview', 'Users', 'Call routing', 'Voice & AI', 'SIP trunks'].map((item, index) => <i className={index === 1 ? 'selected' : ''} key={item}>{item}</i>)}</div><div className="console-main"><small>NORTHWIND SAMPLE CO / PEOPLE</small><h3>Users and extensions</h3><div className="console-stat"><span><strong>18</strong><small>Active users</small></span><span><strong>20</strong><small>Extension capacity</small></span><span><strong>3</strong><small>Ring groups</small></span></div>{[['Avery Sample', '1200', 'Available'], ['Jordan Example', '1201', 'In a call'], ['Sales Desk', '1210', 'Available']].map((row) => <div className="console-row" key={row[1]}><i>{row[0].charAt(0)}</i><strong>{row[0]}</strong><span>Ext. {row[1]}</span><em>{row[2]}</em></div>)}</div></div><div className="console-copy"><p className="section-label">ADMINISTRATION WITHOUT THE CLUTTER</p><h2>Control the company, not every click.</h2><p>Company admins manage their own people and calling workflows. Vocivo superadmins govern subscriptions, platform capabilities and carrier access separately.</p><ul><li><Check /> Extension ranges and user onboarding</li><li><Check /> QR enrollment for supported mobile workflows</li><li><Check /> Company-level feature permissions</li><li><Check /> Personal accounts remain separate from companies</li></ul></div></section>
    <section className="industry-strip"><strong>Designed for real operations</strong>{['Professional services', 'Energy and industrial', 'Healthcare teams', 'Hospitality', 'Distributed offices'].map((item) => <span key={item}>{item}</span>)}</section>
    <ClosingCta />
  </PageShell>;
}

function WhyPage() {
  const principles = [
    { icon: Users, title: 'People first', copy: 'The interface begins with who is calling, who should answer and what must happen next.' },
    { icon: Layers3, title: 'One coherent workspace', copy: 'Personal calls and business responsibilities stay distinct without forcing users into separate products.' },
    { icon: UserCog, title: 'Control at the right level', copy: 'Platform owners, company administrators and employees receive intentionally different tools.' },
    { icon: Route, title: 'Freedom to connect', copy: 'Vocivo is being built to work with programmable carriers, SIP infrastructure and regional providers.' },
    { icon: Sparkles, title: 'Useful intelligence', copy: 'Voice automation supports the caller journey rather than decorating the product with disconnected AI features.' },
    { icon: Gauge, title: 'Calm under pressure', copy: 'Calling controls are designed for speed, clarity and predictable state during live conversations.' },
  ];
  return <PageShell page="why">
    <section className="why-hero"><div><p className="hero-kicker"><span /> WHY VOCIVO</p><h1>Communication technology should disappear into the work.</h1><p>Vocivo exists to make sophisticated calling feel understandable for the person answering, the administrator configuring and the company paying.</p><a className="primary-action" href={pagePath.platform}>Explore the platform <ArrowRight /></a></div></section>
    <section className="principles-section"><SectionHeading eyebrow="OUR PRODUCT PRINCIPLES" title="A better phone system begins with better decisions." copy="Vocivo is not a reskin of an old PBX. Its structure is being built around modern teams, clear tenancy and a mobile-first understanding of work." /><div className="principle-grid">{principles.map(({ icon: Icon, title, copy }) => <article key={title}><Icon /><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
    <section className="difference-section"><div><p className="section-label">THE VOCIVO DIFFERENCE</p><h2>Choice without fragmentation.</h2><p>A company should be able to choose its carrier, number strategy and deployment path without making employees learn a new experience every time infrastructure changes.</p></div><div className="difference-list"><article><span>01</span><div><strong>Infrastructure flexibility</strong><p>Connect supported programmable voice and SIP services behind one product experience.</p></div></article><article><span>02</span><div><strong>Visible commercial boundaries</strong><p>Platform subscription, telecom usage, numbers and optional services are explained separately.</p></div></article><article><span>03</span><div><strong>Business identity everywhere</strong><p>Company name, extension owner and caller context remain central across supported devices.</p></div></article><article><span>04</span><div><strong>Built for a SaaS relationship</strong><p>Vocivo governs companies and plans while each customer governs its own organization.</p></div></article></div></section>
    <section className="comparison-section"><SectionHeading eyebrow="DESIGNED FOR THE MIDDLE GROUND" title="More capable than a calling app. More approachable than a legacy PBX." /><div className="comparison-track"><article><small>BASIC CALLING APPS</small><h3>Easy to start, limited to grow.</h3><p>Useful for a call, but often missing company structure, routing and administration.</p></article><span><ChevronRight /></span><article className="vocivo-position"><small>VOCIVO</small><h3>A complete workspace with clear control.</h3><p>Mobile simplicity for users, business workflows for teams and governance for the platform owner.</p></article><span><ChevronRight /></span><article><small>TRADITIONAL PBX</small><h3>Powerful, but infrastructure-led.</h3><p>Capable systems can make daily work feel secondary to configuration and hardware.</p></article></div></section>
    <ClosingCta />
  </PageShell>;
}

function PricingPage() {
  const [billing, setBilling] = useState('monthly');
  const [members, setMembers] = useState(25);
  const [calls, setCalls] = useState(8);
  const recommendation = useMemo(() => planData.find((plan) => members <= plan.members && calls <= plan.calls), [members, calls]);
  return <PageShell page="pricing">
    <section className="pricing-hero"><div><p className="hero-kicker"><span /> VOCIVO PRICING</p><h1>Pay for the workspace your operation needs.</h1><p>Choose capacity for people and active conversations. Carrier minutes, messages, numbers and optional data services remain visible and separate.</p></div><div className="billing-toggle" role="group" aria-label="Billing period"><button className={billing === 'monthly' ? 'active' : ''} onClick={() => setBilling('monthly')}>Monthly</button><button className={billing === 'annual' ? 'active' : ''} onClick={() => setBilling('annual')}>Annual <span>2 months included</span></button></div></section>
    <section className="plan-section"><div className="plan-grid">{planData.map((plan) => <article className={plan.featured ? 'plan featured' : 'plan'} key={plan.id}>{plan.featured && <span className="plan-badge">MOST POPULAR</span>}<p>{plan.name}</p><h2>{billing === 'monthly' ? `$${plan.monthly}` : `$${plan.annual}`}<small> / {billing === 'monthly' ? 'month' : 'year'}</small></h2><span>{plan.description}</span><a href={`${pagePath.contact}?plan=${plan.id}`}>Choose {plan.name} <ArrowRight /></a><ul>{plan.features.map((feature) => <li key={feature}><Check /> {feature}</li>)}</ul></article>)}<article className="plan enterprise"><p>Enterprise</p><h2>Tailored</h2><span>For larger estates, regional routing and requirements that need solution design.</span><a href={`${pagePath.contact}?plan=enterprise`}>Contact sales <ArrowRight /></a><ul><li><Check /> Custom capacity</li><li><Check /> Architecture review</li><li><Check /> Regional carrier planning</li><li><Check /> Commercial support plan</li></ul></article></div></section>
    <section className="estimator-section"><div className="estimator-copy"><p className="section-label">WORKSPACE ESTIMATOR</p><h2>Size the system around real activity.</h2><p>Team size sets the workspace range. Active calls represent the highest number of conversations expected at the same time, including internal and external calls.</p><div className="estimator-note"><CircleDollarSign /><span><strong>Internal extension calls</strong><small>Included in the workspace subscription. Internet or mobile-data usage may still apply.</small></span></div></div><div className="estimator-panel"><label><span>People in your company <strong>{members}</strong></span><input type="range" min="2" max="250" value={members} onInput={(event) => setMembers(Number(event.currentTarget.value))} /></label><label><span>Expected active calls <strong>{calls}</strong></span><input type="range" min="1" max="70" value={calls} onInput={(event) => setCalls(Number(event.currentTarget.value))} /></label><div className="estimate-result"><small>RECOMMENDED WORKSPACE</small>{recommendation ? <><strong>{recommendation.name}</strong><span>{recommendation.members} members · {recommendation.calls} active calls</span><b>{billing === 'monthly' ? `$${recommendation.monthly}/month` : `$${recommendation.annual}/year`}</b></> : <><strong>Enterprise</strong><span>Custom capacity and deployment review</span><a href={pagePath.contact}>Talk to sales <ArrowRight /></a></>}</div></div></section>
    <section className="pricing-boundaries"><SectionHeading eyebrow="CLEAR FROM THE START" title="What the subscription covers." copy="Vocivo separates software capacity from regulated telecom consumption so invoices remain understandable." /><div className="boundary-grid"><article><Cloud /><h3>Included</h3><p>Vocivo workspace, user and extension management, supported applications, routing controls and plan features.</p></article><article><PhoneCall /><h3>Usage based</h3><p>External voice minutes, SMS, AI processing and other metered communications at the applicable displayed rate.</p></article><article><Globe2 /><h3>Purchased separately</h3><p>Phone numbers, eSIM data, carrier setup, taxes, regulatory fees and any third-party hardware or service.</p></article></div><p className="pricing-disclaimer">Prices are shown in USD and exclude taxes. Destination availability, emergency calling, number eligibility and telecom rates vary by country and carrier. Final terms are confirmed during onboarding.</p></section>
    <ClosingCta title="Need a plan shaped around your call flow?" />
  </PageShell>;
}

function SecurityPage() {
  const controls = [
    { icon: Building2, title: 'Tenant boundaries', copy: 'Company data, users and settings are resolved within an organization context.' },
    { icon: KeyRound, title: 'Role-based access', copy: 'Vocivo superadmin, company admin and employee responsibilities are intentionally separated.' },
    { icon: LockKeyhole, title: 'Protected credentials', copy: 'Passwords are hashed and sensitive service credentials are kept out of client applications.' },
    { icon: BadgeCheck, title: 'Verified call events', copy: 'Supported carrier webhooks are checked before they can update call state or routing records.' },
    { icon: Database, title: 'Scoped operational data', copy: 'Profiles, events and configurations are stored and retrieved through explicit access boundaries.' },
    { icon: Activity, title: 'Administrative visibility', copy: 'Operational events and service state give administrators a clearer picture of system activity.' },
  ];
  return <PageShell page="security">
    <section className="security-hero"><div><p className="hero-kicker"><span /> SECURITY AT VOCIVO</p><h1>Trust is a product requirement, not a footer claim.</h1><p>Vocivo applies clear identity, tenant and service boundaries across the calling experience and the administration layer.</p><a className="primary-action" href={pagePath.contact}>Discuss your requirements <ArrowRight /></a></div><div className="security-shield"><ShieldCheck /><span>IDENTITY</span><span>ORGANIZATION</span><span>SERVICE</span></div></section>
    <section className="security-controls"><SectionHeading eyebrow="CURRENT CONTROL AREAS" title="Security designed into the operating model." copy="We describe the controls implemented in the platform without borrowing certification language the product has not earned." /><div className="security-control-grid">{controls.map(({ icon: Icon, title, copy }) => <article key={title}><Icon /><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></section>
    <section className="security-responsibility"><div><p className="section-label">SHARED RESPONSIBILITY</p><h2>Secure communication depends on sound configuration.</h2><p>Vocivo protects the product layer. Customers remain responsible for user access, destination policies, carrier credentials, lawful calling practices and device security.</p></div><div><h3>Customer responsibilities</h3><ul><li><Check /> Remove access when employment changes</li><li><Check /> Use strong, unique administrator credentials</li><li><Check /> Restrict international destinations appropriately</li><li><Check /> Protect SIP and carrier credentials</li><li><Check /> Follow local privacy and recording laws</li></ul></div></section>
    <section className="security-disclosure"><ShieldCheck /><div><h2>Found something that needs attention?</h2><p>Share a clear description, affected component and reproducible steps with the Vocivo team. Please do not include live customer data or credentials.</p></div><a href={pagePath.contact}>Contact security <ArrowRight /></a></section>
  </PageShell>;
}

function ContactPage() {
  const params = new URLSearchParams(window.location.search);
  const [form, setForm] = useState({ name: '', company: '', email: '', team: '', plan: params.get('plan') || '', message: '' });
  const submit = (event) => {
    event.preventDefault();
    const subject = encodeURIComponent(`Vocivo enquiry${form.company ? ` - ${form.company}` : ''}`);
    const body = encodeURIComponent(`Name: ${form.name}\nCompany: ${form.company || 'Not provided'}\nEmail: ${form.email}\nTeam size: ${form.team || 'Not provided'}\nPlan: ${form.plan || 'Not selected'}\n\n${form.message}`);
    window.location.href = `mailto:mr.musausman@gmail.com?subject=${subject}&body=${body}`;
  };
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <PageShell page="contact">
    <section className="contact-section"><div className="contact-copy"><p className="hero-kicker"><span /> TALK TO VOCIVO</p><h1>Let us design the right communications workspace with you.</h1><p>Tell us about your users, locations and call flow. We will help separate the software plan, number requirements, carrier usage and deployment work.</p><div className="contact-points"><article><PhoneCall /><div><strong>Product consultation</strong><span>Walk through the mobile, web and administration experience.</span></div></article><article><Network /><div><strong>Carrier and SIP planning</strong><span>Review inbound, outbound and regional connectivity requirements.</span></div></article><article><Building2 /><div><strong>Company onboarding</strong><span>Plan extensions, departments, roles and rollout.</span></div></article></div></div><form className="contact-form" onSubmit={submit}><div><label>Full name<input required value={form.name} onChange={update('name')} autoComplete="name" /></label><label>Work email<input required type="email" value={form.email} onChange={update('email')} autoComplete="email" /></label></div><div><label>Company<input value={form.company} onChange={update('company')} autoComplete="organization" /></label><label>Team size<select value={form.team} onChange={update('team')}><option value="">Select range</option><option>2-10</option><option>11-50</option><option>51-200</option><option>201+</option></select></label></div><label>Plan of interest<select value={form.plan} onChange={update('plan')}><option value="">Not sure yet</option><option value="launch">Launch</option><option value="operate">Operate</option><option value="scale">Scale</option><option value="enterprise">Enterprise</option></select></label><label>What should Vocivo help you solve?<textarea required rows="6" value={form.message} onChange={update('message')} placeholder="Locations, existing numbers or trunks, call flow, users and timing" /></label><button className="primary-action">Create email enquiry <ArrowRight /></button><small>Submitting opens your email application with the enquiry prepared. Vocivo does not collect this form in the browser.</small></form></section>
    <section className="contact-next"><SectionHeading eyebrow="WHAT HAPPENS NEXT" title="A practical conversation, not a generic sales script." /><div><article><span>1</span><h3>Understand</h3><p>We map people, locations, numbers, destinations and the desired customer journey.</p></article><article><span>2</span><h3>Design</h3><p>We define the workspace plan, routing, carrier dependencies and onboarding steps.</p></article><article><span>3</span><h3>Validate</h3><p>We test calls, devices and administrator workflows before a broader rollout.</p></article></div></section>
  </PageShell>;
}

function ClosingCta({ title = 'Bring every conversation into Vocivo.' }) {
  return <section className="closing-section"><p className="section-label">CONNECT. TALK. ANYWHERE.</p><h2>{title}</h2><p>Connect your people, customers and calling infrastructure through one modern platform.</p><div><a href={pagePath.contact}>Talk to our team <ArrowRight size={18} /></a><a className="secondary-action" href="/">Open web phone <ChevronRight size={18} /></a></div></section>;
}

const pages = { home: HomePage, platform: PlatformPage, business: BusinessPage, why: WhyPage, pricing: PricingPage, security: SecurityPage, contact: ContactPage };
const requestedPage = document.body.dataset.page || 'home';
const Website = pages[requestedPage] || HomePage;

ReactDOM.createRoot(document.getElementById('landing-root')).render(<React.StrictMode><Website /></React.StrictMode>);
