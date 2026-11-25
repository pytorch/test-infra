// Mock @kubernetes/client-node — all jest.fn() inline to avoid hoisting issues
const mockApi = {
  readNamespacedPod: jest.fn(),
  readNode: jest.fn(),
  listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
  createNamespacedPod: jest.fn(),
  deleteNamespacedPod: jest.fn(),
  listNamespacedSecret: jest.fn().mockResolvedValue({ items: [] }),
  createNamespacedSecret: jest.fn(),
  deleteNamespacedSecret: jest.fn(),
  createSelfSubjectAccessReview: jest.fn()
}

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node')
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      getContexts: jest.fn().mockReturnValue([{ namespace: 'arc-runners' }]),
      makeApiClient: jest.fn().mockReturnValue(mockApi)
    }))
  }
})

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn()
}))

import * as core from '@actions/core'
import { waitForNodeTaintsRemoval } from '../src/k8s'

describe('waitForNodeTaintsRemoval', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'arc-runners'
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should return immediately when env var is not set', async () => {
    delete process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNamespacedPod).not.toHaveBeenCalled()
    expect(mockApi.readNode).not.toHaveBeenCalled()
  })

  it('should return immediately when env var is empty', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = ''

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNamespacedPod).not.toHaveBeenCalled()
    expect(mockApi.readNode).not.toHaveBeenCalled()
  })

  it('should return immediately when env var is whitespace-only', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = '  ,  , '

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNamespacedPod).not.toHaveBeenCalled()
    expect(mockApi.readNode).not.toHaveBeenCalled()
  })

  it('should warn and return when ACTIONS_RUNNER_POD_NAME is not set', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    delete process.env.ACTIONS_RUNNER_POD_NAME

    await waitForNodeTaintsRemoval()

    expect(core.warning).toHaveBeenCalledWith(
      'ACTIONS_RUNNER_POD_NAME not set, skipping node taint wait'
    )
    expect(mockApi.readNamespacedPod).not.toHaveBeenCalled()
  })

  it('should warn and return when runner pod lookup fails', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    mockApi.readNamespacedPod.mockRejectedValue(new Error('pod not found'))

    await waitForNodeTaintsRemoval()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not look up runner pod')
    )
    expect(mockApi.readNode).not.toHaveBeenCalled()
  })

  it('should warn and return when runner pod has no nodeName', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    mockApi.readNamespacedPod.mockResolvedValue({ spec: {} })

    await waitForNodeTaintsRemoval()

    expect(core.warning).toHaveBeenCalledWith(
      'Runner pod has no nodeName assigned, skipping node taint wait'
    )
    expect(mockApi.readNode).not.toHaveBeenCalled()
  })

  it('should return immediately when taints are already cleared', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })
    mockApi.readNode.mockResolvedValue({
      spec: { taints: [] }
    })

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNode).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All configured taints cleared')
    )
  })

  it('should return when node has no taints property', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })
    mockApi.readNode.mockResolvedValue({
      spec: {}
    })

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNode).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All configured taints cleared')
    )
  })

  it('should ignore taints not in the configured list', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })
    mockApi.readNode.mockResolvedValue({
      spec: {
        taints: [
          { key: 'some-other-taint', value: 'true', effect: 'NoSchedule' }
        ]
      }
    })

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNode).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All configured taints cleared')
    )
  })

  it('should poll until taints are cleared', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS = '30'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })

    // First call: taint present. Second call: taint cleared.
    mockApi.readNode
      .mockResolvedValueOnce({
        spec: {
          taints: [
            { key: 'git-cache-not-ready', value: 'true', effect: 'NoSchedule' }
          ]
        }
      })
      .mockResolvedValueOnce({
        spec: { taints: [] }
      })

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNode).toHaveBeenCalledTimes(2)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('still has taints')
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All configured taints cleared')
    )
  })

  it('should wait for ALL configured taint keys to clear', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS =
      'git-cache-not-ready,another-cache'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS = '30'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })

    // Call 1: both taints. Call 2: one cleared. Call 3: both cleared.
    mockApi.readNode
      .mockResolvedValueOnce({
        spec: {
          taints: [
            {
              key: 'git-cache-not-ready',
              value: 'true',
              effect: 'NoSchedule'
            },
            { key: 'another-cache', value: 'true', effect: 'NoSchedule' }
          ]
        }
      })
      .mockResolvedValueOnce({
        spec: {
          taints: [
            { key: 'another-cache', value: 'true', effect: 'NoSchedule' }
          ]
        }
      })
      .mockResolvedValueOnce({
        spec: { taints: [] }
      })

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNode).toHaveBeenCalledTimes(3)
  })

  it('should throw on timeout', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    // Set a very short timeout so we time out quickly
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS = '1'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })

    // Always return the taint
    mockApi.readNode.mockResolvedValue({
      spec: {
        taints: [
          { key: 'git-cache-not-ready', value: 'true', effect: 'NoSchedule' }
        ]
      }
    })

    await expect(waitForNodeTaintsRemoval()).rejects.toThrow(
      /Timed out after 1s waiting for node node-1 taints to clear/
    )
  })

  it('should use default timeout when env var is invalid', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS = 'invalid'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })
    mockApi.readNode.mockResolvedValue({ spec: { taints: [] } })

    await waitForNodeTaintsRemoval()

    // Should not throw — confirms default timeout was used (300s, not NaN)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('timeout: 300s')
    )
  })

  it('should handle node read failures during polling gracefully', async () => {
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS = 'git-cache-not-ready'
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    process.env.ACTIONS_RUNNER_WAIT_FOR_NODE_TAINTS_TIMEOUT_SECONDS = '30'
    mockApi.readNamespacedPod.mockResolvedValue({
      spec: { nodeName: 'node-1' }
    })

    // First read fails, second succeeds with no taints
    mockApi.readNode
      .mockRejectedValueOnce(new Error('transient API error'))
      .mockResolvedValueOnce({ spec: { taints: [] } })

    await waitForNodeTaintsRemoval()

    expect(mockApi.readNode).toHaveBeenCalledTimes(2)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read node')
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All configured taints cleared')
    )
  })
})
