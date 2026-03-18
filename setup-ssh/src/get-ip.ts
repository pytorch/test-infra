import {HttpClient} from '@actions/http-client'

// Stolen from https://github.com/haythem/public-ip

/**
 * IPify Response.
 *
 * @see https://www.ipify.org/
 */
interface IPResponse {
  ip: string
}

interface IPs {
  ipv4: string
  ipv6: string
}

export async function getIPs(): Promise<IPs> {
  const maxRetries = 10
  const http = new HttpClient('seemethere/add-github-ssh-key', undefined, {
    allowRetries: true,
    maxRetries
  })

  const ipv4 = await http.getJson<IPResponse>(
    'https://api.ipify.org?format=json'
  )
  const ipv6 = await http.getJson<IPResponse>(
    'https://api64.ipify.org?format=json'
  )
  if (ipv4.result === undefined || ipv6.result === undefined) {
    throw Error(
      `Unable to grab ip addresses for runner see, ipv4 status: "${ipv4.statusCode}", ipv6 status: "${ipv6.statusCode}"`
    )
  }
  return {
    ipv4: ipv4.result?.ip as string,
    ipv6: ipv6.result?.ip as string
  }
}
