import {NoFileOptions} from './constants'
import {ObjectCannedACL} from '@aws-sdk/client-s3'

export interface UploadInputs {
  /**
   * The name of the artifact that will be uploaded
   */
  artifactName: string

  /**
   * The search path used to describe what to upload as part of the artifact
   */
  searchPath: string

  /**
   * The desired behavior if no files are found with the provided search path
   */
  ifNoFilesFound: NoFileOptions

  /**
   * Duration after which artifact will expire in days
   */
  retentionDays: number

  /**
   * The S3 ACL to use when uploading the artifact
   */
  s3Acl: ObjectCannedACL

  /**
   * S3 Bucket to uploads to
   */
  s3Bucket: string

  /**
   * S3 Prefix to upload to
   */
  s3Prefix: string

  /**
   * AWS region where your s3 bucket lives
   */
  region: string

  /**
   * Whether or not to replace an existing artifact with the same name
   */
  overwrite: boolean

  /**
   * Whether or not to include hidden files in the artifact
   */
  includeHiddenFiles: boolean
}
