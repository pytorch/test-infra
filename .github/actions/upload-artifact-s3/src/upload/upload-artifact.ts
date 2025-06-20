import * as core from '@actions/core'
import {findFilesToUpload} from '../shared/search'
import {getInputs} from './input-helper'
import {NoFileOptions} from './constants'
import {uploadArtifact} from '../shared/upload-artifact'
import {UploadArtifactOptions} from '../shared/interfaces'

export async function run(): Promise<void> {
  const inputs = getInputs()
  const searchResult = await findFilesToUpload(
    inputs.searchPath,
    inputs.includeHiddenFiles
  )
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
    const s = searchResult.filesToUpload.length === 1 ? '' : 's'
    core.info(
      `With the provided path, there will be ${searchResult.filesToUpload.length} file${s} uploaded`
    )
    core.debug(`Root artifact directory is ${searchResult.rootDirectory}`)

    const options: UploadArtifactOptions = {}
    if (inputs.retentionDays) {
      options.retentionDays = inputs.retentionDays
    }

    if (inputs.s3Acl) {
      options.s3Acl = inputs.s3Acl
    }

    if (inputs.overwrite !== undefined) {
      options.overwrite = inputs.overwrite
    }

    await uploadArtifact(
      inputs.region,
      inputs.s3Bucket,
      inputs.s3Prefix,
      inputs.artifactName,
      searchResult.filesToUpload,
      searchResult.rootDirectory,
      options
    )
  }
}
