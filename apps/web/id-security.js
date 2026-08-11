export const WEB_V1_MAX_ID_LENGTH = 128;
export const CANONICAL_MAX_ID_LENGTH = 160;

const SAFE_ID_CHARACTERS = "[A-Za-z0-9._:-]";
export const stableIdPattern = maxLength => new RegExp(`^[A-Za-z0-9]${SAFE_ID_CHARACTERS}{0,${maxLength - 1}}$`);
