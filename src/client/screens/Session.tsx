/**
 * A session in progress. The screen holds no where-am-I state: the card comes from the stored sets
 * through cardFor, and rest from restClock, so a reload or a lock has nothing to restore but typed
 * digits, which wait in trainDraft.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LocalDate, Millis } from '../../domain/ids.js';
import type { Performance } from '../../domain/lifts.js';
import type { Block, LiftsBlock, Slot, Step } from '../../domain/program.js';
import { typedLine } from '../../domain/progress.js';
import { blockDone, cardFor, cueFor, liftInSlot, performanceIdOf, restClock, slotLog, type LiftChoice, type LoggedSet, type RestClock, type Session, type SessionLogs } from '../../domain/session.js';
import { now } from '../clock.js';
import type { Finished } from '../intents.js';
import { afterLog, entryOf, typedFor, useTrainDraft, withSwap, withoutFocus, type SetForm } from '../trainDraft.js';
import { lastTimesView, sessionLiftIds, sessionPlanView, useIntents, useLive, type SessionPlan } from '../views.js';
import { blockHeading, restText } from './format.js';
import { CardAction, CardActions, SetCard } from './SetCard.js';
import { CuesSheet, EditSetSheet, NoteSheet, SkipSheet, SwapSheet } from './SessionSheets.js';
import { useNow, useToast } from './ui.js';
import { Waiting } from './Waiting.js';
import { WorkoutSheet } from './Workouts.js';

const KEYBOARD_MIN_PX = 80;

/**
 * iOS keeps the layout viewport under the keyboard, so a fixed card sits behind it. While mounted,
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

function Dots({ filled, total }: { readonly filled: number; readonly total: number }) {
  return (
    <span class="dots" role="img" aria-label={`${filled} of ${total} logged`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} class={i < filled ? 'filled' : undefined} />
      ))}
    </span>
  );
}

function setRowText({ performance, set }: LoggedSet, slot: Slot): string {
  const lift = performance.liftId === slot.liftId ? '' : `${performance.label}, `;
  const note = set.note === undefined ? '' : `, ${set.note}`;
  return `${set.warmup === true ? 'Warm-up, ' : ''}${lift}${typedLine([set], '×')}${note}`;
}

function PlanSlot({ slot, logs, current, onJump, onEdit }: { readonly slot: Slot; readonly logs: SessionLogs; readonly current: boolean; readonly onJump: () => void; readonly onEdit: (row: LoggedSet) => void }) {
  const log = slotLog(slot, logs);
  return (
    <li>
      <button type="button" class="plan-row" aria-current={current ? 'step' : undefined} onClick={onJump}>
        <span class="plan-row-name">{slot.label}</span>
        {log.skipped && <span class="plan-tag">Skipped</span>}
        <Dots filled={log.rounds} total={log.dots} />
      </button>
      {log.sets.map((row) => (
        <button type="button" class="plan-set" key={`${row.performance.id}#${row.index}`} onClick={() => onEdit(row)}>
          {setRowText(row, slot)}
        </button>
      ))}
    </li>
  );
}

function BlockRow({ block, heading, logs, current, onJump }: { readonly block: Exclude<Block, LiftsBlock>; readonly heading: string; readonly logs: SessionLogs; readonly current: boolean; readonly onJump: () => void }) {
  return (
    <ul class="list">
      <li>
        <button type="button" class="plan-row" aria-current={current ? 'step' : undefined} onClick={onJump}>
          <span class="plan-row-name">{heading}</span>
          {block.optional === true && <span class="plan-tag">Optional</span>}
          <Dots filled={blockDone(block, logs) ? 1 : 0} total={1} />
        </button>
      </li>
    </ul>
  );
}

function Plan({ plan, logs, currentId, onJumpSlot, onJumpBlock, onEdit }: {
  readonly plan: SessionPlan;
  readonly logs: SessionLogs;
  /** The slot or block on the card. */
  readonly currentId: string | null;
  readonly onJumpSlot: (slot: Slot) => void;
  readonly onJumpBlock: (block: Block) => void;
  readonly onEdit: (row: LoggedSet, slot: Slot) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const reveal = (block: ScrollLogicalPosition) => scroller.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block });
  useLayoutEffect(() => reveal('center'), [currentId]);
  // The card's height moves with what it holds, which shrinks the plan under the current slot.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => reveal('nearest'));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div class="session-plan" ref={scroller}>
      {plan.parts.map((part) => {
        const { block } = part;
        const heading = blockHeading(part);
        if (block.kind !== 'lifts') return <BlockRow key={block.id} block={block} heading={heading ?? ''} logs={logs} current={currentId === block.id} onJump={() => onJumpBlock(block)} />;
        return (
          <section key={block.id} aria-label={heading ?? undefined}>
            {(heading !== null || block.optional === true) && (
              <header class="plan-block-head">
                <h3 class="plan-block-heading">{heading}</h3>
                {block.optional === true && <span class="plan-tag">Optional</span>}
              </header>
            )}
            <ul class="list">
              {block.slots.map((slot) => (
                <PlanSlot key={slot.id} slot={slot} logs={logs} current={currentId === slot.id} onJump={() => onJumpSlot(slot)} onEdit={(row) => onEdit(row, slot)} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function RestPill({ clock }: { readonly clock: RestClock }) {
  useNow(1000);
  const at = now();
  return (
    <p class={at > clock.endsAt ? 'rest-pill over' : 'rest-pill'} role="timer">
      {restText(clock.endsAt, at)}
    </p>
  );
}

function Elapsed({ from }: { readonly from: Millis | undefined }) {
  useNow(30_000);
  return <>{from === undefined ? '' : `${Math.max(0, Math.floor((now() - from) / 60_000))} min`}</>;
}

function SessionBar({ logs, onFinish }: { readonly logs: SessionLogs; readonly onFinish: () => void }) {
  const { session } = logs;
  return (
    <header class="session-bar">
      <div class="session-title">
        <h1>{session.day?.label ?? 'Session'}</h1>
        <p>
          <span data-testid="elapsed">
            <Elapsed from={session.startedAt} />
          </span>
          <Waiting />
        </p>
      </div>
      <button type="button" class="text-button session-finish" onClick={onFinish}>
        Finish
      </button>
    </header>
  );
}

function finishedToast(finished: Finished, label: string) {
  switch (finished.kind) {
    case 'already':
      return null;
    case 'dropped':
      return { text: 'Nothing logged, so it does not count', undo: finished.undo };
    case 'finished':
      switch (finished.diary) {
        case 'added':
          return { text: `Finished ${label}, ${finished.minutes ?? 0} min in the diary`, undo: finished.undo };
        case 'no-sets':
          return { text: `Finished ${label}`, undo: finished.undo };
        case 'no-weight':
          return { text: `Finished ${label}. Add a weigh-in to count its burn.`, undo: finished.undo };
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

/** Which sheet is over the session, each with what it needs, so one can only open with its data. */
type OpenSheet =
  | { readonly kind: 'swap'; readonly step: Step; readonly lift: LiftChoice }
  | { readonly kind: 'skip'; readonly step: Step; readonly lift: LiftChoice }
  | { readonly kind: 'note'; readonly exercise: Performance | undefined }
  | { readonly kind: 'cues'; readonly cue: string | undefined; readonly block: LiftsBlock }
  | { readonly kind: 'edit'; readonly row: LoggedSet; readonly slot: Slot }
  | { readonly kind: 'cardio' };

function Running({ logs, plan, today }: { readonly logs: SessionLogs; readonly plan: SessionPlan; readonly today: LocalDate }) {
  const { session, performances } = logs;
  const intents = useIntents();
  const toast = useToast();
  const finish = useFinish(session);
  const [draft, setDraft] = useTrainDraft(session.id);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
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
        const hasCues = cue !== undefined || step.block.note !== undefined || plan.notes.length > 0;
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
            onForm={(form) => setDraft({ ...draft, set: { slotId: step.slot.id, liftId: lift.liftId, round: step.round, form } })}
            onLog={(form) => logSet(step, lift, form)}
            onSwitch={(choice) => setDraft(withSwap(draft, step, choice))}
            actions={
              <CardActions>
                <CardAction label="Swap" onClick={() => setSheet({ kind: 'swap', step, lift })} />
                <CardAction label="Skip" onClick={() => setSheet({ kind: 'skip', step, lift })} />
                {noteAction(exercise)}
                <CardAction label="Cues" disabled={!hasCues} onClick={() => setSheet({ kind: 'cues', cue, block: step.block })} />
              </CardActions>
            }
          />
        );
      }
      case 'checklist':
        return (
          <section class="set-card" aria-label="Checklist">
            <div class="set-card-body">
              <header class="set-card-head">
                <h2>{card.block.title ?? 'Checklist'}</h2>
              </header>
              <ul class="card-items">
                {card.block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
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
          </section>
        );
      case 'cardio':
        return (
          <section class="set-card" aria-label="Cardio">
            <div class="set-card-body">
              <header class="set-card-head">
                <h2>{card.block.title ?? 'Cardio'}</h2>
              </header>
              {card.block.note !== undefined && <p class="set-card-line">{card.block.note}</p>}
              <p class="set-card-line">A workout logged today counts for this.</p>
            </div>
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
          </section>
        );
      case 'done':
        return (
          <section class="set-card" aria-label="Done">
            <div class="set-card-body">
              <header class="set-card-head">
                <h2>That is the plan done</h2>
              </header>
              <p class="set-card-line">{card.optionalLeft.length > 0 ? 'Optional work is still in the plan. Tap any slot for it or for an extra set.' : 'Tap any slot for an extra set.'}</p>
            </div>
            <button type="button" class="primary log-set" onClick={finish}>
              Finish session
            </button>
            <CardActions>{noteAction(undefined)}</CardActions>
          </section>
        );
    }
  };

  return (
    <>
      <section class="session" aria-label="Session">
        <SessionBar logs={logs} onFinish={finish} />
        <Plan
          plan={plan}
          logs={logs}
          currentId={currentId}
          onJumpSlot={(slot) => setDraft({ ...draft, focus: { kind: 'slot', slotId: slot.id } })}
          onJumpBlock={(block) => setDraft({ ...draft, focus: { kind: 'block', blockId: block.id } })}
          onEdit={(row, slot) => setSheet({ kind: 'edit', row, slot })}
        />
        {rest !== null && <RestPill clock={rest} />}
        {cardNode()}
      </section>
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
      {sheet?.kind === 'cues' && <CuesSheet cue={sheet.cue} block={sheet.block} notes={plan.notes} onClose={closeSheet} />}
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
        <p class="empty">This session's plan is not on this phone yet.</p>
      </section>
    );
  }
  return <Running key={session.id} logs={logs} plan={plan} today={today} />;
}
