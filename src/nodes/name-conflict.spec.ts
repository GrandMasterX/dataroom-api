import { nameForAttempt, splitName } from './name-conflict';

describe('name-conflict', () => {
  describe('splitName', () => {
    it('splits on the last dot', () => {
      expect(splitName('contract.pdf')).toEqual({ stem: 'contract', extension: '.pdf' });
      expect(splitName('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' });
    });

    it('treats a dotfile as having no extension', () => {
      // Otherwise '.env' would be renamed to '. (2)env'.
      expect(splitName('.env')).toEqual({ stem: '.env', extension: '' });
    });

    it('handles names with no dot at all', () => {
      expect(splitName('Financials')).toEqual({ stem: 'Financials', extension: '' });
    });
  });

  describe('nameForAttempt', () => {
    it('returns the original name on the first attempt', () => {
      expect(nameForAttempt('contract.pdf', 1)).toBe('contract.pdf');
    });

    it('appends the counter before the extension', () => {
      expect(nameForAttempt('contract.pdf', 2)).toBe('contract (2).pdf');
      expect(nameForAttempt('contract.pdf', 3)).toBe('contract (3).pdf');
      expect(nameForAttempt('Financials', 2)).toBe('Financials (2)');
    });

    it('never reinterprets parentheses already in the name', () => {
      // Mutation: parse a trailing "(n)" as the counter -> this fails, and a document
      // called "Report (2024)" would silently become "Report (2025)".
      expect(nameForAttempt('Report (2024).pdf', 2)).toBe('Report (2024) (2).pdf');
    });

    it('does not nest suffixes when applied to an already-suffixed name', () => {
      // The caller always passes the name as typed, so attempt 3 of 'doc.pdf' is
      // 'doc (3).pdf' rather than 'doc (2) (2).pdf'.
      expect(nameForAttempt(nameForAttempt('doc.pdf', 1), 3)).toBe('doc (3).pdf');
    });
  });
});
