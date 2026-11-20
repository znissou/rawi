/**
 * Free models on OpenRouter come with an end date (`expiration_date`, e.g. HeyGen Voice Turbo's free
 * tier ends on 2026-11-30). rawi warns a few days before, and again once it has ended.
 */
export function expiryNotice(expires: string | undefined, now: Date, warnDays = 3): { daysLeft: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expires ?? '');
  if (!m) return undefined;
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((end - today) / 86_400_000);
  return daysLeft <= warnDays ? { daysLeft } : undefined;
}

/** The warning's text: "ends in 3 days", "ends today", "has ended". */
export function expiryText(name: string, when: string, daysLeft: number): string {
  if (daysLeft > 1) return `${name} stops being free on ${when}, in ${daysLeft} days.`;
  if (daysLeft === 1) return `${name} stops being free tomorrow, ${when}.`;
  if (daysLeft === 0) return `${name} stops being free today, ${when}.`;
  return `${name} stopped being free on ${when}.`;
}
