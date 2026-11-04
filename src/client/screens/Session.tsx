/**
 * A session in progress, one exercise in focus. The screen holds no where-am-I state: what it shows
 * comes from the stored sets through cardFor, and rest from restClock, so a reload or a lock has
 * nothing to restore but typed digits, which wait in trainDraft.
 */
import { useEffect, useState } from 'preact/hooks';
import type { LocalDate, Millis } from '../../domain/ids.js';
import type { Performance } from '../../domain/lifts.js';
import type { LiftsBlock, Slot, Step } from '../../domain/program.js';
import { cardFor, cueFor, liftInSlot, performanceIdOf, restClock, setsProgress, slotLog, type LiftChoice, type LoggedSet, type Session, type SessionLogs, type SetsProgress } from '../../domain/session.js';
import { now } from '../clock.js';
import type { Finished } from '../intents.js';
import { afterLog, entryOf, typedFor, useTrainDraft, withSwap, withoutFocus, type SetForm } from '../trainDraft.js';
import { lastTimesView, sessionLiftIds, sessionPlanView, useIntents, useLive, type SessionPlan } from '../views.js';
import { CardAction, CardActions, FocusTitle, SetCard } from './SetCard.js';
import { CueSheet, EditSetSheet, NoteSheet, PlanSheet, SkipSheet, SwapSheet } from './SessionSheets.js';
import { barFill, useNow, useToast } from './ui.js';
import { Waiting } from './Waiting.js';
import { WorkoutSheet } from './Workouts.js';

const KEYBOARD_MIN_PX = 80;

/**
 * iOS keeps the layout viewport under the keyboard, so a fixed screen sits behind it. While mounted,
 * this tells the styles how much of the screen the keyboard covers and where the visible part is.
 */
export function useKeyboardAvoidance(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const root = document.documentElement;
    let wasUp = false;
    const update = () => {
      const covered = root.clientHeight - viewport.height - viewport.offsetTop;
      const up = covered > KEYBOARD_MIN_PX;
      root.classList.toggle('keyboard-up', up);
      root.style.setProperty('--keyboard', `${up ? covered : 0}px`);
      root.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
      if (up && !wasUp) document.activeElement?.scrollIntoView({ block: 'nearest' });
      wasUp = up;
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.classList.remove('keyboard-up');
      root.style.removeProperty('--keyboard');
      root.style.removeProperty('--viewport-top');
    };
  }, []);
}

function Elapsed({ from }: { readonly from: Millis | undefined }) {
  useNow(30_000);
  return <>{from === undefined ? '' : `${Math.max(0, Math.floor((now() - from) / 60_000))} min`}</>;
}

/** The day, the time, the way out and the thin bar of sets done. A session with no plan on this phone has only the way out. */
function SessionBar({ logs, progress, onPlan, onFinish }: { readonly logs: SessionLogs; readonly progress?: SetsProgress; readonly onPlan?: () => void; readonly onFinish: () => void }) {
  const { session } = logs;
  return (
    <header class="session-bar">
      <div class="session-bar-row">
        <div class="session-title">
          <h1>{session.day?.label ?? 'Session'}</h1>
          <p>
            <span data-testid="elapsed">
              <Elapsed from={session.startedAt} />
            </span>
            <Waiting />
          </p>
        </div>
        {onPlan !== undefined && (
          <button type="button" class="text-button" onClick={onPlan}>
            Plan
          </button>
        )}
        <button type="button" class="text-button session-finish" onClick={onFinish}>
          Finish
        </button>
      </div>
      {progress !== undefined && (
        <div class="bar small" role="progressbar" aria-label="Sets done" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <span style={barFill(progress.total === 0 ? 0 : progress.done / progress.total)} />
        </div>
      )}
    </header>
  );
}

function finishedToast(finished: Finished, label: string) {
  switch (finished.kind) {
    case 'already':
      return null;
    case 'dropped':
      return { text: 'Nothing logged, not counted', undo: finished.undo };
    case 'finished':
      switch (finished.diary) {
        case 'added':
          return { text: `Finished ${label}, ${finished.minutes ?? 0} min in the diary`, undo: finished.undo };
        case 'no-sets':
          return { text: `Finished ${label}`, undo: finished.undo };
        case 'no-weight':
          return { text: `Finished ${label}. Weigh in to count its burn.`, undo: finished.undo };
      }
  }
}

function useFinish(session: Session): () => void {
  const intents = useIntents();
  const toast = useToast();
  return () => {
    void intents.finishSession(session.id).then((finished) => {
      const message = finishedToast(finished, session.day?.label ?? 'session');
      if (message !== null) toast(message);
    });
  };
}

/** Which sheet is over the session, each with what it needs, so one can only open with its data. The plan has its own flag, because editing a set opens over it. */
type OpenSheet =
  | { readonly kind: 'swap'; readonly step: Step; readonly lift: LiftChoice }
  | { readonly kind: 'skip'; readonly step: Step; readonly lift: LiftChoice }
  | { readonly kind: 'note'; readonly exercise: Performance | undefined }
  | { readonly kind: 'cue'; readonly cue: string | undefined; readonly block: LiftsBlock }
  | { readonly kind: 'edit'; readonly row: LoggedSet; readonly slot: Slot }
  | { readonly kind: 'cardio' };

function Running({ logs, plan, today }: { readonly logs: SessionLogs; readonly plan: SessionPlan; readonly today: LocalDate }) {
  const { session, performances } = logs;
  const intents = useIntents();
  const toast = useToast();
  const finish = useFinish(session);
  const [draft, setDraft] = useTrainDraft(session.id);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  useKeyboardAvoidance();

  const liftIds = sessionLiftIds(plan, performances, Object.values(draft.swaps ?? {}));
  const rows = useLive((r) => lastTimesView(r, liftIds, session.date), [liftIds.join(), session.date]);

  const card = cardFor(plan.plan, logs, draft.focus);
  const currentId = card.kind === 'set' ? card.step.slot.id : card.kind === 'done' ? null : card.block.id;
  const liftOf = (step: Step) => draft.swaps?.[step.slot.id] ?? liftInSlot(step.slot, performances);
  const rest = restClock(plan.plan, logs);
  const closeSheet = () => setSheet(null);

  const logSet = (step: Step, lift: LiftChoice, form: SetForm) => {
    void intents.logSet({ session, slot: step.slot, lift }, entryOf(form)).then((undo) => {
      if (undo === null) return;
      setDraft(afterLog(draft, step));
      toast({ text: `${lift.label} logged`, undo });
    });
  };

  const noteAction = (exercise: Performance | undefined) => <CardAction label="Note" onClick={() => setSheet({ kind: 'note', exercise })} />;

  const cardNode = () => {
    switch (card.kind) {
      case 'set': {
        if (rows === undefined) return <section class="set-card" aria-label="Set" />;
        const { step } = card;
        const lift = liftOf(step);
        const cue = cueFor(step.slot, lift.liftId);
        const hasCue = cue !== undefined || step.block.note !== undefined || plan.notes.length > 0;
        const exercise = performances.find((p) => p.id === performanceIdOf({ session, slot: step.slot, lift }));
        return (
          <SetCard
            step={step}
            lift={lift}
            today={today}
            before={session.date}
            rows={rows}
            book={plan.book}
            performances={performances}
            typed={typedFor(draft, step, lift)}
            rest={rest}
            logged={slotLog(step.slot, logs).sets}
            onForm={(form) => setDraft({ ...draft, set: { slotId: step.slot.id, liftId: lift.liftId, round: step.round, form } })}
            onLog={(form) => logSet(step, lift, form)}
            onSwitch={(choice) => setDraft(withSwap(draft, step, choice))}
            onEdit={(row) => setSheet({ kind: 'edit', row, slot: step.slot })}
            actions={
              <>
                <CardAction label="Swap" onClick={() => setSheet({ kind: 'swap', step, lift })} />
                <CardAction label="Skip" onClick={() => setSheet({ kind: 'skip', step, lift })} />
                {noteAction(exercise)}
                <CardAction label="Cue" disabled={!hasCue} onClick={() => setSheet({ kind: 'cue', cue, block: step.block })} />
              </>
            }
          />
        );
      }
      case 'checklist':
        return (
          <section class="set-card" aria-label="Checklist">
            <div class="focus">
              <FocusTitle rest={rest} title={card.block.title ?? 'Checklist'} />
              <ul class="card-items">
                {card.block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div class="set-controls">
              <button
                type="button"
                class="primary log-set"
                onClick={() => {
                  void intents.checkBlock(session.id, card.block.id).then((undo) => {
                    setDraft(withoutFocus(draft));
                    toast({ text: `${card.block.title ?? 'Checklist'} done`, undo });
                  });
                }}
              >
                Done
              </button>
              <CardActions>{noteAction(undefined)}</CardActions>
            </div>
          </section>
        );
      case 'cardio':
        return (
          <section class="set-card" aria-label="Cardio">
            <div class="focus">
              <FocusTitle rest={rest} title={card.block.title ?? 'Cardio'} />
              {card.block.note !== undefined && <p class="focus-line">{card.block.note}</p>}
              <p class="focus-line">Any workout today counts</p>
            </div>
            <div class="set-controls">
              <button type="button" class="primary log-set" onClick={() => setSheet({ kind: 'cardio' })}>
                Log cardio
              </button>
              <CardActions>
                <CardAction
                  label="Skip"
                  onClick={() => {
                    void intents.checkBlock(session.id, card.block.id).then((undo) => {
                      setDraft(withoutFocus(draft));
                      toast({ text: `Skipped ${card.block.title ?? 'cardio'}`, undo });
                    });
                  }}
                />
                {noteAction(undefined)}
              </CardActions>
            </div>
          </section>
        );
      case 'done':
        return (
          <section class="set-card" aria-label="Done">
            <div class="focus">
              <h2>Plan done</h2>
              <p class="focus-line">{card.optionalLeft.length > 0 ? 'Optional work and extra sets are in Plan' : 'Extra sets are in Plan'}</p>
            </div>
            <div class="set-controls">
              <button type="button" class="primary log-set" onClick={finish}>
                Finish session
              </button>
              <CardActions>{noteAction(undefined)}</CardActions>
            </div>
          </section>
        );
    }
  };

  return (
    <>
      <section class="session" aria-label="Session">
        <SessionBar logs={logs} progress={setsProgress(plan.plan, logs)} onPlan={() => setPlanOpen(true)} onFinish={finish} />
        {cardNode()}
      </section>
      {planOpen && (
        <PlanSheet
          plan={plan}
          logs={logs}
          currentId={currentId}
          onJumpSlot={(slot) => {
            setDraft({ ...draft, focus: { kind: 'slot', slotId: slot.id } });
            setPlanOpen(false);
          }}
          onJumpBlock={(block) => {
            setDraft({ ...draft, focus: { kind: 'block', blockId: block.id } });
            setPlanOpen(false);
          }}
          onEdit={(row, slot) => setSheet({ kind: 'edit', row, slot })}
          onClose={() => setPlanOpen(false)}
        />
      )}
      {sheet?.kind === 'swap' && (
        <SwapSheet
          slot={sheet.step.slot}
          lifts={plan.lifts}
          current={sheet.lift.liftId}
          onClose={closeSheet}
          onPick={(choice) => {
            setDraft(withSwap(draft, sheet.step, choice));
            closeSheet();
          }}
        />
      )}
      {sheet?.kind === 'skip' && (
        <SkipSheet
          label={sheet.lift.label}
          onClose={closeSheet}
          onSkip={(note) => {
            closeSheet();
            void intents.skipSlot(session.id, sheet.step.slot.id, note).then((undo) => {
              setDraft(withoutFocus(draft));
              toast({ text: `Skipped ${sheet.lift.label}`, undo });
            });
          }}
        />
      )}
      {sheet?.kind === 'note' && <NoteSheet session={session} exercise={sheet.exercise} onClose={closeSheet} />}
      {sheet?.kind === 'cue' && <CueSheet cue={sheet.cue} block={sheet.block} notes={plan.notes} onClose={closeSheet} />}
      {sheet?.kind === 'edit' && <EditSetSheet logged={sheet.row} slot={sheet.slot} onClose={closeSheet} />}
      {sheet?.kind === 'cardio' && <WorkoutSheet date={session.date} onClose={closeSheet} />}
    </>
  );
}

export function SessionScreen({ logs, today }: { readonly logs: SessionLogs; readonly today: LocalDate }) {
  const { session } = logs;
  const finish = useFinish(session);
  const plan = useLive((r) => sessionPlanView(r, session), [session.programId, session.day?.key, session.date]);
  if (plan === undefined) return null;
  if (plan === null) {
    return (
      <section class="session" aria-label="Session">
        <SessionBar logs={logs} onFinish={finish} />
        <p class="empty">This plan is not on this phone yet</p>
      </section>
    );
  }
  return <Running key={session.id} logs={logs} plan={plan} today={today} />;
}
