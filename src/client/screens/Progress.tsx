/** Progress: am I showing up, what is moving, and for any one lift, am I getting stronger and how close am I to adding weight. */
import { useState } from 'preact/hooks';
import type { LocalDate } from '../../domain/ids.js';
import { normalize } from '../../domain/library.js';
import type { LiftId } from '../../domain/lifts.js';
import { BOARD_WEEKS, loadText, staleBest, type BoardRow, type LiftRange, type RecentSession, type RepsToGo } from '../../domain/progress.js';
import { boardView, liftChartView, loggedLiftsView, showUpView, useLive, type LiftChartView } from '../views.js';
import { count, shortDate } from './format.js';
import { BoardSpark, LiftCard, ShowUpCard, changeText, valueText } from './ProgressCharts.js';
import { Icon, Segmented, Sheet } from './ui.js';

interface OpenLift {
  readonly liftId: LiftId;
  readonly name: string;
}

const RANGES: readonly { readonly value: LiftRange; readonly label: string }[] = [
  { value: '3m', label: '3 months' },
  { value: '1y', label: '1 year' },
  { value: 'all', label: 'All' },
];
/** Recent sessions listed before "All 40 sessions" opens the rest. */
const RECENT_ROWS = 6;

function BoardLine({ row, onOpen }: { readonly row: BoardRow; readonly onOpen: () => void }) {
  const stale = staleBest(row);
  return (
    <li>
      <button type="button" class="board-row" onClick={onOpen}>
        <span class="board-name">
          {row.name}
          {stale !== null && <small>best {stale} sessions ago</small>}
          {row.latest !== null && row.spark.length === 1 && <small>1 session in {BOARD_WEEKS} weeks</small>}
        </span>
        <BoardSpark values={row.spark} />
        {row.latest === null ? (
          <span class="board-value none">
            <small>Nothing in {BOARD_WEEKS} weeks</small>
          </span>
        ) : (
          <span class="board-value">
            <strong>{valueText(row.latest, row.mode)}</strong>
            {row.change !== null && <small>{changeText(row.change, row.mode)}</small>}
          </span>
        )}
      </button>
    </li>
  );
}

function AllLiftsSheet({ today, onOpen, onClose }: { readonly today: LocalDate; readonly onOpen: (lift: OpenLift) => void; readonly onClose: () => void }) {
  const lifts = useLive((r) => loggedLiftsView(r, today), [today]);
  const [query, setQuery] = useState('');
  const wanted = normalize(query);
  const shown = lifts?.filter((lift) => normalize(lift.name).includes(wanted));
  return (
    <Sheet title="All lifts" onClose={onClose} closeLabel="Done">
      <div class="full-sheet">
        <div class="search">
          <input type="search" aria-label="Search lifts" placeholder="Search lifts" enterKeyHint="search" autoComplete="off" autoCorrect="off" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
        </div>
        {lifts?.length === 0 && <p class="empty">No lifts logged yet.</p>}
        {lifts !== undefined && lifts.length > 0 && shown?.length === 0 && <p class="empty">No lifts match.</p>}
        {shown !== undefined && shown.length > 0 && (
          <ul class="list all-lifts" aria-label="Every lift">
            {shown.map((lift) => (
              <li key={lift.liftId}>
                <button type="button" class="entry-row" onClick={() => onOpen(lift)}>
                  <span class="board-name">{lift.name}</span>
                  <span class="entry-kcal">{shortDate(lift.lastDate, today)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

function CheckMark() {
  return (
    <svg class="icon to-go-check" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function ToGo({ toGo }: { readonly toGo: RepsToGo }) {
  const { load, top, prescribed, sets, missing, ready } = toGo;
  const at = loadText(load);
  const subject = prescribed === 1 ? `The set at ${at}` : `All ${prescribed} sets at ${at}`;
  return (
    <>
      {ready ? (
        <p class="progress-head to-go-ready" data-testid="to-go-head">
          <CheckMark />
          <strong>Add weight next time</strong>
        </p>
      ) : (
        <p class="progress-head" data-testid="to-go-head">
          <strong>{count(missing, 'rep')}</strong> from adding weight
        </p>
      )}
      <p class="progress-sub" data-testid="to-go-sub">
        {subject} {ready ? 'reached' : prescribed === 1 ? 'needs to reach' : 'need to reach'} {top}
      </p>
      <ol class="to-go-sets" aria-label="Sets at that load">
        {sets.map((set, i) => (
          <li key={i}>
            <span class="to-go-name">Set {i + 1}</span>
            <span class="to-go-track">
              <span class="to-go-fill" style={{ width: `${((top - set.missing) / top) * 100}%` }} />
            </span>
            <span class="to-go-count">
              <strong>{set.reps ?? 0}</strong> of {top}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function RecentRow({ session, today }: { readonly session: RecentSession; readonly today: LocalDate }) {
  const { date, load, reps, added } = session;
  return (
    <li>
      <span class="recent-date">{shortDate(date, today)}</span>
      <span class="recent-load">{load}</span>
      <span class="recent-reps">{reps}</span>
      {added !== null && (
        <span class="recent-added">
          Added {added.amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} {added.unit}
        </span>
      )}
    </li>
  );
}

/** Rows hold every session once opened, so no value lives only under a finger on the chart. */
function AddWeightCard({ view, today }: { readonly view: LiftChartView; readonly today: LocalDate }) {
  const { toGo, recent } = view;
  const [all, setAll] = useState(false);
  return (
    <div class="card add-weight">
      {toGo !== null && <ToGo toGo={toGo} />}
      {toGo !== null && <hr class="add-weight-rule" />}
      <p class="recent-title">Recent sessions</p>
      <ul class="recent-rows" aria-label="Recent sessions">
        {(all ? recent : recent.slice(0, RECENT_ROWS)).map((session) => (
          <RecentRow key={session.date} session={session} today={today} />
        ))}
      </ul>
      {recent.length > RECENT_ROWS && (
        <button type="button" class="more-text" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${recent.length} sessions`}
        </button>
      )}
    </div>
  );
}

function LiftSheet({ lift, today, onClose }: { readonly lift: OpenLift; readonly today: LocalDate; readonly onClose: () => void }) {
  const view = useLive((r) => liftChartView(r, lift.liftId, today), [lift.liftId, today]);
  const [range, setRange] = useState<LiftRange>('3m');
  return (
    <Sheet title={lift.name} onClose={onClose} closeLabel="Done">
      <div class="full-sheet">
        {view !== undefined && (
          <>
            <h4 class="group-title question">Am I getting stronger?</h4>
            {view.latest !== null && <Segmented label="Chart range" options={RANGES} value={range} onChange={setRange} />}
            <LiftCard key={range} series={view.ranges[range]} range={range} latest={view.latest} latestMode={view.latestMode} today={today} />
            {view.toGo !== null && <h4 class="group-title question">How close am I to adding weight?</h4>}
            {view.recent.length > 0 && <AddWeightCard view={view} today={today} />}
          </>
        )}
      </div>
    </Sheet>
  );
}

export function ProgressSheet({ today, onClose }: { readonly today: LocalDate; readonly onClose: () => void }) {
  const shown = useLive((r) => Promise.all([showUpView(r, today), boardView(r, today)]), [today]);
  const [browsing, setBrowsing] = useState(false);
  const [lift, setLift] = useState<OpenLift | null>(null);
  return (
    <>
      <Sheet title="Progress" onClose={onClose} closeLabel="Done">
        <div class="full-sheet">
          {shown !== undefined && (
            <>
              <h4 class="group-title question">Am I showing up?</h4>
              <ShowUpCard view={shown[0]} today={today} />
              <h4 class="group-title question">What is moving, what is stuck?</h4>
              <section class="card board" aria-label="Key lifts" data-testid="board">
                {shown[1].length === 0 ? (
                  <p class="progress-sub">No key lifts yet. All lifts has every lift you have logged.</p>
                ) : (
                  <>
                    <p class="progress-sub">Est. 1RM and its change over {BOARD_WEEKS} weeks</p>
                    <ul class="board-rows">
                      {shown[1].map((row) => (
                        <BoardLine key={row.liftId} row={row} onOpen={() => setLift({ liftId: row.liftId, name: row.name })} />
                      ))}
                    </ul>
                  </>
                )}
              </section>
              <ul class="list all-lifts-row">
                <li>
                  <button type="button" class="row-button disclosure" onClick={() => setBrowsing(true)}>
                    All lifts
                    <Icon name="chevronRight" />
                  </button>
                </li>
              </ul>
            </>
          )}
        </div>
      </Sheet>
      {browsing && <AllLiftsSheet today={today} onOpen={setLift} onClose={() => setBrowsing(false)} />}
      {lift !== null && <LiftSheet lift={lift} today={today} onClose={() => setLift(null)} />}
    </>
  );
}
