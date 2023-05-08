import {
  expBackOff,
  getBoolean,
  getDelay,
  getDelayWithJitter,
  getDelayWithJitterRetryCount,
  getRepo,
  getRepoKey,
  groupBy,
  shuffleArrayInPlace,
  stochaticRunOvershoot,
} from './utils';
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

  describe('groupBy', () => {
    it('just check grouping', () => {
      const grouped = groupBy(['asdf', 'qwer', 'as', 'zxcv', 'fg', '123'], (str) => {
        return str.length;
      });

      expect(grouped.size).toEqual(3);
      expect(grouped.get(4)).toEqual(['asdf', 'qwer', 'zxcv']);
      expect(grouped.get(3)).toEqual(['123']);
      expect(grouped.get(2)).toEqual(['as', 'fg']);
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

  describe('getDelay', () => {
    it('test some numbers', () => {
      expect(getDelay(0, 3)).toEqual(3);
      expect(getDelay(1, 3)).toEqual(6);
      expect(getDelay(2, 3)).toEqual(12);
      expect(getDelay(3, 3)).toEqual(24);

      expect(getDelay(0, 5)).toEqual(5);
      expect(getDelay(1, 5)).toEqual(10);
      expect(getDelay(2, 5)).toEqual(20);
      expect(getDelay(3, 5)).toEqual(40);
    });
  });

  describe('getDelayWithJitter', () => {
    it('have jitter == 0', () => {
      expect(getDelayWithJitter(20, 0.0)).toEqual(20);
      expect(getDelayWithJitter(0, 0.0)).toEqual(0);
      expect(getDelayWithJitter(100, 0.0)).toEqual(100);
      expect(getDelayWithJitter(100, -0.5)).toEqual(100);
      expect(getDelayWithJitter(-100, 0.0)).toEqual(0);
    });

    it('jitter is in between bounds', () => {
      const checks = 10000;
      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitter(20, 0.1);
        expect(r).toBeLessThanOrEqual(22);
        expect(r).toBeGreaterThanOrEqual(18);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitter(100, 0.5);
        expect(r).toBeLessThanOrEqual(150);
        expect(r).toBeGreaterThanOrEqual(50);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitter(1000, 1.0);
        expect(r).toBeLessThanOrEqual(2000);
        expect(r).toBeGreaterThanOrEqual(0);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitter(1000, 2.0);
        expect(r).toBeLessThanOrEqual(3000);
        expect(r).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getDelayWithJitter', () => {
    it('have jitter == 0', () => {
      expect(getDelayWithJitterRetryCount(0, 20, 0.0)).toEqual(20);
      expect(getDelayWithJitterRetryCount(1, 20, 0.0)).toEqual(40);
      expect(getDelayWithJitterRetryCount(2, 20, 0.0)).toEqual(80);
      expect(getDelayWithJitterRetryCount(-1, 20, 0.0)).toEqual(20);

      expect(getDelayWithJitterRetryCount(0, 0, 0.0)).toEqual(0);
      expect(getDelayWithJitterRetryCount(1, 0, 0.0)).toEqual(0);
      expect(getDelayWithJitterRetryCount(2, 0, 0.0)).toEqual(0);
      expect(getDelayWithJitterRetryCount(-1, 0, 0.0)).toEqual(0);

      expect(getDelayWithJitterRetryCount(0, 100, 0.0)).toEqual(100);
      expect(getDelayWithJitterRetryCount(1, 100, 0.0)).toEqual(200);
      expect(getDelayWithJitterRetryCount(2, 100, 0.0)).toEqual(400);
      expect(getDelayWithJitterRetryCount(-1, 100, 0.0)).toEqual(100);

      expect(getDelayWithJitterRetryCount(0, 100, -0.5)).toEqual(100);
      expect(getDelayWithJitterRetryCount(1, 100, -0.5)).toEqual(200);
      expect(getDelayWithJitterRetryCount(2, 100, -0.5)).toEqual(400);
      expect(getDelayWithJitterRetryCount(-1, 100, -0.5)).toEqual(100);

      expect(getDelayWithJitterRetryCount(0, -100, 0.0)).toEqual(0);
      expect(getDelayWithJitterRetryCount(1, -100, 0.0)).toEqual(0);
      expect(getDelayWithJitterRetryCount(2, -100, 0.0)).toEqual(0);
      expect(getDelayWithJitterRetryCount(-1, -100, 0.0)).toEqual(0);
    });

    it('jitter is in between bounds', () => {
      const checks = 10000;
      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitterRetryCount(0, 20, 0.1);
        expect(r).toBeLessThanOrEqual(22);
        expect(r).toBeGreaterThanOrEqual(20);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitterRetryCount(1, 20, 0.1);
        expect(r).toBeLessThanOrEqual(44);
        expect(r).toBeGreaterThanOrEqual(40);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitterRetryCount(2, 20, 0.1);
        expect(r).toBeLessThanOrEqual(88);
        expect(r).toBeGreaterThanOrEqual(80);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitterRetryCount(0, 100, 0.5);
        expect(r).toBeLessThanOrEqual(150);
        expect(r).toBeGreaterThanOrEqual(100);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitterRetryCount(1, 1000, 1.0);
        expect(r).toBeLessThanOrEqual(4000);
        expect(r).toBeGreaterThanOrEqual(1000);
      }

      for (let i = 0; i < checks; i += 1) {
        const r = getDelayWithJitterRetryCount(0, 1000, 2.0);
        expect(r).toBeLessThanOrEqual(3000);
        expect(r).toBeGreaterThanOrEqual(1000);
      }
    });
  });
});

describe('shuffleArrayInPlace', () => {
  it('empty array, is empty', () => {
    expect(shuffleArrayInPlace([])).toEqual([]);
  });

  it('expects the array to be randomized, contain all items and be returned', () => {
    const arr = Array.from(Array(10).keys());
    const arrResult = shuffleArrayInPlace(arr);
    expect(arrResult).toBe(arr);
    for (const number of Array(10).keys()) {
      expect(arr).toContain(number);
    }
  });

  describe('stochaticRunOvershoot', () => {
    afterEach(() => {
      jest.spyOn(global.Math, 'random').mockRestore();
    });

    it('test some values', () => {
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.0);
      expect(stochaticRunOvershoot(0, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.5);
      expect(stochaticRunOvershoot(0, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(1.0);
      expect(stochaticRunOvershoot(0, 100, 10)).toBe(true);

      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.0);
      expect(stochaticRunOvershoot(4, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.5);
      expect(stochaticRunOvershoot(4, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.6249);
      expect(stochaticRunOvershoot(4, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.6251);
      expect(stochaticRunOvershoot(4, 100, 10)).toBe(false);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(1.0);
      expect(stochaticRunOvershoot(4, 100, 10)).toBe(false);

      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.0);
      expect(stochaticRunOvershoot(12, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.00244139);
      expect(stochaticRunOvershoot(12, 100, 10)).toBe(true);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.00244141);
      expect(stochaticRunOvershoot(12, 100, 10)).toBe(false);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(0.5);
      expect(stochaticRunOvershoot(12, 100, 10)).toBe(false);
      jest.spyOn(global.Math, 'random').mockReturnValueOnce(1.0);
      expect(stochaticRunOvershoot(12, 100, 10)).toBe(false);
    });
  });
});
