import {HttpClient, HttpClientResponse} from '@actions/http-client'
// IMDS link-local IPv4 (169.254.169.254) is unreachable from IPv6-only
// environments (e.g. EKS pods without NAT64). Bound the wait and treat any
// failure as "no metadata" so callers can fall back to a non-IMDS source.
export async function getEC2Metadata(category: string): Promise<string> {
  const http = new HttpClient('seemethere/add-github-ssh-key', undefined, {
    allowRetries: true,
    maxRetries: 1,
    socketTimeout: 2000
  })
  let tokenResponse: HttpClientResponse
  try {
    tokenResponse = await http.put(
      `http://169.254.169.254/latest/api/token`,
      '',
      {
        'X-aws-ec2-metadata-token-ttl-seconds': '30'
      }
    )
  } catch {
    return ''
  }

  if (tokenResponse.message.statusCode !== 200) {
    return ''
  }

  let resp: HttpClientResponse
  try {
    resp = await http.get(
      `http://169.254.169.254/latest/meta-data/${category}`,
      {
        'X-aws-ec2-metadata-token': await tokenResponse.readBody()
      }
    )
  } catch {
    return ''
  }

  if (resp.message.statusCode !== 200) {
    return ''
  }
  return resp.readBody()
}
