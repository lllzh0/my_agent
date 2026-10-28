const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Windows reserves device aliases even with extensions, such as CON.txt. */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

export function isWindowsReservedName(name: string): boolean {
	return WINDOWS_RESERVED_BASENAME_RE.test(name);
}

/** Pure validation for early launchers; empty/default selects the implicit profile. */
export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		isWindowsReservedName(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}
