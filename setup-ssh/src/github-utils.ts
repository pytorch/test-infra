import * as core from '@actions/core'
import {Octokit} from '@octokit/rest'
import * as github from '@actions/github'

export async function getPRAuthor(
  octokit: Octokit,
  prNumber: number
): Promise<string> {
  let owner = github.context.repo.owner;
  let repo = github.context.repo.repo;
  try {
    const prInfo = await octokit.pulls.get({
      owner: owner,
      repo: repo,
      pull_number: prNumber
    })
    return prInfo.data.user?.login
  } catch (error) {
    let actor = github.context.actor;
    core.warning(`Failed to get author of PR https://github.com/${owner}/${repo}/pull/${prNumber}: ${error}`)
    core.warning(`Returning ${actor} instead`)
    return actor
  }
}

export function extractCiFlowPrNumber(reference: string): number {
  if (reference.includes('ciflow')) {
    core.info('ciflow reference detected, attempting to extract PR number')
    return Number(reference.split('/').pop())
  }
  return NaN
}
