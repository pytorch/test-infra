import * as core from '@actions/core'
import {Octokit} from '@octokit/rest'
import * as github from '@actions/github'

export async function getPRAuthor(
  octokit: Octokit,
  prNumber: number
): Promise<string> {
  const prInfo = await octokit.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  })
  return prInfo.data.user?.login
}

export function extractCiFlowPrNumber(reference: string): number {
  if (reference.includes('ciflow')) {
    core.info('ciflow reference detected, attempting to extract PR number')
    return Number(reference.split('/').pop())
  }
  return NaN
}
