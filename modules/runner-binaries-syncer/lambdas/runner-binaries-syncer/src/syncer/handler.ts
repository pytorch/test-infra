import { Octokit } from '@octokit/rest';
import { PassThrough } from 'stream';
import request from 'request';
import { S3 } from 'aws-sdk';
import AWS from 'aws-sdk';
import yn from 'yn';

const versionKey = 'name';

interface CacheObject {
  bucket: string;
  key: string;
}

async function getCachedVersion(s3: S3, cacheObject: CacheObject): Promise<string | undefined> {
  try {
    const objectTagging = await s3
      .getObjectTagging({
        Bucket: cacheObject.bucket,
        Key: cacheObject.key,
      })
      .promise();
    const versions = objectTagging.TagSet?.filter((t: S3.Tag) => t.Key === versionKey);
    return versions.length === 1 ? versions[0].Value : undefined;
  } catch (e) {
    console.debug('No tags found');
    return undefined;
  }
}
interface ReleaseAsset {
  name: string;
  downloadUrl: string;
}

async function getReleaseAsset(
  runnerOS = 'linux',
  runnerArch = 'x64',
  fetchPrereleaseBinaries = false,
): Promise<ReleaseAsset | undefined> {
  const githubClient = new Octokit();
  const assetsList = await githubClient.repos.listReleases({
    owner: 'actions',
    repo: 'runner',
  });
  if (assetsList.data?.length === 0) {
    return undefined;
  }

  const latestPrereleaseIndex = assetsList.data.findIndex((a) => a.prerelease === true);
  const latestReleaseIndex = assetsList.data.findIndex((a) => a.prerelease === false);

  let asset = undefined;
  if (fetchPrereleaseBinaries && latestPrereleaseIndex < latestReleaseIndex) {
    asset = assetsList.data[latestPrereleaseIndex];
  } else if (latestReleaseIndex != -1) {
    asset = assetsList.data[latestReleaseIndex];
  } else {
    return undefined;
  }
  console.log(`Looking for actions-runner-${runnerOS}-${runnerArch}`)
  const assets = asset.assets?.filter((a) => a.name?.includes(`actions-runner-${runnerOS}-${runnerArch}-`));

  return assets?.length === 1
    ? { name: assets[0].name, downloadUrl: assets[0].browser_download_url }
    : undefined;
}

async function uploadToS3(s3: S3, cacheObject: CacheObject, actionRunnerReleaseAsset: ReleaseAsset): Promise<void> {
  const writeStream = new PassThrough();
  s3.upload({
    Bucket: cacheObject.bucket,
    Key: cacheObject.key,
    Tagging: versionKey + '=' + actionRunnerReleaseAsset.name,
    Body: writeStream,
  }).promise();

  await new Promise<void>((resolve, reject) => {
    console.debug('Start downloading %s and uploading to S3.', actionRunnerReleaseAsset.name);
    request
      .get(actionRunnerReleaseAsset.downloadUrl)
      .pipe(writeStream)
      .on('finish', () => {
        console.info(`The new distribution is uploaded to S3.`);
        resolve();
      })
      .on('error', (error) => {
        reject(error);
      });
  }).catch((error) => {
    console.error(`Exception: ${error}`);
  });
}

export const handle = async (): Promise<void> => {
  const s3 = new AWS.S3();

  const fetchPrereleaseBinaries = yn(process.env.GITHUB_RUNNER_ALLOW_PRERELEASE_BINARIES, { default: false });
  const distributions = [
    {
      runnerOS: "linux",
      runnerArch: "x64",
      s3Key: process.env.S3_OBJECT_KEY_LINUX
    },
    {
      runnerOS: "win",
      runnerArch: "x64",
      s3Key: process.env.S3_OBJECT_KEY_WINDOWS
    }
  ]
  for(const distribution of distributions) {
    console.log({distribution})
    const cacheObject: CacheObject = {
      bucket: process.env.S3_BUCKET_NAME as string,
      key: distribution.s3Key as string,
    };
    if (!cacheObject.bucket || !cacheObject.key) {
      throw Error('Please check all mandatory variables are set.');
    }
    const actionRunnerReleaseAsset = await getReleaseAsset(
      distribution.runnerOS, distribution.runnerArch, fetchPrereleaseBinaries
    );
    if (actionRunnerReleaseAsset === undefined) {
      throw Error('Cannot find GitHub release asset.');
    }

    const currentVersion = await getCachedVersion(s3, cacheObject);
    console.debug('latest: ' + currentVersion);
    if (currentVersion === undefined || currentVersion != actionRunnerReleaseAsset.name) {
      uploadToS3(s3, cacheObject, actionRunnerReleaseAsset);
    } else {
      console.debug('Distribution is up-to-date, no action.');
    }
  }
};
