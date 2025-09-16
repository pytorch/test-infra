import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseTransformer } from '../../src/transformers/base';
import { AlertEvent, Envelope } from '../../src/types';

// Create a concrete implementation for testing the abstract base class
class TestTransformer extends BaseTransformer {
  transform(rawPayload: any, envelope: Envelope): AlertEvent {
    // Minimal implementation for testing base methods
    return {
      schema_version: 1,
      provider_version: 'test:1.0',
      source: 'test',
      state: 'FIRING',
      title: this.normalizeTitle(rawPayload.title),
      description: '',
      reason: '',
      priority: this.extractPriority(rawPayload.priority),
      occurred_at: this.parseTimestamp(rawPayload.timestamp),
      team: this.extractTeam(rawPayload.team),
      resource: { type: 'generic' },
      identity: { org_id: '', rule_id: '' },
      links: {},
      raw_provider: rawPayload,
    };
  }
}

describe('BaseTransformer', () => {
  let transformer: TestTransformer;

  beforeEach(() => {
    transformer = new TestTransformer();
    vi.clearAllMocks();
  });

  describe('extractPriority', () => {
    it('should extract valid P0-P3 priorities', () => {
      expect(transformer['extractPriority']('P0')).toBe('P0');
      expect(transformer['extractPriority']('P1')).toBe('P1');
      expect(transformer['extractPriority']('P2')).toBe('P2');
      expect(transformer['extractPriority']('P3')).toBe('P3');
    });

    it('should handle case insensitive priorities', () => {
      expect(transformer['extractPriority']('p0')).toBe('P0');
      expect(transformer['extractPriority']('p1')).toBe('P1');
      expect(transformer['extractPriority']('P2')).toBe('P2');
      expect(transformer['extractPriority']('P3')).toBe('P3');
    });

    it('should handle numeric priorities', () => {
      expect(transformer['extractPriority']('0')).toBe('P0');
      expect(transformer['extractPriority']('1')).toBe('P1');
      expect(transformer['extractPriority']('2')).toBe('P2');
      expect(transformer['extractPriority']('3')).toBe('P3');
    });

    it('should handle priorities with whitespace', () => {
      expect(transformer['extractPriority'](' P1 ')).toBe('P1');
      expect(transformer['extractPriority']('  2  ')).toBe('P2');
    });

    it('should throw error for empty priority', () => {
      expect(() => transformer['extractPriority']('')).toThrow('Priority field is empty or missing');
      expect(() => transformer['extractPriority'](null as any)).toThrow('Priority field is empty or missing');
      expect(() => transformer['extractPriority'](undefined as any)).toThrow('Priority field is empty or missing');
    });

    it('should throw error for invalid priority values', () => {
      expect(() => transformer['extractPriority']('P4')).toThrow('Invalid priority value: \'P4\'. Expected P0, P1, P2, P3, or 0-3.');
      expect(() => transformer['extractPriority']('HIGH')).toThrow('Invalid priority value: \'HIGH\'. Expected P0, P1, P2, P3, or 0-3.');
      expect(() => transformer['extractPriority']('4')).toThrow('Invalid priority value: \'4\'. Expected P0, P1, P2, P3, or 0-3.');
    });
  });

  describe('normalizeTitle', () => {
    it('should trim whitespace from titles', () => {
      expect(transformer['normalizeTitle'](' Test Alert ')).toBe('Test Alert');
      expect(transformer['normalizeTitle']('  Multiple Spaces  ')).toBe('Multiple Spaces');
    });

    it('should preserve inner whitespace', () => {
      expect(transformer['normalizeTitle']('Alert With  Multiple  Spaces')).toBe('Alert With  Multiple  Spaces');
    });

    it('should throw error for empty titles', () => {
      expect(() => transformer['normalizeTitle']('')).toThrow();
      expect(() => transformer['normalizeTitle'](null as any)).toThrow();
      expect(() => transformer['normalizeTitle'](undefined as any)).toThrow();
    });

    it('should trim whitespace-only titles but not throw', () => {
      expect(transformer['normalizeTitle']('   ')).toBe('');
      expect(transformer['normalizeTitle'](' \t \n ')).toBe('');
    });
  });

  describe('parseTimestamp', () => {
    beforeEach(() => {
      // Mock Date.now() for consistent testing
      vi.setSystemTime(new Date('2025-09-16T12:00:00.000Z'));
    });

    it('should parse valid ISO8601 timestamps', () => {
      const timestamp = '2025-09-16T10:30:00.000Z';
      expect(transformer['parseTimestamp'](timestamp)).toBe(timestamp);
    });

    it('should parse Date objects', () => {
      const date = new Date('2025-09-16T10:30:00.000Z');
      expect(transformer['parseTimestamp'](date)).toBe('2025-09-16T10:30:00.000Z');
    });

    it('should use current time for empty timestamps when not required', () => {
      expect(transformer['parseTimestamp']('')).toBe('2025-09-16T12:00:00.000Z');
      expect(transformer['parseTimestamp'](null as any)).toBe('2025-09-16T12:00:00.000Z');
    });

    it('should throw error for empty timestamps when required', () => {
      expect(() => transformer['parseTimestamp']('', true)).toThrow('Required timestamp field is missing');
      expect(() => transformer['parseTimestamp'](null as any, true)).toThrow('Required timestamp field is missing');
    });

    it('should validate timestamp length for security', () => {
      const longTimestamp = 'a'.repeat(51);
      expect(() => transformer['parseTimestamp'](longTimestamp)).toThrow('Timestamp string too long');
    });

    it('should handle invalid timestamp formats gracefully when not required', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(transformer['parseTimestamp']('invalid-date')).toBe('2025-09-16T12:00:00.000Z');
      expect(consoleSpy).toHaveBeenCalledWith('Invalid timestamp format, using current time: invalid-date');

      consoleSpy.mockRestore();
    });

    it('should throw error for invalid timestamp formats when required', () => {
      expect(() => transformer['parseTimestamp']('invalid-date', true)).toThrow('Invalid timestamp format');
    });

    it('should validate timestamp bounds for security', () => {
      const tooOld = '2010-01-01T00:00:00.000Z';
      const tooFuture = '2030-01-01T00:00:00.000Z';

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should warn and use current time when not required
      expect(transformer['parseTimestamp'](tooOld)).toBe('2025-09-16T12:00:00.000Z');
      expect(transformer['parseTimestamp'](tooFuture)).toBe('2025-09-16T12:00:00.000Z');

      // Should throw when required
      expect(() => transformer['parseTimestamp'](tooOld, true)).toThrow('Timestamp outside reasonable bounds');
      expect(() => transformer['parseTimestamp'](tooFuture, true)).toThrow('Timestamp outside reasonable bounds');

      consoleSpy.mockRestore();
    });

    it('should throw error for invalid Date objects', () => {
      const invalidDate = new Date('invalid');
      expect(() => transformer['parseTimestamp'](invalidDate)).toThrow('Invalid Date object provided (contains NaN)');
    });

    it('should throw error for invalid timestamp types', () => {
      expect(() => transformer['parseTimestamp'](123 as any)).toThrow('Invalid timestamp type: \'number\'');
      expect(() => transformer['parseTimestamp']({} as any)).toThrow('Invalid timestamp type: \'object\'');
    });
  });

  describe('extractTeam', () => {
    it('should extract and normalize team names', () => {
      expect(transformer['extractTeam']('DevOps')).toBe('devops');
      expect(transformer['extractTeam']('DEV-INFRA')).toBe('dev-infra');
      expect(transformer['extractTeam']('Platform Team')).toBe('platform team');
    });

    it('should trim whitespace', () => {
      expect(transformer['extractTeam'](' dev-infra ')).toBe('dev-infra');
      expect(transformer['extractTeam']('  PLATFORM  ')).toBe('platform');
    });

    it('should throw error for empty team names', () => {
      expect(() => transformer['extractTeam']('')).toThrow('Team field is empty or missing');
      expect(() => transformer['extractTeam']('   ')).toThrow('Team field is empty or missing');
      expect(() => transformer['extractTeam'](null as any)).toThrow('Team field is empty or missing');
    });
  });

  describe('safeString', () => {
    it('should return strings as-is', () => {
      expect(transformer['safeString']('test')).toBe('test');
      expect(transformer['safeString']('123')).toBe('123');
    });

    it('should convert non-strings to strings', () => {
      expect(transformer['safeString'](123)).toBe('123');
      expect(transformer['safeString'](true)).toBe('true');
      expect(transformer['safeString'](false)).toBe('false');
    });

    it('should use fallback for null/undefined', () => {
      expect(transformer['safeString'](null)).toBe('');
      expect(transformer['safeString'](undefined)).toBe('');
      expect(transformer['safeString'](null, 'fallback')).toBe('fallback');
      expect(transformer['safeString'](undefined, 'fallback')).toBe('fallback');
    });
  });

  describe('sanitizeString', () => {
    it('should remove potentially dangerous characters', () => {
      expect(transformer['sanitizeString']('<script>alert("xss")</script>')).toBe('scriptalert(xss)/script');
      expect(transformer['sanitizeString']('Test "quotes" and \'apostrophes\'')).toBe('Test quotes and apostrophes');
      expect(transformer['sanitizeString']('javascript:alert(1)')).toBe('alert(1)');
      expect(transformer['sanitizeString']('data:text/html,<script>alert(1)</script>')).toBe('text/html,scriptalert(1)/script');
    });

    it('should remove control characters', () => {
      expect(transformer['sanitizeString']('Test\x00\x1F\x7F')).toBe('Test');
      expect(transformer['sanitizeString']('Normal\nText\r\n')).toBe('NormalText');
    });

    it('should respect max length', () => {
      const longString = 'a'.repeat(300);
      expect(transformer['sanitizeString'](longString, 100)).toHaveLength(100);
      expect(transformer['sanitizeString'](longString, 10)).toBe('aaaaaaaaaa');
    });

    it('should handle empty/null inputs', () => {
      expect(transformer['sanitizeString']('')).toBe('');
      expect(transformer['sanitizeString'](null)).toBe('');
      expect(transformer['sanitizeString'](undefined)).toBe('');
    });

    it('should convert non-strings to strings first', () => {
      expect(transformer['sanitizeString'](123)).toBe('123');
      expect(transformer['sanitizeString'](true)).toBe('true');
    });
  });

  describe('validateUrl', () => {
    it('should validate and return valid HTTP/HTTPS URLs', () => {
      expect(transformer['validateUrl']('https://example.com')).toBe('https://example.com');
      expect(transformer['validateUrl']('http://example.com/path?query=1')).toBe('http://example.com/path?query=1');
    });

    it('should reject invalid protocols', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(transformer['validateUrl']('ftp://example.com')).toBeUndefined();
      expect(transformer['validateUrl']('javascript:alert(1)')).toBeUndefined();
      expect(transformer['validateUrl']('data:text/html,<script>')).toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith('Invalid URL protocol: ftp:');

      consoleSpy.mockRestore();
    });

    it('should handle invalid URL formats', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(transformer['validateUrl']('not-a-url')).toBeUndefined();
      expect(transformer['validateUrl']('http://')).toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith('Invalid URL format: not-a-url');

      consoleSpy.mockRestore();
    });

    it('should handle empty/null URLs', () => {
      expect(transformer['validateUrl']('')).toBeUndefined();
      expect(transformer['validateUrl'](null as any)).toBeUndefined();
      expect(transformer['validateUrl'](undefined as any)).toBeUndefined();
    });

    it('should truncate very long URLs', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const longUrl = 'https://example.com/' + 'a'.repeat(2100);

      const result = transformer['validateUrl'](longUrl);
      expect(result).toHaveLength(2048);
      expect(result?.startsWith('https://example.com/')).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith('URL too long, truncating');

      consoleSpy.mockRestore();
    });

    it('should handle non-string inputs', () => {
      expect(transformer['validateUrl'](123 as any)).toBeUndefined();
      expect(transformer['validateUrl']({} as any)).toBeUndefined();
    });
  });
});