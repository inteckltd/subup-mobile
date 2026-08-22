/**
 * UK mobile helpers.
 *
 * Canonical stored/login format is always E.164 (+44XXXXXXXXXX). Accepted
 * user input formats: "07…", "7…", "+447…", "+4407…", "447…", "4407…"
 * (with optional spaces).
 */

const UK_MOBILE_E164 = /^\+447\d{9}$/;

function stripSpaces(value: string): string {
  return value.replace(/[\s-]/g, '');
}

/** National digits after +44, stripping a UK trunk prefix 0 if present. */
function nationalAfter44(value: string): string {
  return value.startsWith('0') ? value.slice(1) : value;
}

/**
 * Normalises a UK mobile number to E.164 (+44XXXXXXXXXX).
 * Returns null if the input doesn't look like a valid UK mobile number.
 */
export function normalizeUkMobile(input: string): string | null {
  const trimmed = stripSpaces(input.trim());
  if (!trimmed) return null;

  let candidate: string;
  if (trimmed.startsWith('+44')) {
    candidate = `+44${nationalAfter44(trimmed.slice(3))}`;
  } else if (trimmed.startsWith('44')) {
    candidate = `+44${nationalAfter44(trimmed.slice(2))}`;
  } else if (trimmed.startsWith('07')) {
    candidate = `+44${trimmed.slice(1)}`;
  } else if (/^7\d{9}$/.test(trimmed)) {
    candidate = `+44${trimmed}`;
  } else if (trimmed.startsWith('0')) {
    // Non-mobile UK landline prefixes (not 07xx) are not supported.
    return null;
  } else {
    return null;
  }

  return UK_MOBILE_E164.test(candidate) ? candidate : null;
}

/** True if the input normalises to a valid UK mobile number. */
export function isValidUkMobile(input: string): boolean {
  return normalizeUkMobile(input) !== null;
}

/**
 * Masks an E.164 UK mobile for display, e.g. "+447123456789" -> "••••••6789".
 * Falls back to masking whatever digits are present if the format is unexpected.
 */
export function maskMobile(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `••••••${last4}`;
}

/**
 * Formats an E.164 UK mobile for confident display, e.g. "+447123456789" ->
 * "+44 7123 456789". Not called anywhere yet — kept ready for the
 * account/profile screen (main app), which will need to show the user's
 * own mobile number in full rather than masked.
 */
export function formatUkMobileForDisplay(e164: string): string {
  const match = e164.match(/^\+44(\d{4})(\d{6})$/);
  if (!match) return e164;
  return `+44 ${match[1]} ${match[2]}`;
}

/** National format for the edit-profile field, e.g. "07912345678". */
export function ukMobileNationalDigits(e164: string): string {
  const normalised = normalizeUkMobile(e164);
  if (!normalised) return '';
  return `0${normalised.slice(3)}`;
}
