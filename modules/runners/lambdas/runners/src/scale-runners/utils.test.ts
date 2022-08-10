import { getBoolean } from './utils';
import nock from 'nock';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

describe('./utils', () => {
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
});
