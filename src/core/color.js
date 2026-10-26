const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (c) => typeof c === 'string' && HEX.test(c);
/** Only ever hand canvas a validated #rrggbb value. */
export const normalizeHex = (c, fallback = '#ffffff') => (isHexColor(c) ? c.toLowerCase() : fallback);
