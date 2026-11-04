/** Progress: the weeks, the key lifts, and for any one lift, how close the next added weight is and how strong it has got. */
import { useState } from 'preact/hooks';
import type { LocalDate } from '../../domain/ids.js';
import { normalize } from '../../domain/library.js';
import type { LiftId } from '../../domain/lifts.js';
import { loadText, staleBest, type BoardRow, type LiftRange, type RecentSession, type RepsToGo } from '../../domain/progress.js';
import { boardView, liftChartView, loggedLiftsView, showUpView, useLive, type LiftChartView } from '../views.js';
import { count, shortDate } from './format.js';
import { LiftChart, ShowUpCard, changeText, valueText } from './ProgressCharts.js';
import { Row, Segmented, Sheet } from './ui.js';

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

/** "+47 lb · best 5 sessions ago", "1 session". */
function boardDetail(row: BoardRow): string {
  const stale = staleBest(row);
  return [
    ...(row.change === null ? [] : [changeText(row.change, row.mode)]),
    ...(row.spark.length === 1 ? ['1 session'] : []),
    ...(stale === null ? [] : [`best ${stale} sessions ago`]),
  ].join(' · ');
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
        {lifts?.length === 0 && <p class="detail">No lifts logged yet</p>}
        {lifts !== undefined && lifts.length > 0 && shown?.length === 0 && <p class="detail">No lifts match</p>}
        {shown !== undefined && shown.length > 0 && (
          <ul class="list" aria-label="Every lift">
            {shown.map((lift) => (
              <li key={lift.liftId}>
                <Row name={lift.name} end={shortDate(lift.lastDate, today)} onClick={() => onOpen(lift)} />
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

/** The next step. */
function ToGo({ toGo }: { readonly toGo: RepsToGo }) {
  const { load, top, prescribed, sets, missing, ready } = toGo;
  return (
    <>
      {ready ? (
        <p class="hero-line to-go-ready" data-testid="to-go-head">
          <CheckMark />
          <strong>Add weight next time</strong>
        </p>
      ) : (
        <p class="hero-line" data-testid="to-go-head">
          <strong>{count(missing, 'rep')}</strong> from adding weight
        </p>
      )}
      <p class="detail" data-testid="to-go-sub">
        {count(prescribed, 'set')} of {top} at {loadText(load)}
      </p>
      <ol class="to-go-sets" aria-label="Sets at that load">
        {sets.map((set, i) => (
          <li key={i}>
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
    <Row
      name={`${load} × ${reps}`}
      detail={added === null ? undefined : <span class="mark-good">Added {added.amount.toLocaleString('en-US', { maximumFractionDigits: 1 })} {added.unit}</span>}
      end={shortDate(date, today)}
    />
  );
}

/** Rows hold every session once opened, so no value lives only under a finger on the chart. */
function RecentSessions({ view, today }: { readonly view: LiftChartView; readonly today: LocalDate }) {
  const { recent } = view;
  const [all, setAll] = useState(false);
  return (
    <>
      <h3 class="section-heading">Recent sessions</h3>
      <ul class="list" aria-label="Recent sessions">
        {(all ? recent : recent.slice(0, RECENT_ROWS)).map((session) => (
          <li key={session.date}>
            <RecentRow session={session} today={today} />
          </li>
        ))}
      </ul>
      {recent.length > RECENT_ROWS && (
        <button type="button" class="text-button recent-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${recent.length} sessions`}
        </button>
      )}
    </>
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
            <div class="card">
              {view.toGo !== null && <ToGo toGo={view.toGo} />}
              {view.toGo !== null && <hr class="card-rule" />}
              <LiftChart key={range} series={view.ranges[range]} range={range} latest={view.latest} latestMode={view.latestMode} today={today} />
              {view.latest !== null && <Segmented quiet label="Chart range" options={RANGES} value={range} onChange={setRange} />}
            </div>
            {view.recent.length > 0 && <RecentSessions view={view} today={today} />}
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
              <ShowUpCard view={shown[0]} today={today} />
              {shown[1].length > 0 && (
                <>
                  <h3 class="section-heading">Key lifts</h3>
                  <ul class="list" aria-label="Key lifts" data-testid="board">
                    {shown[1].map((row) => (
                      <li key={row.liftId}>
                        <Row name={row.name} detail={boardDetail(row)} end={row.latest === null ? undefined : <strong>{valueText(row.latest, row.mode)}</strong>} chevron onClick={() => setLift({ liftId: row.liftId, name: row.name })} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <ul class="list all-lifts-row">
                <li>
                  <Row name="All lifts" chevron onClick={() => setBrowsing(true)} />
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
