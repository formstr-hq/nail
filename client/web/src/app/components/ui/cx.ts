/**
 * Join conditional class strings. The app builds class lists with
 * `[...].join(' ')` ternaries in dozens of places; this keeps falsy entries out
 * and reads the same, so repeated patterns have one home (AGENTS rule 9).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
