import { useState } from 'preact/hooks';
import { HOUR_MS, fastProgress, runningFast } from '../../domain/habits.js';
import type { LocalDate } from '../../domain/ids.js';
import { localDate } from '../clock.js';
import { fastView, useIntents, useLive, type FastView } from '../views.js';
import { count, dayTitle, fastLabel, span, stopwatch, timeOfDay } from './format.js';
import { Icon, Row, Segmented, Sheet, Stat, useNow, useToast } from './ui.js';

const TARGETS = [12, 14, 16, 18, 20, 24] as const;

/** "Today 8:12 PM", "Tomorrow 12:12 PM". */
function moment(at: number, today: LocalDate): string {
  return `${dayTitle(localDate(new Date(at)), today)} ${timeOfDay(at)}`;
}

function FastSheet({ view, today, onClose }: { readonly view: FastView; readonly today: LocalDate; readonly onClose: () => void }) {
  const now = useNow(1000);
  const intents = useIntents();
  const toast = useToast();
  const running = runningFast(view.state);
  const [target, setTarget] = useState(running?.targetHours ?? view.nextTargetHours);
  const progress = running === undefined ? undefined : fastProgress(running, now);

  const pick = (hours: number) => {
    setTarget(hours);
    if (running !== undefined) void intents.setFastTarget(hours);
  };
  const start = () =>
    void intents.startFast(target).then((undo) => {
      if (undo !== null) toast({ text: `Started a ${fastLabel(target)} fast`, undo });
    });
  const end = () => void intents.endFast().then((undo) => toast({ text: progress === undefined ? 'Ended your fast' : `Fasted ${span(progress.elapsedMs)}`, undo }));

  return (
    <Sheet title="Fasting" onClose={onClose} closeLabel="Done">
      <div class="card">
        {progress === undefined ? (
          <p class="hero-number">Not fasting</p>
        ) : (
          <>
            <p class="hero-number" data-testid="fast-clock">
              {stopwatch(progress.elapsedMs)}
            </p>
            <p class="detail">{progress.reached ? `Goal reached, ${span(progress.elapsedMs - progress.targetMs)} over` : `${span(progress.remainingMs)} left`}</p>
            <div class={progress.reached ? 'bar small' : 'bar small fast'} role="presentation">
              <span style={{ width: `${Math.min(1, progress.elapsedMs / progress.targetMs) * 100}%` }} />
            </div>
          </>
        )}
      </div>
      {running !== undefined && (
        <ul class="list" aria-label="This fast">
          <li>
            <Row name="Started" end={moment(running.startedAt, today)} />
          </li>
          <li>
            <Row name="Goal ends" end={moment(running.startedAt + running.targetHours * HOUR_MS, today)} />
          </li>
        </ul>
      )}
      {view.state.kind === 'overlap' && <p class="hint warn">Started on two devices while offline. Ending it ends both.</p>}
      <Segmented label="Fasting goal" options={TARGETS.map((hours) => ({ value: String(hours), label: fastLabel(hours) }))} value={String(running?.targetHours ?? target)} onChange={(value) => pick(Number(value))} />
      <div class="sheet-actions">
        {running === undefined ? (
          <button type="button" class="primary" onClick={start}>
            Start fast
          </button>
        ) : (
          <button type="button" class="primary" onClick={end}>
            End fast
          </button>
        )}
      </div>
      {view.history.length > 0 && (
        <>
          <h4 class="section-heading">History</h4>
          <ul class="list" aria-label="Streak">
            <li>
              <Row name="Current streak" end={count(view.streak.current, 'day')} />
            </li>
            <li>
              <Row name="Best streak" end={count(view.streak.best, 'day')} />
            </li>
          </ul>
          <ul class="list" aria-label="Past fasts">
            {view.history.slice(0, 30).map((session) => {
              const done = fastProgress(session, session.endedAt);
              return (
                <li key={session.startedAt}>
                  <Row
                    name={dayTitle(localDate(new Date(session.endedAt)), today)}
                    detail={`${timeOfDay(session.startedAt)} to ${timeOfDay(session.endedAt)} · ${fastLabel(session.targetHours)} goal`}
                    end={
                      <>
                        {span(done.elapsedMs)}
                        {done.reached && (
                          <span class="mark-good" role="img" aria-label="Goal reached">
                            <Icon name="check" />
                          </span>
                        )}
                      </>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Sheet>
  );
}

/** The fast as one number, opening the sheet that starts and ends it. */
export function FastStat({ today }: { readonly today: LocalDate }) {
  const view = useLive((r) => fastView(r, today), [today]);
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const running = view === undefined ? undefined : runningFast(view.state);
  return (
    <>
      <Stat label="Fasting" value={running === undefined ? 'Off' : <span data-testid="fast-elapsed">{span(fastProgress(running, now).elapsedMs)}</span>} onClick={() => setOpen(true)} />
      {open && view !== undefined && <FastSheet view={view} today={today} onClose={() => setOpen(false)} />}
    </>
  );
}
