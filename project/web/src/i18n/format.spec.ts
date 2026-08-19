import { afterEach, beforeEach, describe, expect, it, vi, MockInstance } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatFileSize,
  formatLongDayMonth,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatShortDate,
  formatTime,
  localeTag,
} from './format';
import { activeLocale, i18next } from './index';

vi.mock('@cogeto/shared', () => ({
  LOCALE_TAGS: {
    en: 'en-GB',
    de: 'de-DE',
    fr: 'fr-FR',
    hr: 'hr-HR',
  },
}));

vi.mock('./index', () => ({
  activeLocale: vi.fn(),
  i18next: {
    t: vi.fn(),
  },
}));

const mockedActiveLocale = vi.mocked(activeLocale);
const mockedT = vi.mocked(i18next.t) as unknown as ReturnType<typeof vi.fn>;

let dateTimeFormatSpy: MockInstance;
let numberFormatSpy: MockInstance;

describe('format', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedActiveLocale.mockReturnValue('en');
    mockedT.mockImplementation(((key: string, options?: Record<string, unknown>) => {
      if (key === 'common:fileSize.bytes') {
        return `BYTES(${options?.count},${options?.value})`;
      }
      if (key === 'common:fileSize.kilobytes') {
        return `KB(${options?.value})`;
      }
      if (key === 'common:fileSize.megabytes') {
        return `MB(${options?.value})`;
      }
      if (key === 'common:relativeTime.justNow') {
        return 'Just now';
      }
      if (key === 'common:relativeTime.minutes') {
        return `${options?.count} min`;
      }
      if (key === 'common:relativeTime.hours') {
        return `${options?.count} hr`;
      }
      if (key === 'common:relativeTime.days') {
        return `${options?.count} d`;
      }
      return key;
    }) as Parameters<typeof mockedT.mockImplementation>[0]);

    dateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locale: string,
      options?: Intl.DateTimeFormatOptions,
    ) {
      const format = vi.fn(
        (date: Date) => `DT:${locale}:${JSON.stringify(options)}:${date.toISOString()}`,
      );
      return { format };
    } as unknown as typeof Intl.DateTimeFormat);

    numberFormatSpy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (
      locale: string,
      options?: Intl.NumberFormatOptions,
    ) {
      const format = vi.fn((value: number) => `NUM:${locale}:${JSON.stringify(options)}:${value}`);
      return { format };
    } as unknown as typeof Intl.NumberFormat);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('localeTag', () => {
    it('maps the active locale through LOCALE_TAGS', () => {
      mockedActiveLocale.mockReturnValue('fr');
      expect(localeTag()).toBe('fr-FR');
    });

    it('maps an explicit locale', () => {
      expect(localeTag('hr')).toBe('hr-HR');
    });

    it('prefers the explicit locale over the active locale', () => {
      mockedActiveLocale.mockReturnValue('en');
      expect(localeTag('de')).toBe('de-DE');
    });
  });

  describe('date formatters', () => {
    const iso = '2026-05-12T14:32:00Z';

    it('formats dates as short day/month/year with the active locale', () => {
      const result = formatDate(iso);

      expect(result).toBe(
        `DT:en-GB:${JSON.stringify({ year: 'numeric', month: 'short', day: 'numeric' })}:2026-05-12T14:32:00.000Z`,
      );
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    });

    it('formats dates with an explicit locale and Date instance', () => {
      const date = new Date(iso);
      const result = formatDate(date, 'de');

      expect(result).toBe(
        `DT:de-DE:${JSON.stringify({ year: 'numeric', month: 'short', day: 'numeric' })}:${date.toISOString()}`,
      );
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('de-DE', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    });

    it('formats day and month only', () => {
      const result = formatDayMonth(iso);

      expect(result).toBe(
        `DT:en-GB:${JSON.stringify({ month: 'short', day: 'numeric' })}:2026-05-12T14:32:00.000Z`,
      );
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        month: 'short',
        day: 'numeric',
      });
    });

    it('formats long day and month only', () => {
      const result = formatLongDayMonth(iso);

      expect(result).toBe(
        `DT:en-GB:${JSON.stringify({ day: 'numeric', month: 'long' })}:2026-05-12T14:32:00.000Z`,
      );
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        day: 'numeric',
        month: 'long',
      });
    });

    it('formats short numeric dates with no explicit options', () => {
      const result = formatShortDate(iso, 'fr');

      expect(result).toBe(`DT:fr-FR:undefined:2026-05-12T14:32:00.000Z`);
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('fr-FR');
    });

    it('formats date and time together', () => {
      const result = formatDateTime(iso);

      expect(result).toBe(
        `DT:en-GB:${JSON.stringify({ dateStyle: 'short', timeStyle: 'short' })}:2026-05-12T14:32:00.000Z`,
      );
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    });

    it('formats time only', () => {
      const result = formatTime(iso);

      expect(result).toBe(
        `DT:en-GB:${JSON.stringify({ timeStyle: 'short' })}:2026-05-12T14:32:00.000Z`,
      );
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        timeStyle: 'short',
      });
    });
  });

  describe('number formatters', () => {
    it('formats numbers with the active locale', () => {
      mockedActiveLocale.mockReturnValue('de');
      const result = formatNumber(1204);

      expect(result).toBe('NUM:de-DE:undefined:1204');
      expect(numberFormatSpy).toHaveBeenLastCalledWith('de-DE');
    });

    it('formats percentages with one decimal', () => {
      const result = formatPercent(0.819, 'en');

      expect(result).toBe(
        `NUM:en-GB:${JSON.stringify({ style: 'percent', maximumFractionDigits: 1 })}:0.819`,
      );
      expect(numberFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        style: 'percent',
        maximumFractionDigits: 1,
      });
    });
  });

  describe('formatFileSize', () => {
    it('returns null for null or undefined', () => {
      expect(formatFileSize(null)).toBeNull();
      expect(formatFileSize(undefined)).toBeNull();
      expect(mockedT).not.toHaveBeenCalled();
    });

    it('uses the bytes translation for values under 1024', () => {
      const result = formatFileSize(500, 'en');

      expect(result).toBe('BYTES(500,NUM:en-GB:undefined:500)');
      expect(mockedT).toHaveBeenCalledWith('common:fileSize.bytes', {
        count: 500,
        value: 'NUM:en-GB:undefined:500',
      });
      expect(numberFormatSpy).toHaveBeenLastCalledWith('en-GB');
    });

    it('switches to kilobytes at 1024 bytes', () => {
      const result = formatFileSize(1024, 'en');

      expect(result).toBe('KB(NUM:en-GB:{"maximumFractionDigits":0}:1)');
      expect(mockedT).toHaveBeenCalledWith('common:fileSize.kilobytes', {
        value: 'NUM:en-GB:{"maximumFractionDigits":0}:1',
      });
      expect(numberFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        maximumFractionDigits: 0,
      });
    });

    it('switches to megabytes at 1024 * 1024 bytes', () => {
      const result = formatFileSize(2621440, 'en'); // 2.5 MiB

      expect(result).toBe(
        'MB(NUM:en-GB:{"minimumFractionDigits":1,"maximumFractionDigits":1}:2.5)',
      );
      expect(mockedT).toHaveBeenCalledWith('common:fileSize.megabytes', {
        value: 'NUM:en-GB:{"minimumFractionDigits":1,"maximumFractionDigits":1}:2.5',
      });
      expect(numberFormatSpy).toHaveBeenLastCalledWith('en-GB', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
    });
  });

  describe('formatRelativeTime', () => {
    const iso = '2026-05-12T10:00:00Z';
    const base = Date.parse(iso);

    it('returns just now for under 60 seconds', () => {
      const result = formatRelativeTime(iso, base + 59_000);

      expect(result).toBe('Just now');
      expect(mockedT).toHaveBeenCalledWith('common:relativeTime.justNow');
    });

    it('returns minutes for 60 seconds and above', () => {
      const result = formatRelativeTime(iso, base + 60_000);

      expect(result).toBe('1 min');
      expect(mockedT).toHaveBeenCalledWith('common:relativeTime.minutes', { count: 1 });
    });

    it('returns hours for under 24 hours', () => {
      const result = formatRelativeTime(iso, base + 3 * 60 * 60_000);

      expect(result).toBe('3 hr');
      expect(mockedT).toHaveBeenCalledWith('common:relativeTime.hours', { count: 3 });
    });

    it('returns days for under 30 days', () => {
      const result = formatRelativeTime(iso, base + 10 * 24 * 60 * 60_000);

      expect(result).toBe('10 d');
      expect(mockedT).toHaveBeenCalledWith('common:relativeTime.days', { count: 10 });
    });

    it('falls back to a short date after 30 days using the active locale', () => {
      mockedActiveLocale.mockReturnValue('de');
      const result = formatRelativeTime(iso, base + 30 * 24 * 60 * 60_000);

      expect(result).toBe(`DT:de-DE:undefined:2026-05-12T10:00:00.000Z`);
      expect(dateTimeFormatSpy).toHaveBeenLastCalledWith('de-DE');
      expect(mockedT).not.toHaveBeenCalled();
    });
  });
});
