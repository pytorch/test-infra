import {NoFileOptions} from './constants'

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
}
