import { getBoolean, getRepoKey, expBackOff, getRepo } from './utils';
import nock from 'nock';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('./utils', () => {
  describe('getRepo', () => {
    it('returns the repo from single string', () => {
      expect(getRepo('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('returns the repo from two strings', () => {
      expect(getRepo('owner', 'repo')).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('throws error when repoDef is not in the correct format', () => {
      expect(() => {
        getRepo('owner/repo/invalid');
      }).toThrowError();
    });
  });

  describe('getBoolean', () => {
    it('check true values', () => {
      expect(getBoolean(true)).toBeTruthy();
      expect(getBoolean('true')).toBeTruthy();
      expect(getBoolean('True')).toBeTruthy();
      expect(getBoolean('tRuE')).toBeTruthy();
      expect(getBoolean(1)).toBeTruthy();
      expect(getBoolean(1.0)).toBeTruthy();
      expect(getBoolean('1')).toBeTruthy();
      expect(getBoolean('1.0')).toBeTruthy();
      expect(getBoolean('on')).toBeTruthy();
      expect(getBoolean('On')).toBeTruthy();
      expect(getBoolean('yes')).toBeTruthy();
      expect(getBoolean('Yes')).toBeTruthy();
      expect(getBoolean('YES')).toBeTruthy();
    });

    it('check false values', () => {
      expect(getBoolean(false)).toBeFalsy();
      expect(getBoolean('false')).toBeFalsy();
      expect(getBoolean('False')).toBeFalsy();
      expect(getBoolean('fAlSe')).toBeFalsy();
      expect(getBoolean(0)).toBeFalsy();
      expect(getBoolean(0.0)).toBeFalsy();
      expect(getBoolean('0')).toBeFalsy();
      expect(getBoolean('0.0')).toBeFalsy();
      expect(getBoolean('off')).toBeFalsy();
      expect(getBoolean('Off')).toBeFalsy();
      expect(getBoolean('no')).toBeFalsy();
      expect(getBoolean('No')).toBeFalsy();
      expect(getBoolean('NO')).toBeFalsy();
    });

    it('check default values', () => {
      expect(getBoolean(undefined)).toBeFalsy();
      expect(getBoolean(undefined, false)).toBeFalsy();
      expect(getBoolean(undefined, true)).toBeTruthy();

      expect(getBoolean('INVALID')).toBeFalsy();
      expect(getBoolean('INVALID', false)).toBeFalsy();
      expect(getBoolean('INVALID', true)).toBeTruthy();
    });
  });

  describe('getRepoKey', () => {
    it('just create one', () => {
      expect(getRepoKey({ owner: 'owner', repo: 'repo' })).toEqual('owner/repo');
    });
  });

  describe('expBackOff', () => {
    it('immediately returns', async () => {
      expect(
        await expBackOff(async () => {
          return 10;
        }),
      ).toEqual(10);
    });

    it('fails twice, then returns', async () => {
      let fails = 2;
      expect(
        await expBackOff(async () => {
          if (fails < 1) return 10;
          fails -= 1;
          throw Error('something something RequestLimitExceeded something something');
        }, 1),
      ).toEqual(10);
    });

    it('fails by other reasons', async () => {
      const msg = 'The error msg';
      await expect(
        expBackOff(async () => {
          throw Error(msg);
        }),
      ).rejects.toThrow(msg);
    });

    it('fails until timeout', async () => {
      const msg = 'something something RequestLimitExceeded something something';
      await expect(
        expBackOff(
          async () => {
            throw Error(msg);
          },
          1,
          8,
        ),
      ).rejects.toThrow(msg);
    });
  });
});
