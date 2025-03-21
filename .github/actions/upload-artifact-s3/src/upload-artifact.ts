import * as core from '@actions/core'
import * as github from '@actions/github'
import * as AWS from 'aws-sdk'
import * as fs from 'fs'
import {getType} from 'mime'
import * as path from 'path'

import {findFilesToUpload} from './search'
import {getInputs} from './input-helper'
import {NoFileOptions} from './constants'

async function run(): Promise<void> {
  try {
    const inputs = getInputs()
    const searchResult = await findFilesToUpload(inputs.searchPath)
    if (searchResult.filesToUpload.length === 0) {
      // No files were found, different use cases warrant different types of behavior if nothing is found
      switch (inputs.ifNoFilesFound) {
        case NoFileOptions.warn: {
          core.warning(
            `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
          )
          break
        }
        case NoFileOptions.error: {
          core.setFailed(
            `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
          )
          break
        }
        case NoFileOptions.ignore: {
          core.info(
            `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
          )
          break
        }
      }
    } else {
      const s3 = new AWS.S3({region: inputs.region, maxRetries: 10})
      if (inputs.s3Prefix !== '') {
        core.info('NOTE: s3-prefix specified, ignoring name parameter')
      }
      // If s3Prefix is left blank then just use the actual default derived from the github context
      const s3Prefix =
        inputs.s3Prefix === ''
          ? `${github.context.repo.owner}/${github.context.repo.repo}/${github.context.runId}/${inputs.artifactName}`
          : inputs.s3Prefix
      const s = searchResult.filesToUpload.length === 1 ? '' : 's'
      core.info(
        `With the provided path, there will be ${searchResult.filesToUpload.length} file${s} uploaded`
      )
      core.info(`Uploading to s3 prefix: ${s3Prefix}`)
      core.debug(`Root artifact directory is ${searchResult.rootDirectory} `)

      const retentionDays = inputs.retentionDays ? inputs.retentionDays : 90
      const today = new Date()
      const expirationDate = new Date(today)
      expirationDate.setDate(expirationDate.getDate() + retentionDays)
      for await (const fileName of searchResult.filesToUpload) {
        core.debug(
          JSON.stringify({rootDirectory: searchResult.rootDirectory, fileName})
        )
        // Add trailing path.sep to root directory to solve issues where root directory doesn't
        // look to be relative
        const relativeName = fileName.replace(
          String.raw`${searchResult.rootDirectory}${path.sep}`,
          ''
        )
        const uploadKey = `${s3Prefix}/${relativeName}`
        const uploadParams = {
          Body: fs.createReadStream(fileName),
          Bucket: inputs.s3Bucket,
          Expires: expirationDate,
          // conform windows paths to unix style paths
          Key: uploadKey.replace(path.sep, '/'),
          ContentType: getType(uploadKey)
        }
        const uploadOptions = {partSize: 10 * 1024 * 1024, queueSize: 5}
        core.info(`Starting upload of ${relativeName}`)
        try {
          await s3.upload(uploadParams, uploadOptions).promise()
        } catch (err) {
          core.error(`Error uploading ${relativeName}`)
          throw err
        } finally {
          core.info(`Finished upload of ${relativeName}`)
        }
      }
    }
  } catch (err) {
    core.setFailed(err.message)
  }
}

run()
