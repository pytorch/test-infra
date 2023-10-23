import os from 'os'

import {getGithubKeys, writeAuthorizedKeys} from './add-github-ssh-key'
import {getIPs} from './get-ip'
import {getPRAuthor, extractCiFlowPrNumber} from './github-utils'
import {getEC2Metadata} from './ec2-utils'

import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/rest'
import {install} from 'source-map-support'

install()

async function run(): Promise<void> {
  try {
    core.info(
      'Please see https://github.com/pytorch/pytorch/wiki/Debugging-using-with-ssh-for-Github-Actions for more info.'
    )
    const activateWithLabel: boolean = core.getBooleanInput(
      'activate-with-label'
    )
    const sshLabel: string = core.getInput('label')
    const github_token: string = core.getInput('github-secret')
    const instructions: string = core.getInput('instructions')
    const removeExistingKeys: boolean = core.getBooleanInput(
      'remove-existing-keys'
    )
    let prNumber = github.context.payload.pull_request?.number as number
    if (github.context.eventName !== 'pull_request') {
      prNumber = extractCiFlowPrNumber(github.context.ref)
      // Only bump out on pull request events if no pull request number could be derived
      if (isNaN(prNumber)) {
        // Attempt to derive prNumber from ciflow
        core.info(
          'Not on pull request and ciflow reference could not be extracted, skipping adding ssh keys'
        )
        return
      }
    }
    const octokit = new Octokit({auth: github_token})
    if (activateWithLabel) {
      const labels = await octokit.issues.listLabelsOnIssue({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: prNumber
      })
      let sshLabelSet = false
      for (const label of labels.data) {
        if (label.name === sshLabel) {
          sshLabelSet = true
        }
      }
      if (!sshLabelSet) {
        core.info(`Label ${sshLabel} not set, skipping adding ssh keys`)
        return
      }
    }
    // Attempt `github.context.actor` first since that's probably right and then
    // attempt the pull request author afterwards
    for (const actor of [
      github.context.actor,
      await getPRAuthor(octokit, prNumber)
    ]) {
      core.info(
        `Grabbing public ssh keys from https://github.com/${actor}.keys`
      )
      const keys = await getGithubKeys(octokit, actor)
      if (keys === '') {
        core.info(`No SSH keys found for user ${actor}`)
        continue
      }
      const authorizedKeysPath = await writeAuthorizedKeys(
        os.homedir(),
        keys,
        removeExistingKeys
      )
      core.info(`Public keys pulled and installed to ${authorizedKeysPath}`)
      let hostname = await getEC2Metadata('public-hostname')
      if (hostname === '') {
        hostname = (await getIPs()).ipv4
      }
      const username = os.userInfo().username
      core.info(`Login using: ssh ${username}@${hostname}`)
      if (instructions) {
        core.info(
          instructions
            .replace('%%hostname%%', hostname)
            .replace('%%username%%', username)
        )
      }
      // Return early if we can get the right keys on the first try
      return
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed(`Failed due to unexpected error ${error}`)
    }
  }
}

run()
