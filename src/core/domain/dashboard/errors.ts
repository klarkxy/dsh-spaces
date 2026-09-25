import type { DashboardError, ErrorCode } from '../../../shared/dashboard.js';

/** Public messages are fixed; source errors and input values never enter DTOs. */
export class DashboardFault extends Error {
  readonly name = 'DashboardFault';
  constructor(readonly code: ErrorCode, readonly details?: DashboardError['details']) {
    super(code);
  }
  toJSON(): DashboardError {
    return { code: this.code, message: this.code, ...(this.details ? { details: { ...this.details } } : {}) };
  }
}

export function invalid(field: string): never {
  throw new DashboardFault('dashboard/invalid-input', { field });
}
export function limit(actual: number, maximum: number, field: string): void {
  if (actual > maximum) throw new DashboardFault('dashboard/limit-exceeded', { field, limit: maximum, actual });
}
export function publicError(error: unknown): DashboardError {
  return error instanceof DashboardFault ? error.toJSON() : { code: 'dashboard/unavailable', message: 'dashboard/unavailable' };
}
