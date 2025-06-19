import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import {S3ObjectMetadata, UploadArtifactOptions} from './interfaces'
import mime from 'mime'
import * as path from 'path'

import {Upload} from '@aws-sdk/lib-storage'
import {
  S3Client,
  PutObjectCommandInput,
  CompleteMultipartUploadCommandOutput,
  S3ServiceException
} from '@aws-sdk/client-s3'

function getFileType(path: string | null): string | undefined {
  if (path === null) {
    return undefined
  }
  const fileType = mime.getType(path)
  if (fileType) {
    return fileType
  }
  return 'application/octet-stream'
}

// function to check and typecast the thrown
// error to the service base error type.
function isS3ServiceError(e: unknown): e is S3ServiceException {
  return !!(e as S3ServiceException)?.$metadata
}

export async function uploadArtifact(
  region: string,
  s3Bucket: string,
  s3Prefix: string,
  artifactName: string,
  filesToUpload: string[],
  rootDirectory: string,
  options: UploadArtifactOptions
) {
  if (s3Prefix !== '') {
    core.info('NOTE: s3-prefix specified, ignoring name parameter')
  }
  // If s3Prefix is left blank then just use the actual default derived from the github context
  const finalS3Prefix =
    s3Prefix === ''
      ? `${github.context.repo.owner}/${github.context.repo.repo}/${github.context.runId}/${artifactName}`
      : s3Prefix
  core.info(`Uploading to s3 prefix: ${finalS3Prefix}`)
  core.debug(`Root artifact directory is ${rootDirectory} `)

  const s3Client = new S3Client({
    region: region,
    maxAttempts: 10
  })

  const canonicalObjectUrlPrefix: string = `https://${s3Bucket}.s3.${region}.amazonaws.com`

  const objects: Record<string, S3ObjectMetadata> = {}

  for await (const fileName of filesToUpload) {
    core.debug(JSON.stringify({rootDirectory: rootDirectory, fileName}))
    // Add trailing path.sep to root directory to solve issues where root directory doesn't
    // look to be relative
    const relativeName = path
      .relative(rootDirectory, fileName)
      .replace(/\\/g, '/')
    const uploadKey = `${finalS3Prefix}/${relativeName}`
    const uploadParams: PutObjectCommandInput = {
      ACL: options.s3Acl,
      Body: fs.createReadStream(fileName),
      Bucket: s3Bucket,
      ContentType: getFileType(uploadKey),
      // conform windows paths to unix style paths
      Key: uploadKey.replace(path.sep, '/')
    }
    if (options.retentionDays) {
      const today = new Date()
      const expirationDate = new Date(today)
      expirationDate.setDate(expirationDate.getDate() + options.retentionDays)
      uploadParams.Expires = expirationDate
    }

    if (!options.overwrite) {
      uploadParams.IfNoneMatch = '*'
    }
    const uploadOptions = {partSize: 10 * 1024 * 1024, queueSize: 5}
    core.info(`Starting upload of ${relativeName}`)
    try {
      const parallelUpload = new Upload({
        client: s3Client,
        params: uploadParams,
        queueSize: uploadOptions.queueSize,
        partSize: uploadOptions.partSize
      })
      const output: CompleteMultipartUploadCommandOutput =
        await parallelUpload.done()
      const canonicalUrl: string = `${canonicalObjectUrlPrefix}/${uploadKey}`
      core.info(
        [
          `Upload complete: ${relativeName} to ${s3Bucket}/${uploadKey}`,
          `ETag: ${output.ETag}`,
          `URL: ${canonicalUrl}`
        ].join('\n')
      )
      objects[uploadKey] = {
        etag: output.ETag,
        canonicalUrl: canonicalUrl
      }
    } catch (err) {
      if (isS3ServiceError(err)) {
        switch (err.$metadata.httpStatusCode) {
          case 412: {
            core.warning(
              `File ${relativeName} already exists in S3 bucket ${s3Bucket} and overwrite is set to ${options.overwrite}. Skipping upload.`
            )
            break
          }
        }
      }
      core.error(`Error uploading ${relativeName}`)
      throw err
    } finally {
      core.info(`Finished upload of ${relativeName}`)
    }
  }
  core.setOutput('uploaded-objects', JSON.stringify(objects))
}
