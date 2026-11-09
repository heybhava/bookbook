'use client';
import { useEffect, useState } from 'react';
import { useStore, hydrateFromClient, type View, type Toast as ToastT } from '@/lib/store';
import { Icon } from '@/components/ui';
import { Library } from '@/components/Library';
import { ReaderView } from '@/components/reader/ReaderView';
import { VocabView, NotesView, KnowledgeView, ReviewView, SettingsView } from '@/components/Views';
import { InboxView, AskLibraryView, WriteView, CommandPalette } from '@/components/Intel';
import { LiveTranslateView, useT } from '@/components/Lang';
import { RecallView, RecallSession } from '@/components/Recall';
import { VaultView } from '@/components/Vault';
import { JournalView } from '@/components/Journal';
import { ReadingDashboard } from '@/components/ReadingDashboard';
import { useRead } from '@/lib/readPrefs';
import { tzOffset } from '@/lib/readStats';
import { api } from '@/lib/api';
import { AuthGate } from '@/components/Auth';
import { isRtl } from '@/lib/lang/registry';

const NAV: { v: View; key: string; icon: string }[] = [
  { v: 'home', key: 'library', icon: 'library' }, { v: 'reading', key: 'reading', icon: 'clock' }, { v: 'inbox', key: 'inbox', icon: 'note' }, { v: 'ask', key: 'ask', icon: 'sparkle' },
  { v: 'review', key: 'review', icon: 'cards' }, { v: 'vocab', key: 'vocab', icon: 'vocab' }, { v: 'write', key: 'write', icon: 'edit' }, { v: 'live', key: 'live', icon: 'sound' }, { v: 'recall', key: 'recall', icon: 'check' },
  { v: 'journal', key: 'journal', icon: 'note' }, { v: 'vault', key: 'vault', icon: 'edit' }, { v: 'notes', key: 'notes', icon: 'highlight' }, { v: 'knowledge', key: 'graph', icon: 'graph' }, { v: 'settings', key: 'settings', icon: 'gear' },
];

export default function Root() { return <AuthGate><App /></AuthGate>; }

function App() {
  const { view, go, toast, setPalette, recall, setRecall } = useStore();
  const [ready, setReady] = useState(false);
  const t = useT(); const ui = useStore((s) => s.langPrefs.ui);
  useEffect(() => { api<any>('/lang/prefs').then((r) => useStore.getState().setLangPrefsLocal(r.global ?? {})).catch(() => {}); }, []);
  useEffect(() => { // optional, gentle: one reminder per day, only after 5 pm and only if nothing has been read today
    useRead.getState().load(); if (!useRead.getState().global.remind || new Date().getHours() < 17) return;
    const dk = String(Math.floor((Date.now() + tzOffset() * 60000) / 86400000));
    api<any>(`/reading/stats?tz=${tzOffset()}`).then((s) => { try { if (s.today.seconds === 0 && localStorage.getItem('folio.remindday') !== dk) { localStorage.setItem('folio.remindday', dk); useStore.getState().say('A few quiet minutes with a book today?'); } } catch { /* */ } }).catch(() => {});
  }, []);
  useEffect(() => { document.documentElement.lang = ui ?? 'en'; document.documentElement.dir = isRtl(ui) ? 'rtl' : 'ltr'; }, [ui]);
  useEffect(() => { hydrateFromClient(); setReady(true); const h = () => hydrateFromClient(); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  if (!ready) return null;
  if (recall) return <><RecallSession run={recall} onClose={() => { const then = recall.then; setRecall(null); if (then === 'home') go('home'); }} /><Toast t={toast} /></>; // the reader is unmounted: the book is truly closed

  if (view === 'reader') return <><ReaderView /><Toast t={toast} /><CommandPalette /></>;
  return (
    <div className="h-screen flex flex-col md:flex-row">
      <nav className="md:w-56 shrink-0 md:border-r border-b md:border-b-0 border-[var(--line)] bg-[var(--panel)] flex md:flex-col gap-1 p-2 md:p-3 overflow-x-auto" aria-label="Main">
        <div className="hidden md:flex items-center gap-2 px-2 py-3 mb-2">
          <span className="w-7 h-7 rounded-lg bg-[var(--ink)] text-[var(--bg)] grid place-items-center font-serif font-bold">b</span>
          <div><div className="font-semibold leading-none">bookbook</div><div className="text-[10px] text-[var(--ink3)] mt-1">free · local · private</div></div>
        </div>
        <button onClick={() => setPalette(true)} className="hidden md:flex items-center justify-between px-3 py-2 mb-1 rounded-lg text-sm text-[var(--ink3)] border border-[var(--line)] hover:bg-[var(--panel2)]"><span className="flex items-center gap-2"><Icon n="search" size={14} />{t('search')}</span><kbd className="text-[10px]">Ctrl K</kbd></button>
        {NAV.map((n) => (
          <button key={n.v} onClick={() => go(n.v)} aria-current={view === n.v} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-left transition-colors ${view === n.v ? 'bg-[var(--panel2)] text-[var(--ink)] font-medium' : 'text-[var(--ink2)] hover:bg-[var(--panel2)]'}`}>
            <Icon n={n.icon} />{t(n.key)}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-auto">
        {view === 'vault' ? <VaultView /> : view === 'journal' ? <JournalView /> : <div className="max-w-6xl mx-auto p-4 md:p-8 fade-in" key={view}>
          {view === 'home' && <Library />}
          {view === 'reading' && <ReadingDashboard />}
          {view === 'inbox' && <InboxView />}
          {view === 'ask' && <AskLibraryView />}
          {view === 'write' && <WriteView />}
          {view === 'live' && <LiveTranslateView />}
          {view === 'recall' && <RecallView />}
          {view === 'vocab' && <VocabView />}
          {view === 'notes' && <NotesView />}
          {view === 'knowledge' && <KnowledgeView />}
          {view === 'review' && <ReviewView />}
          {view === 'settings' && <SettingsView />}
        </div>}
      </main>
      <Toast t={toast} />
      <CommandPalette />
    </div>
  );
}

function Toast({ t }: { t: ToastT | null }) {
  if (!t) return null;
  return (
    <div role="status" className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] card px-4 py-2 text-sm shadow-lg fade-in flex items-center gap-3">
      <span>{t.msg}</span>
      {t.action && <button className="font-medium text-[var(--accent)]" onClick={() => { t.action!.run(); useStore.setState({ toast: null }); }}>{t.action.label}</button>}
    </div>
  );
}
