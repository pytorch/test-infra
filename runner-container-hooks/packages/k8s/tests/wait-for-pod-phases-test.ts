// Tests for waitForPodPhases error reporting. Contract: when a pod settles
// into an unexpected, non-backoff phase (e.g. Failed from an admission
// rejection), the thrown error must surface the pod-/container-level
// reason/message — not just the bare phase — and must not duplicate the
// "phase status" prefix.

// --------------------------------------------------------------------------
// Module mocks — declared before importing the module under test.
// --------------------------------------------------------------------------

const mockApi = {
  readNamespacedPod: jest.fn()
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
  debug: jest.fn(),
  error: jest.fn()
}))

import { waitForPodPhases } from '../src/k8s'
import { PodPhase } from '../src/k8s/utils'

describe('waitForPodPhases error reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('surfaces the pod-level reason/message for an admission rejection', async () => {
    mockApi.readNamespacedPod.mockResolvedValue({
      status: {
        phase: PodPhase.FAILED,
        reason: 'TopologyAffinityError',
        message:
          'Pod was rejected: Resources cannot be allocated with Topology locality'
      }
    })

    await expect(
      waitForPodPhases(
        'job-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/phase status Failed/)

    await expect(
      waitForPodPhases(
        'job-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/reason=TopologyAffinityError/)

    await expect(
      waitForPodPhases(
        'job-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/Resources cannot be allocated with Topology locality/)
  })

  it('does not duplicate the "phase status" prefix', async () => {
    mockApi.readNamespacedPod.mockResolvedValue({
      status: { phase: PodPhase.FAILED, reason: 'SomeReason' }
    })

    let message = ''
    try {
      await waitForPodPhases(
        'job-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    const occurrences =
      message.split('is unhealthy with phase status').length - 1
    expect(occurrences).toBe(1)
  })

  it('includes container terminated reasons (e.g. OOMKilled)', async () => {
    mockApi.readNamespacedPod.mockResolvedValue({
      status: {
        phase: PodPhase.FAILED,
        containerStatuses: [
          {
            name: 'job',
            state: {
              terminated: { reason: 'OOMKilled', exitCode: 137 }
            }
          }
        ]
      }
    })

    await expect(
      waitForPodPhases(
        'job-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/containers=\[job: OOMKilled exitCode=137\]/)
  })

  it('still reports the phase when the pod status cannot be read back', async () => {
    // First read (getPodPhase) succeeds with Failed; second read
    // (describePodUnhealth) fails — the error must still name the phase.
    mockApi.readNamespacedPod
      .mockResolvedValueOnce({ status: { phase: PodPhase.FAILED } })
      .mockRejectedValueOnce(new Error('apiserver unavailable'))

    await expect(
      waitForPodPhases(
        'job-pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING])
      )
    ).rejects.toThrow(/phase status Failed.*failed to read pod status/)
  })
})
