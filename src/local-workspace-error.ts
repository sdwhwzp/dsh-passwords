/** Failure carrying the wire `code` the companion returns with a failed response. */
export class CompanionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CompanionError';
  }
}
