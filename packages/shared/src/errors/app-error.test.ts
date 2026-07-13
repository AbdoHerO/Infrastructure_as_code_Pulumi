import { describe, expect, it } from 'vitest';
import {
  AppError,
  ErrorCode,
  NotFoundError,
  ProviderError,
  UnknownError,
  ValidationError,
  toAppError,
} from './app-error.js';

describe('AppError', () => {
  it('assigns the correct code and name', () => {
    const error = new ValidationError('bad input');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ErrorCode.VALIDATION);
    expect(error.name).toBe('ValidationError');
    expect(error.message).toBe('bad input');
  });

  it('carries structured context', () => {
    const error = new NotFoundError('missing project', { context: { projectId: 'p1' } });
    expect(error.context).toEqual({ projectId: 'p1' });
  });

  it('serializes to a plain object including nested causes', () => {
    const cause = new ProviderError('oci rejected', { context: { status: 401 } });
    const error = new ValidationError('wrapper', { cause });
    const json = error.toJSON();
    expect(json).toMatchObject({
      name: 'ValidationError',
      code: ErrorCode.VALIDATION,
      message: 'wrapper',
      cause: { name: 'ProviderError', code: ErrorCode.PROVIDER },
    });
    expect(JSON.stringify(error)).toContain('oci rejected');
  });

  it('normalises unknown thrown values', () => {
    expect(toAppError(new ValidationError('x'))).toBeInstanceOf(ValidationError);
    expect(toAppError(new Error('native'))).toBeInstanceOf(UnknownError);
    const fromString = toAppError('literal failure');
    expect(fromString).toBeInstanceOf(UnknownError);
    expect(fromString.message).toBe('literal failure');
  });
});
