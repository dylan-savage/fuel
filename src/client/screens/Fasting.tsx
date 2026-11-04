import { useState } from 'preact/hooks';
import { HOUR_MS, fastProgress, runningFast, type FastProgress } from '../../domain/habits.js';
import type { LocalDate } from '../../domain/ids.js';
import { localDate } from '../clock.js';
import { fastView, useIntents, useLive, type FastView } from '../views.js';
import { count, dayTitle, fastLabel, span, stopwatch, timeOfDay } from './format.js';
import { Icon, Ring, Segmented, Sheet, useNow, useToast } from './ui.js';

const TARGETS = [12, 14, 16, 18, 20, 24] as const;

const tone = (progress: FastProgress | undefined) => (progress?.reached ? 'done' : 'fast');

/** Start and end, with undo in the toast. Start uses `target`; end closes every open fast. */
function useFastActions() {
  const intents = useIntents();
  const toast = useToast();
  return {
    start: (target: number) =>
      void intents.startFast(target).then((undo) => {
        if (undo !== null) toast({ text: `Started a ${fastLabel(target)} fast`, undo });
      }),
    end: (progress: FastProgress | undefined) =>
      void intents.endFast().then((undo) => toast({ text: progress === undefined ? 'Ended your fast' : `Fasted ${span(progress.elapsedMs)}`, undo })),
  };
}

/** "Today 8:12 PM", "Tomorrow 12:12 PM". */
function moment(at: number, today: LocalDate): string {
  return `${dayTitle(localDate(new Date(at)), today)} ${timeOfDay(at)}`;
}

function FastSheet({ view, today, onClose }: { readonly view: FastView; readonly today: LocalDate; readonly onClose: () => void }) {
  const now = useNow(1000);
  const intents = useIntents();
  const actions = useFastActions();
  const running = runningFast(view.state);
  const [target, setTarget] = useState(running?.targetHours ?? view.nextTargetHours);
  const progress = running === undefined ? undefined : fastProgress(running, now);

  const pick = (hours: number) => {
    setTarget(hours);
    if (running !== undefined) void intents.setFastTarget(hours);
  };

  return (
    <Sheet title="Fasting" onClose={onClose}>
      <div class="hero">
        <Ring size={220} fraction={progress === undefined ? 0 : progress.elapsedMs / progress.targetMs} tone={tone(progress)}>
          <span class="hero-label">{progress === undefined ? 'Not fasting' : progress.reached ? 'Goal reached' : 'Fasting'}</span>
          <strong class="hero-value" data-testid="fast-clock">
            {stopwatch(progress?.elapsedMs ?? 0)}
          </strong>
          <span class="hero-sub">
            {progress === undefined
              ? `${fastLabel(target)} goal`
              : progress.reached
                ? `${stopwatch(progress.elapsedMs - progress.targetMs)} over`
                : `${stopwatch(progress.remainingMs)} left`}
          </span>
        </Ring>
      </div>
      {running !== undefined && (
        <dl class="fast-times">
          <div>
            <dt>Started</dt>
            <dd>{moment(running.startedAt, today)}</dd>
          </div>
          <div>
            <dt>Goal ends</dt>
            <dd>{moment(running.startedAt + running.targetHours * HOUR_MS, today)}</dd>
          </div>
        </dl>
      )}
      {view.state.kind === 'overlap' && <p class="hint warn">A fast was started on two devices while offline. Ending it ends both.</p>}

      <h4 class="section-heading">Goal</h4>
      <Segmented
        label="Fasting goal"
        options={TARGETS.map((hours) => ({ value: String(hours), label: fastLabel(hours) }))}
        value={String(running?.targetHours ?? target)}
        onChange={(value) => pick(Number(value))}
      />
      <div class="sheet-actions">
        {running === undefined ? (
          <button type="button" class="primary" onClick={() => actions.start(target)}>
            Start fast
          </button>
        ) : (
          <button type="button" class="primary end" onClick={() => actions.end(progress)}>
            End fast
          </button>
        )}
      </div>

      <h4 class="section-heading">History</h4>
      <dl class="streak card">
        <div>
          <dt>Current streak</dt>
          <dd data-testid="streak-current">{count(view.streak.current, 'day')}</dd>
        </div>
        <div>
          <dt>Best</dt>
          <dd>{count(view.streak.best, 'day')}</dd>
        </div>
      </dl>
      {view.history.length === 0 ? (
        <p class="empty">Finished fasts show up here.</p>
      ) : (
        <ul class="list" aria-label="Past fasts">
          {view.history.slice(0, 30).map((session) => {
            const done = fastProgress(session, session.endedAt);
            return (
              <li key={session.startedAt}>
                <div class="entry-row">
                  <span class="food-name">{dayTitle(localDate(new Date(session.endedAt)), today)}</span>
                  <span class="food-detail">
                    {timeOfDay(session.startedAt)} to {timeOfDay(session.endedAt)} · {fastLabel(session.targetHours)} goal
                  </span>
                  <span class={done.reached ? 'entry-kcal reached' : 'entry-kcal'}>
                    {span(done.elapsedMs)}
                    {done.reached ? ' ✓' : ''}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

/** The fast at a glance: a live timer toward the target, and Start or End in one tap. */
export function FastTile({ today }: { readonly today: LocalDate }) {
  const view = useLive((r) => fastView(r, today), [today]);
  const now = useNow(1000);
  const actions = useFastActions();
  const [open, setOpen] = useState(false);
  if (view === undefined) return <section class="card tile" aria-label="Fasting" />;

  const running = runningFast(view.state);
  const progress = running === undefined ? undefined : fastProgress(running, now);

  return (
    <section class="card tile" aria-label="Fasting">
      <button type="button" class="tile-main" onClick={() => setOpen(true)}>
        <Ring size={52} fraction={progress === undefined ? 0 : progress.elapsedMs / progress.targetMs} tone={tone(progress)}>
          <Icon name="timer" />
        </Ring>
        <span class="tile-text">
          <span class="tile-title">Fasting</span>
          {progress === undefined ? (
            <span class="tile-value">
              <small>{fastLabel(view.nextTargetHours)} goal</small>
            </span>
          ) : (
            <>
              <span class="tile-value clock" data-testid="fast-elapsed">
                {stopwatch(progress.elapsedMs)}
              </span>
              <span class="tile-detail">{progress.reached ? 'Goal reached' : `${span(progress.remainingMs)} left`}</span>
            </>
          )}
        </span>
      </button>
      <div class="pills">
        {running === undefined ? (
          <button type="button" class="pill" onClick={() => actions.start(view.nextTargetHours)}>
            Start fast
          </button>
        ) : (
          <button type="button" class="pill" onClick={() => actions.end(progress)}>
            End fast
          </button>
        )}
      </div>
      {open && <FastSheet view={view} today={today} onClose={() => setOpen(false)} />}
    </section>
  );
}
