import { useEffect, useRef, useState } from 'preact/hooks';
import { useRegisterSW } from 'virtual:pwa-register/preact';
import { mealAt, type Meal } from '../domain/diary.js';
import type { LocalDate } from '../domain/ids.js';
import { localDate } from './clock.js';
import { InvalidDocument } from './replica.js';
import { Add } from './screens/Add.js';
import { Diary } from './screens/Diary.js';
import type { OnLogged } from './screens/flow.js';
import { GoalScreen } from './screens/Goal.js';
import { Train, type TrainPlace } from './screens/Train.js';
import { Icon, useToast } from './screens/ui.js';
import { useIntents } from './views.js';

export type Tab = 'diary' | 'add' | 'train' | 'goal';

const TABS: readonly { readonly tab: Tab; readonly label: string }[] = [
  { tab: 'diary', label: 'Diary' },
  { tab: 'add', label: 'Add' },
  { tab: 'train', label: 'Train' },
  { tab: 'goal', label: 'Goal' },
];

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

/** Finishes an idle session on launch, and when the app comes back, since iOS often resumes one rather than launching it. It says nothing, and its workout just appears in the diary. */
function useSettleLapsed() {
  const intents = useIntents();
  useEffect(() => {
    const settle = () => {
      if (document.visibilityState === 'visible') void intents.settleLapsed();
    };
    settle();
    document.addEventListener('visibilitychange', settle);
    return () => document.removeEventListener('visibilitychange', settle);
  }, [intents]);
}

/**
 * Only a navigation makes the browser look for a new worker, and iOS wakes a suspended app
 * without one, so a deployed build would wait for a force-quit. Offline, the check just fails.
 */
function checkForUpdateOnWake(_url: string, registration: ServiceWorkerRegistration | undefined) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration?.update().catch(() => undefined);
  });
}

export function App({ startOn }: { readonly startOn: Tab }) {
  const today = useToday();
  const [tab, setTab] = useState<Tab>(startOn);
  const [trainPlace, setTrainPlace] = useState<TrainPlace>(null);
  useSettleLapsed();
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState<Meal>(mealNow);
  const toast = useToast();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ onRegisteredSW: checkForUpdateOnWake });

  // An app left open overnight follows the calendar if it was showing today.
  const shownToday = useRef(today);
  useEffect(() => {
    if (date === shownToday.current) setDate(today);
    shownToday.current = today;
  }, [today]);

  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!(event.reason instanceof InvalidDocument)) return;
      console.error(event.reason);
      event.preventDefault();
      toast({ text: 'Not saved. A value is outside what fuel can store.' });
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [toast]);

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
        {tab === 'add' && <Add slot={slot} today={today} onMeal={setMeal} onLogged={onLogged} />}
        {tab === 'train' && <Train today={today} place={trainPlace} onPlace={setTrainPlace} />}
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
              if (t === 'train' && tab === 'train') setTrainPlace(null);
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
