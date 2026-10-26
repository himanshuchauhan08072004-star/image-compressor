export class ImageError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** Text that is safe to show: only messages we wrote (ImageError.userMessage). Raw browser/library messages and stack traces are never shown. */
export const userMessageOf = (e, fallback = 'Something went wrong.') => (e && typeof e.userMessage === 'string' && e.userMessage ? e.userMessage : fallback);
