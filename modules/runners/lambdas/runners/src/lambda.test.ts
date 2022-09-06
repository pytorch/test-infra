import { scaleDown as scaleDownL, scaleUp as scaleUpL } from './lambda';

import { Context, SQSEvent, ScheduledEvent } from 'aws-lambda';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';
import scaleDown from './scale-runners/scale-down';
import { scaleUp } from './scale-runners/scale-up';

jest.mock('./scale-runners/scale-down');
jest.mock('./scale-runners/scale-up');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();
});

describe('scaleUp', () => {
  it('succeeds', async () => {
    const mockedScaleUp = mocked(scaleUp).mockResolvedValue(undefined);
    const callback = jest.fn();
    await scaleUpL(
      {
        Records: [
          { eventSource: 'aws:sqs', body: '{"id":1}' },
          { eventSource: 'aws:sqs', body: '{"id":2}' },
        ],
      } as unknown as SQSEvent,
      {} as unknown as Context,
      callback,
    );
    expect(mockedScaleUp).toBeCalledTimes(2);
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 1 });
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 2 });
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(null);
  });

  it('fails', async () => {
    const mockedScaleUp = mocked(scaleUp).mockRejectedValue(Error('error'));
    const callback = jest.fn();
    await scaleUpL(
      {
        Records: [
          { eventSource: 'aws:sqs', body: '{"id":1}' },
          { eventSource: 'aws:sqs', body: '{"id":2}' },
        ],
      } as unknown as SQSEvent,
      {} as unknown as Context,
      callback,
    );
    expect(mockedScaleUp).toBeCalledTimes(1);
    expect(mockedScaleUp).toBeCalledWith('aws:sqs', { id: 1 });
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith('Failed handling SQS event');
  });
});

describe('scaleDown', () => {
  it('succeeds', async () => {
    const mockedScaleDown = mocked(scaleDown).mockResolvedValue(undefined);
    const callback = jest.fn();
    await scaleDownL({} as unknown as ScheduledEvent, {} as unknown as Context, callback);
    expect(mockedScaleDown).toBeCalledTimes(1);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(null);
  });

  it('fails', async () => {
    const mockedScaleDown = mocked(scaleDown).mockRejectedValue(Error('error'));
    const callback = jest.fn();
    await scaleDownL({} as unknown as ScheduledEvent, {} as unknown as Context, callback);
    expect(mockedScaleDown).toBeCalledTimes(1);
    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith('Failed');
  });
});
