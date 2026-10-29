/** One JSON object per line on stdout, which launchd appends to ~/Library/Logs/fuel.log. */
export function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}
