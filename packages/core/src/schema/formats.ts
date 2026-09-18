/** Explicit format validators; their identity is part of the compiler digest (§8.2). */
import { isIP } from "node:net";

export const FORMATS_VERSION = "sfield-formats@1";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?(z|[+-]\d{2}:\d{2})$/i;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[tT ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(z|[+-]\d{2}:\d{2})$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1]!;
}

export const FORMATS: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
  "date-time": (v) => {
    const m = DATE_TIME_RE.exec(v);
    if (!m) return false;
    return validDate(+m[1]!, +m[2]!, +m[3]!) && +m[4]! < 24 && +m[5]! < 60 && +m[6]! < 61;
  },
  date: (v) => {
    const m = DATE_RE.exec(v);
    return !!m && validDate(+m[1]!, +m[2]!, +m[3]!);
  },
  time: (v) => {
    const m = TIME_RE.exec(v);
    return !!m && +m[1]! < 24 && +m[2]! < 60 && +m[3]! < 61;
  },
  email: (v) => v.length <= 254 && EMAIL_RE.test(v),
  uri: (v) => {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return false;
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
  uuid: (v) => UUID_RE.test(v),
  ipv4: (v) => isIP(v) === 4,
  ipv6: (v) => isIP(v) === 6,
  hostname: (v) => HOSTNAME_RE.test(v),
});

export const FORMAT_NAMES: readonly string[] = Object.freeze(Object.keys(FORMATS).sort());
