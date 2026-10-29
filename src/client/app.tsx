import { useEffect, useRef, useState } from 'preact/hooks';
import { useRegisterSW } from 'virtual:pwa-register/preact';
import { mealAt, type Meal } from '../domain/diary.js';
import type { LocalDate } from '../domain/ids.js';
import { localDate } from './clock.js';
import { Add } from './screens/Add.js';
import { Diary } from './screens/Diary.js';
import type { OnLogged } from './screens/flow.js';
import { GoalScreen } from './screens/Goal.js';
import { Icon, useToast } from './screens/ui.js';

type Tab = 'diary' | 'add' | 'scan' | 'goal';

const TABS: readonly { readonly tab: Tab; readonly label: string }[] = [
  { tab: 'diary', label: 'Diary' },
  { tab: 'add', label: 'Add' },
  { tab: 'scan', label: 'Scan' },
  { tab: 'goal', label: 'Goal' },
];

/** The scanner pulls in the zxing glue, so it loads on first use, never at startup. */
const loadScan = () => import('./screens/Scan.js');
type ScanModule = Awaited<ReturnType<typeof loadScan>>;

/** The phone's calendar day, refreshed when the app comes back to the foreground. */
function useToday(): LocalDate {
  const [today, setToday] = useState(() => localDate());
  useEffect(() => {
    const check = () => setToday(localDate());
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', check);
      clearInterval(timer);
    };
  }, []);
  return today;
}

const mealNow = () => mealAt(new Date().getHours());

export function App() {
  const today = useToday();
  const [tab, setTab] = useState<Tab>('diary');
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState<Meal>(mealNow);
  const [scan, setScan] = useState<ScanModule | null>(null);
  const toast = useToast();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  // An app left open overnight follows the calendar if it was showing today.
  const shownToday = useRef(today);
  useEffect(() => {
    if (date === shownToday.current) setDate(today);
    shownToday.current = today;
  }, [today]);

  useEffect(() => {
    if (tab === 'scan' && scan === null) void loadScan().then(setScan);
  }, [tab, scan]);

  const onLogged: OnLogged = (text, logged) => {
    toast({ text, undo: logged.undo });
    setTab('diary');
  };
  const slot = { date, meal };

  return (
    <div class="app">
      {needRefresh && (
        <button type="button" class="banner" onClick={() => void updateServiceWorker(true)}>
          A new version is ready. Tap to reload.
        </button>
      )}
      <main>
        {tab === 'diary' && (
          <Diary
            date={date}
            today={today}
            onDate={setDate}
            onAdd={(m) => {
              setMeal(m);
              setTab('add');
            }}
            onGoal={() => setTab('goal')}
          />
        )}
        {tab === 'add' && <Add slot={slot} today={today} onMeal={setMeal} onLogged={onLogged} onScan={() => setTab('scan')} />}
        {tab === 'scan' && (scan === null ? <p class="empty">Loading the scanner…</p> : <scan.Scan slot={slot} onLogged={onLogged} />)}
        {tab === 'goal' && <GoalScreen today={today} />}
      </main>
      <nav class="tab-bar" aria-label="Sections">
        {TABS.map(({ tab: t, label }) => (
          <button
            type="button"
            key={t}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => {
              if (t === 'add' && tab !== 'add') setMeal(mealNow());
              setTab(t);
              window.scrollTo(0, 0);
            }}
          >
            <Icon name={t} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
