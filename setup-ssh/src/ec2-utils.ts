import {HttpClient} from '@actions/http-client'

export async function getEC2Metadata(category: string): Promise<string> {
  const maxRetries = 10
  const http = new HttpClient('seemethere/add-github-ssh-key', undefined, {
    allowRetries: true,
    maxRetries
  })
  // convert these two curls:
  // curl -H "X-aws-ec2-metadata-token: $(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 30")" -fsSL "http://169.254.169.254/latest/meta-data/${category}"
    const tokenResponse = await http.put(
    `http://169.254.169.254/latest/api/token`, undefined, {
      headers: {
        'X-aws-ec2-metadata-token-ttl-seconds': '30'
      }
    }
  )

  if (tokenResponse.message.statusCode !== 200) {
    return ''
  }

  const resp = await http.get(
    `http://169.254.169.254/latest/meta-data/${category}`, {
      headers: {
        'X-aws-ec2-metadata-token': tokenResponse.result
      }
    }
  )
  
  if (resp.message.statusCode !== 200) {
    return ''
  }
  return resp.readBody()
}
