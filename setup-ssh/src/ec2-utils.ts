import {HttpClient} from '@actions/http-client'

export async function getEC2Metadata(category: string): Promise<string> {
  const maxRetries = 10
  const http = new HttpClient('seemethere/add-github-ssh-key', undefined, {
    allowRetries: true,
    maxRetries
  })
  const resp = await http.get(
    `http://169.254.169.254/latest/meta-data/${category}`
  )
  if (resp.message.statusCode !== 200) {
    return ''
  }
  return resp.readBody()
}
