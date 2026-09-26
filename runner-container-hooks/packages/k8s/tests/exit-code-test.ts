import { extractExitCode } from '../src/k8s'
import * as k8s from '@kubernetes/client-node'

describe('extractExitCode', () => {
  it('should return exit code from well-formed V1Status with ExitCode cause', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      message:
        'command terminated with non-zero exit code: error executing in Docker Container: 137',
      details: {
        causes: [
          {
            reason: 'ExitCode',
            message: '137'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBe(137)
  })

  it('should return exit code 1 for normal non-zero exit', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      details: {
        causes: [
          {
            reason: 'ExitCode',
            message: '1'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBe(1)
  })

  it('should return null when no ExitCode cause is present', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      message: 'pod not found',
      details: {
        causes: [
          {
            reason: 'SomeOtherReason',
            message: 'something happened'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBeNull()
  })

  it('should return null when causes array is missing', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      message: 'pod not found'
    }
    expect(extractExitCode(resp)).toBeNull()
  })

  it('should return null when details is missing', () => {
    const resp: k8s.V1Status = {
      status: 'Failure'
    }
    expect(extractExitCode(resp)).toBeNull()
  })

  it('should return null for non-numeric exit code message', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      details: {
        causes: [
          {
            reason: 'ExitCode',
            message: 'not-a-number'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBeNull()
  })

  it('should return null when ExitCode cause has no message', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      details: {
        causes: [
          {
            reason: 'ExitCode'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBeNull()
  })

  it('should return null for null/undefined response', () => {
    expect(extractExitCode(null as any)).toBeNull()
    expect(extractExitCode(undefined as any)).toBeNull()
  })

  it('should handle exit code 0 in a Failure response', () => {
    // Edge case: K8s could theoretically send Failure with exit code 0
    const resp: k8s.V1Status = {
      status: 'Failure',
      details: {
        causes: [
          {
            reason: 'ExitCode',
            message: '0'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBe(0)
  })

  it('should find ExitCode among multiple causes', () => {
    const resp: k8s.V1Status = {
      status: 'Failure',
      details: {
        causes: [
          {
            reason: 'OtherCause',
            message: 'some info'
          },
          {
            reason: 'ExitCode',
            message: '42'
          },
          {
            reason: 'AnotherCause',
            message: 'more info'
          }
        ]
      }
    }
    expect(extractExitCode(resp)).toBe(42)
  })
})
