// Thursday reminder delivered through the phone's own calendar. A calendar
// alarm fires reliably on Android and iOS even when the app is closed, and
// needs no push server or personal data on a third-party service.

function pad(n) { return String(n).padStart(2, '0'); }

function nextThursday(time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  const diff = (4 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  if (d < new Date()) d.setDate(d.getDate() + 7);
  return d;
}

function local(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

const TITLE = 'Record your weekly voice notes';
const MESSAGE = 'Good evening. Please take two minutes to record your weekly notes. Your report will be generated automatically.';

export function buildICS(time, appUrl) {
  const start = nextThursday(time);
  const end = new Date(start.getTime() + 15 * 60000);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const url = `${appUrl}?action=record`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Voice Weekly Report//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:weekly-report-reminder-${Date.now()}@voice-weekly-report`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${local(start)}`,
    `DTEND:${local(end)}`,
    'RRULE:FREQ=WEEKLY;BYDAY=TH',
    `SUMMARY:${TITLE}`,
    `DESCRIPTION:${MESSAGE}\\n\\nOpen the app: ${url}`,
    `URL:${url}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${TITLE}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Follow-up: weekly voice notes not yet recorded?',
    'TRIGGER:PT3H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

export function googleCalendarLink(time, appUrl) {
  const start = nextThursday(time);
  const end = new Date(start.getTime() + 15 * 60000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: TITLE,
    details: `${MESSAGE}\n\nOpen the app: ${appUrl}?action=record`,
    dates: `${local(start)}/${local(end)}`,
    recur: 'RRULE:FREQ=WEEKLY;BYDAY=TH'
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// In-app nudge shown on the reminder day once the time has passed.
export function isReminderDue(time, notesThisWeek) {
  const now = new Date();
  if (now.getDay() !== 4) return false;
  const [h, m] = time.split(':').map(Number);
  return notesThisWeek === 0 && (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m));
}
