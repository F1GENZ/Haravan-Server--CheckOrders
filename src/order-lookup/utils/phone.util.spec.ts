import {
  isValidLookupPhone,
  normalizeLookupPhone,
} from './phone.util';

describe('phone.util', () => {
  describe('normalizeLookupPhone', () => {
    it('strips separators and keeps VN local numbers', () => {
      expect(normalizeLookupPhone('0901 234 567')).toBe('0901234567');
      expect(normalizeLookupPhone('(090) 123-4567')).toBe('0901234567');
    });

    it('converts +84 and 84 prefixes to local 0…', () => {
      expect(normalizeLookupPhone('+84901234567')).toBe('0901234567');
      expect(normalizeLookupPhone('84901234567')).toBe('0901234567');
    });

    it('keeps non-VN international numbers as digits', () => {
      expect(normalizeLookupPhone('+14155552671')).toBe('14155552671');
      expect(normalizeLookupPhone('+44 7911 123456')).toBe('447911123456');
    });

    it('accepts long digit strings used by ID 14 cases', () => {
      expect(normalizeLookupPhone('012345678901234')).toBe('012345678901234');
    });
  });

  describe('isValidLookupPhone', () => {
    it('accepts VN local 10-11 digits and international 8-15 digits', () => {
      expect(isValidLookupPhone('0901234567')).toBe(true);
      expect(isValidLookupPhone('09012345678')).toBe(true);
      expect(isValidLookupPhone('14155552671')).toBe(true);
      expect(isValidLookupPhone('012345678901234')).toBe(true);
    });

    it('rejects too short, too long, or non-digit values', () => {
      expect(isValidLookupPhone('0912345')).toBe(false);
      expect(isValidLookupPhone('0123456789012345')).toBe(false);
      expect(isValidLookupPhone('+84901234567')).toBe(false);
      expect(isValidLookupPhone('')).toBe(false);
    });
  });
});
