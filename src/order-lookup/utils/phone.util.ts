/**
 * Normalize customer phone for lookup request + Haravan order matching.
 * - strip separators
 * - +84 / 84… → local 0…
 * - other +CC… → digits only
 */
export function normalizeLookupPhone(value: string): string {
  let phone = String(value || '').replace(/[\s\-().]/g, '');
  if (phone.startsWith('+84')) {
    phone = `0${phone.slice(3)}`;
  } else if (/^84\d{9,}$/.test(phone)) {
    phone = `0${phone.slice(2)}`;
  } else if (phone.startsWith('+')) {
    phone = phone.slice(1);
  }
  return phone;
}

/**
 * Accept VN local (0 + 9–10 digits) and international E.164 digit forms
 * (8–15 digits) after {@link normalizeLookupPhone}.
 */
export function isValidLookupPhone(normalized: string): boolean {
  return /^\d{8,15}$/.test(normalized);
}
