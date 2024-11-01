import {HttpClient, HttpClientResponse} from '@actions/http-client'
export async function getEC2Metadata(category: string): Promise<string> {
  const maxRetries = 10
  const http = new HttpClient('seemethere/add-github-ssh-key', undefined, {
    allowRetries: true,
    maxRetries
  })
  const tokenResponse: HttpClientResponse = await http.put(
    `http://169.254.169.254/latest/api/token`,
    '',
    {
      'X-aws-ec2-metadata-token-ttl-seconds': '30'
    }
  )

  if (tokenResponse.message.statusCode !== 200) {
    return ''
  }

  const resp = await http.get(
    `http://169.254.169.254/latest/meta-data/${category}`,
    {
      'X-aws-ec2-metadata-token': await tokenResponse.readBody()
    }
  )

  if (resp.message.statusCode !== 200) {
    return ''
  }
  return resp.readBody()
}
