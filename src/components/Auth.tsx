'use client';
// Sign-in gate and account management. Nothing of the app is rendered until the server confirms a valid session.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import '@/lib/clientAuth';
import { setCsrf } from '@/lib/clientAuth';
import { Spinner } from './ui';

export interface User { id: string; email: string; name: string | null; emailVerified: boolean; isAdmin: boolean }
const Ctx = createContext<{ user: User; signOut: () => Promise<void> } | null>(null);
export const useAccount = () => useContext(Ctx);
const post = async (path: string, body: unknown = {}) => { const r = await fetch('/api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error ?? 'Something went wrong.'), { code: j.code, status: r.status }); return j; };

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'anon' | 'in'>('loading'); const [user, setUser] = useState<User | null>(null);
  const check = useCallback(async () => { try { const r = await fetch('/api/auth/session'); const j = await r.json(); if (j.user) { setCsrf(j.csrf); setUser(j.user); setState('in'); } else setState('anon'); } catch { setState('anon'); } }, []);
  useEffect(() => { void check(); const h = () => setState('anon'); window.addEventListener('folio:unauthorized', h); return () => window.removeEventListener('folio:unauthorized', h); }, [check]);
  const signOut = useCallback(async () => { try { await post('/auth/logout'); } catch { /* already out */ } location.hash = ''; location.reload(); }, []);
  if (state === 'loading') return <div className="h-screen grid place-items-center"><Spinner label="Loading…" /></div>;
  if (state === 'anon' || !user) return <AuthScreens onDone={() => { location.hash = ''; location.reload(); }} />;
  return <Ctx.Provider value={{ user, signOut }}>{children}</Ctx.Provider>;
}

type Mode = 'login' | 'register' | 'forgot' | 'verify' | 'reset' | 'sent';
function AuthScreens({ onDone }: { onDone: () => void }) {
  const hash = typeof location !== 'undefined' ? location.hash : ''; const vm = /^#\/auth\/(verify|reset)\/([\w-]+)$/.exec(hash);
  const [mode, setMode] = useState<Mode>(vm ? (vm[1] as Mode) : 'login'); const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [cfg, setCfg] = useState<any>(null); const [unverified, setUnverified] = useState(false);
  useEffect(() => { fetch('/api/auth/config').then((r) => r.json()).then(setCfg).catch(() => {}); }, []);
  useEffect(() => { if (mode === 'verify' && vm) { setBusy(true); post('/auth/verify', { token: vm[2] }).then(() => { setMsg('Your email is verified. You can sign in now.'); setMode('login'); history.replaceState(null, '', '#/'); }).catch((e) => setErr(e.message)).finally(() => setBusy(false)); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); } catch (e: any) { setErr(e.message); if (e.code === 'unverified') setUnverified(true); } setBusy(false); };
  const submit = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
    if (mode === 'login') { await post('/auth/login', { email, password: pw }); onDone(); }
    else if (mode === 'register') { if (pw !== pw2) throw new Error('The passwords do not match.'); const r = await post('/auth/register', { email, password: pw, name }); if (r.needsVerification) { setMode('sent'); } else onDone(); }
    else if (mode === 'forgot') { await post('/auth/forgot', { email }); setMode('sent'); setMsg('If an account exists for that address, a reset link is on its way.'); }
    else if (mode === 'reset' && vm) { if (pw !== pw2) throw new Error('The passwords do not match.'); await post('/auth/reset', { token: vm[2], password: pw }); history.replaceState(null, '', '#/'); setMode('login'); setPw(''); setMsg('Password changed. Sign in with the new one.'); }
  }); };
  return (
    <div className="min-h-screen grid place-items-center p-6 bg-[var(--bg)]"><div className="card w-full max-w-sm p-6 space-y-4">
      <div className="flex items-center gap-2"><img src="/logo.png" alt="" className="w-8 h-8 rounded-lg" /><div><div className="font-semibold leading-none">bookbook</div><div className="text-[11px] text-[var(--ink3)] mt-1">your private reading &amp; knowledge space</div></div></div>
      {mode === 'sent' ? <div className="space-y-3"><h1 className="font-serif text-xl">Check your email</h1><p className="text-sm text-[var(--ink2)]">{msg ?? `We sent a link to ${email || 'your address'}. Open it to ${cfg?.verification ? 'verify your email' : 'continue'}.`}</p><button className="btn" onClick={() => { setMode('login'); setMsg(null); }}>Back to sign in</button></div>
        : mode === 'verify' ? <div><h1 className="font-serif text-xl">Verifying…</h1>{busy ? <Spinner /> : err && <p className="text-sm text-[var(--danger)] mt-2" role="alert">{err}</p>}<button className="btn mt-3" onClick={() => { setMode('login'); setErr(null); history.replaceState(null, '', '#/'); }}>Go to sign in</button></div>
        : <form onSubmit={submit} className="space-y-3">
          <h1 className="font-serif text-xl">{mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : 'Choose a new password'}</h1>
          {mode === 'register' && <label className="block text-sm">Name (optional)<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
          {mode !== 'reset' && <label className="block text-sm">Email<input className="input mt-1" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus /></label>}
          {mode !== 'forgot' && <label className="block text-sm">{mode === 'reset' ? 'New password' : 'Password'}<input className="input mt-1" type="password" required minLength={mode === 'login' ? 1 : 10} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>}
          {(mode === 'register' || mode === 'reset') && <label className="block text-sm">Repeat password<input className="input mt-1" type="password" required value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /><span className="text-[11px] text-[var(--ink3)]">At least 10 characters; avoid common passwords.</span></label>}
          {err && <p className="text-sm text-[var(--danger)]" role="alert">{err}</p>}{msg && <p className="text-sm text-[var(--accent)]" role="status">{msg}</p>}
          <button className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Change password'}</button>
          {unverified && <button type="button" className="text-sm text-[var(--accent)]" onClick={() => run(async () => { await post('/auth/resend', { email }); setMsg('If that account is unverified, a new link was sent.'); })}>Send the verification link again</button>}
          <div className="flex justify-between text-sm text-[var(--ink2)]">{mode === 'login' ? <><button type="button" onClick={() => { setMode('register'); setErr(null); }} disabled={cfg && !cfg.registration}>{cfg && !cfg.registration ? 'Registration closed' : 'Create an account'}</button><button type="button" onClick={() => { setMode('forgot'); setErr(null); }}>Forgot password?</button></> : <button type="button" onClick={() => { setMode('login'); setErr(null); }}>← Back to sign in</button>}</div>
        </form>}
      <p className="text-[11px] text-[var(--ink3)]">Your books, notes, journals and recordings belong to your account only. Nothing is shared unless you choose to.</p>
    </div></div>
  );
}

/** Account section for Settings: sessions, password, export, deletion. */
export function AccountSettings() {
  const acct = useAccount(); const [sessions, setSessions] = useState<any[]>([]); const [msg, setMsg] = useState<string | null>(null); const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [delPw, setDelPw] = useState(''); const [delTxt, setDelTxt] = useState('');
  const load = useCallback(() => { fetch('/api/auth/sessions').then((r) => r.json()).then(setSessions).catch(() => {}); }, []); useEffect(load, [load]);
  if (!acct) return null; const say = (m: string) => setMsg(m);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); say(ok); load(); } catch (e: any) { say(e.message); } };
  return (
    <section className="card p-4 space-y-4" aria-label="Account"><h2 className="font-semibold">Account</h2>
      <p className="text-sm text-[var(--ink2)]">Signed in as <b>{acct.user.email}</b>{acct.user.isAdmin ? ' · administrator' : ''}.</p>
      <div className="flex flex-wrap gap-2"><button className="btn" onClick={acct.signOut}>Sign out</button><button className="btn" onClick={() => act(async () => { await post('/auth/logout-all'); location.reload(); }, '')}>Sign out everywhere</button><a className="btn" href="/api/account/export" download>Download all my data</a></div>
      <div><div className="label">Active sessions</div><ul className="text-sm space-y-1 mt-1">{sessions.map((s) => <li key={s.ref} className="flex items-center gap-2"><span className="flex-1 truncate">{s.current ? 'This device' : (s.user_agent ?? 'Unknown device').slice(0, 60)} · last used {new Date(s.last_seen).toLocaleString()}</span>{!s.current && <button className="text-[var(--danger)]" onClick={() => act(async () => { await fetch('/api/auth/sessions/' + s.ref, { method: 'DELETE' }); }, 'Session revoked.')}>Revoke</button>}</li>)}</ul></div>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void act(() => post('/auth/change-password', { current: cur, next }), 'Password changed; other devices were signed out.'); setCur(''); setNext(''); }}><div className="label">Change password</div><input className="input" type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /><input className="input" type="password" placeholder="New password (10+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /><button className="btn" disabled={!cur || next.length < 10}>Change password</button></form>
      <details><summary className="label cursor-pointer text-[var(--danger)]">Delete my account</summary><div className="space-y-2 mt-2"><p className="text-sm text-[var(--ink2)]">This permanently deletes your account and everything in it: books, notes, journals, recordings. Download your data first.</p><input className="input" type="password" placeholder="Password" value={delPw} onChange={(e) => setDelPw(e.target.value)} /><input className="input" placeholder='Type DELETE to confirm' value={delTxt} onChange={(e) => setDelTxt(e.target.value)} /><button className="btn text-[var(--danger)]" disabled={!delPw || delTxt !== 'DELETE'} onClick={() => act(async () => { await fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: delPw, confirm: delTxt }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); }); location.hash = ''; location.reload(); }, '')}>Delete everything permanently</button></div></details>
      {msg && <p className="text-sm text-[var(--accent)]" role="status">{msg}</p>}
    </section>
  );
}
