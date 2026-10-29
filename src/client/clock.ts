import { LocalDate, Millis } from '../domain/ids.js';

export const now = (): Millis => Millis.parse(Date.now());

/** The phone's calendar day, in its own time zone. */
export function localDate(at: Date = new Date()): LocalDate {
  const pad = (n: number) => String(n).padStart(2, '0');
  return LocalDate.parse(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`);
}
