import type { ContractEvent } from './api';

function pad(value: number) { return String(value).padStart(2, '0'); }
function icsDate(date: Date) { return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`; }
function escapeIcs(value: string) { return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n'); }
function endDate(start: Date) { return new Date(start.getTime() + 30 * 60 * 1000); }

export function buildBondTimelineIcs(events: ContractEvent[], importerId: string) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TariffShield//Bond Timeline//EN', 'CALSCALE:GREGORIAN'];
  for (const event of events) {
    const start = new Date(event.createdAt);
    if (Number.isNaN(start.getTime())) continue;
    const summary = `TariffShield ${event.kind.replace(/_/g, ' ')}`;
    lines.push('BEGIN:VEVENT', `UID:${escapeIcs(`${importerId}-${event.id}@tariffshield`)}`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(endDate(start))}`, `SUMMARY:${escapeIcs(summary)}`, `DESCRIPTION:${escapeIcs(`Bond event ${event.kind}${event.txHash ? `, tx ${event.txHash}` : ''}`)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function buildBondCalendarLinks(events: ContractEvent[], importerId: string) {
  const ics = buildBondTimelineIcs(events, importerId);
  const next = events.map((event) => ({ event, date: new Date(event.createdAt) })).filter(({ date }) => !Number.isNaN(date.getTime())).sort((a, b) => a.date.getTime() - b.date.getTime())[0];
  if (!next) return { ics, google: null, outlook: null };
  const title = `TariffShield ${next.event.kind.replace(/_/g, ' ')}`;
  const start = icsDate(next.date);
  const end = icsDate(endDate(next.date));
  const details = `Bond event for importer ${importerId}`;
  const google = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${start}/${end}`, details });
  const outlook = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: title, startdt: next.date.toISOString(), enddt: endDate(next.date).toISOString(), body: details });
  return { ics, google: `https://calendar.google.com/calendar/render?${google.toString()}`, outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${outlook.toString()}` };
}