import * as core from '@actions/core'
import {Inputs, NoFileOptions} from './constants'
import {UploadInputs} from './upload-inputs'

import {ObjectCannedACL} from '@aws-sdk/client-s3'

/**
 * Helper to get all the inputs for the action
 */
export function getInputs(): UploadInputs {
  const name = core.getInput(Inputs.Name)
  const path = core.getInput(Inputs.Path, {required: true})
  const overwrite = core.getBooleanInput(Inputs.Overwrite)
  const includeHiddenFiles = core.getBooleanInput(Inputs.IncludeHiddenFiles)

  const ifNoFilesFound = core.getInput(Inputs.IfNoFilesFound)
  const noFileBehavior: NoFileOptions = NoFileOptions[ifNoFilesFound]
  const s3AclOption = core.getInput(Inputs.S3Acl)
  const s3Acl: ObjectCannedACL = ObjectCannedACL[s3AclOption]
  const s3Bucket = core.getInput(Inputs.S3Bucket)
  const s3Prefix = core.getInput(Inputs.S3Prefix)
  const region = core.getInput(Inputs.Region)

  if (!noFileBehavior) {
    core.setFailed(
      `Unrecognized ${
        Inputs.IfNoFilesFound
      } input. Provided: ${ifNoFilesFound}. Available options: ${Object.keys(
        NoFileOptions
      )}`
    )
  }

  if (!s3Acl) {
    core.setFailed(
      `Unrecognized ${
        Inputs.S3Acl
      } input. Provided: ${s3AclOption}. Available options: ${Object.keys(
        ObjectCannedACL
      )}`
    )
  }

  const inputs = {
    artifactName: name,
    searchPath: path,
    ifNoFilesFound: noFileBehavior,
    s3Acl: s3Acl,
    s3Bucket: s3Bucket,
    s3Prefix: s3Prefix,
    region: region,
    overwrite: overwrite,
    includeHiddenFiles: includeHiddenFiles
  } as UploadInputs

  const retentionDaysStr = core.getInput(Inputs.RetentionDays)
  if (retentionDaysStr) {
    inputs.retentionDays = parseInt(retentionDaysStr)
    if (isNaN(inputs.retentionDays)) {
      core.setFailed('Invalid retention-days')
    }
  }

  return inputs
}
