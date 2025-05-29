import {describe, expect, jest, it, beforeAll, beforeEach} from '@jest/globals'
import {mockClient} from 'aws-sdk-client-mock'
import 'aws-sdk-client-mock-jest'
import './toBeOnSameDay'
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3'
import * as core from '@actions/core'
import * as path from 'path'
import {run} from '../src/upload/upload-artifact'
import {Inputs} from '../src/upload/constants'
import * as search from '../src/shared/search'
import {setupPaths, recreateTestData} from './mktestdata'

const paths: Record<string, string> = setupPaths()

const fixtures = {
  artifactName: 'artifact-name',
  rootDirectory: paths['root'],
  filesToUpload: [
    `${paths['root']}/folder-a/folder-b/folder-c/search-item1.txt`,
    `${paths['root']}/folder-d/search-item2.txt`,
    `${paths['root']}/folder-d/search-item3.txt`,
    `${paths['root']}/folder-d/search-item4.txt`,
    `${paths['root']}/folder-f/extraSearch-item3.txt`
  ]
}

jest.mock('@actions/github', () => ({
  context: {
    repo: {
      owner: 'pytorch',
      repo: 'test-infra'
    },
    runId: 123,
    serverUrl: 'https://github.com'
  }
}))

function filenameToKey(filename: string): string {
  const relativePath = path.relative(paths['root'], filename)
  return `pytorch/test-infra/123/${fixtures.artifactName}/${relativePath}`
}

const s3Mock = mockClient(S3Client)

jest.mock('@actions/core')

/* eslint-disable no-unused-vars */
const mockInputs = (overrides?: Partial<{[K in Inputs]?: any}>) => {
  const inputs = {
    [Inputs.Name]: 'artifact-name',
    [Inputs.Path]: paths['root'],
    [Inputs.IfNoFilesFound]: 'warn',
    [Inputs.RetentionDays]: 0,
    [Inputs.S3Acl]: 'private',
    [Inputs.S3Bucket]: 'my-bucket',
    [Inputs.S3Prefix]: '',
    [Inputs.Region]: 'us-east-1',
    [Inputs.IncludeHiddenFiles]: false,
    [Inputs.Overwrite]: false,
    ...overrides
  }

  ;(core.getInput as jest.Mock<(name: string) => string>).mockImplementation(
    (name: string) => {
      return inputs[name]
    }
  )
  ;(
    core.getBooleanInput as jest.Mock<(name: string) => boolean>
  ).mockImplementation((name: string) => {
    return inputs[name]
  })

  return inputs
}

describe('upload', () => {
  beforeAll(async () => {
    await recreateTestData(paths)
  })

  beforeEach(async () => {
    mockInputs()

    jest.spyOn(search, 'findFilesToUpload').mockResolvedValue({
      filesToUpload: [fixtures.filesToUpload[0]],
      rootDirectory: fixtures.rootDirectory
    })

    s3Mock.reset()

    // for big files upload:
    s3Mock.on(CreateMultipartUploadCommand).resolves({UploadId: '1'})
    s3Mock.on(UploadPartCommand).resolves({ETag: '1'})

    // for small files upload:
    s3Mock.on(PutObjectCommand).callsFake(async (input, getClient) => {
      getClient().config.endpoint = () => ({hostname: ''} as any)
      return {ETag: '1'}
    })
  })

  it('uploads a single file', async () => {
    await run()
    const calls = s3Mock.calls()
    expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
      Bucket: 'my-bucket',
      Key: filenameToKey(fixtures.filesToUpload[0]),
      Body: expect.anything(),
      ACL: 'private'
    })
  })

  it('uploads multiple files', async () => {
    jest.spyOn(search, 'findFilesToUpload').mockResolvedValue({
      filesToUpload: fixtures.filesToUpload,
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(s3Mock).toHaveReceivedCommandTimes(
      PutObjectCommand,
      fixtures.filesToUpload.length
    )
    for (const filename of fixtures.filesToUpload) {
      expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
        Bucket: 'my-bucket',
        Key: filenameToKey(filename),
        Body: expect.anything(),
        ACL: 'private'
      })
    }
  })

  it('sets outputs', async () => {
    await run()

    const key = filenameToKey(fixtures.filesToUpload[0])
    const prefix = 'https://my-bucket.s3.us-east-1.amazonaws.com'
    const info: Record<string, Record<string, string>> = {}
    info[key] = {
      etag: '1',
      canonicalUrl: `${prefix}/${key}`
    }

    expect(core.setOutput).toHaveBeenCalledWith(
      'uploaded-objects',
      JSON.stringify(info)
    )
  })

  it('supports custom retention days', async () => {
    mockInputs({
      [Inputs.RetentionDays]: 7
    })

    await run()

    const expirationDate = new Date()
    expirationDate.setDate(expirationDate.getDate() + 7)

    const calls = s3Mock.calls()

    expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
      Bucket: 'my-bucket',
      Key: filenameToKey(fixtures.filesToUpload[0]),
      Body: expect.anything(),
      ACL: 'private',
      Expires: expect.toBeOnSameDay(expirationDate)
    })
  })

  it('supports warn if-no-files-found', async () => {
    mockInputs({
      [Inputs.IfNoFilesFound]: 'warn'
    })

    jest.spyOn(search, 'findFilesToUpload').mockResolvedValue({
      filesToUpload: [],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      `No files were found with the provided path: ${fixtures.rootDirectory}. No artifacts will be uploaded.`
    )
  })

  it('supports error if-no-files-found', async () => {
    mockInputs({
      [Inputs.IfNoFilesFound]: 'error'
    })

    jest.spyOn(search, 'findFilesToUpload').mockResolvedValue({
      filesToUpload: [],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      `No files were found with the provided path: ${fixtures.rootDirectory}. No artifacts will be uploaded.`
    )
  })

  it('supports ignore if-no-files-found', async () => {
    mockInputs({
      [Inputs.IfNoFilesFound]: 'ignore'
    })

    jest.spyOn(search, 'findFilesToUpload').mockResolvedValue({
      filesToUpload: [],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.info).toHaveBeenCalledWith(
      `No files were found with the provided path: ${fixtures.rootDirectory}. No artifacts will be uploaded.`
    )
  })

  it('supports overwrite', async () => {
    mockInputs({
      [Inputs.Overwrite]: true
    })

    await run()

    expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
      Bucket: 'my-bucket',
      Key: filenameToKey(fixtures.filesToUpload[0]),
      Body: expect.anything(),
      ACL: 'private'
    })
    expect(s3Mock).not.toHaveReceivedCommandWith(PutObjectCommand, {
      IfNoneMatch: '*'
    })
  })
})
