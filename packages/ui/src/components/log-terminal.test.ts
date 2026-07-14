import { describe, expect, it } from 'vitest';
import { isTerminalNearBottom } from './log-terminal.js';

describe('isTerminalNearBottom', () => {
  it('follows output while the terminal is at or near its bottom', () => {
    expect(isTerminalNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(
      true,
    );
    expect(isTerminalNearBottom({ scrollHeight: 1000, scrollTop: 675, clientHeight: 300 })).toBe(
      true,
    );
  });

  it('stops following output after the reader scrolls upward', () => {
    expect(isTerminalNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 300 })).toBe(
      false,
    );
  });
});
