import {HttpClient, HttpClientResponse} from '@actions/http-client'

// IMDS may be reachable over IPv6 [fd00:ec2::254] (IPv6-only EKS pods
// without NAT64) or IPv4 169.254.169.254 elsewhere; iterate both and
// return the first that responds. IMDS is link-local and must never be
// routed through an HTTP proxy, so each call temporarily prepends both
// hosts to no_proxy. HttpClient's socketTimeout is idle-only, so each
// request is also wrapped in a hard 2s deadline to bound blackholed SYNs.
const IMDS_HOSTS = ['[fd00:ec2::254]', '169.254.169.254']
const IMDS_REQUEST_TIMEOUT_MS = 2000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`IMDS request exceeded ${ms}ms`)),
      ms
    )
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }) as Promise<T>
}

export async function getEC2Metadata(category: string): Promise<string> {
  const http = new HttpClient('seemethere/add-github-ssh-key', undefined, {
    allowRetries: true,
    maxRetries: 1,
    socketTimeout: IMDS_REQUEST_TIMEOUT_MS
  })

  // @actions/http-client reads no_proxy (lowercase) before NO_PROXY; prepend
  // both IMDS hosts and restore the original on the way out so we never
  // leak state if a caller relies on the proxy elsewhere.
  const originalNoProxy = process.env.no_proxy
  const bypassEntries = IMDS_HOSTS.join(',')
  process.env.no_proxy = originalNoProxy
    ? `${bypassEntries},${originalNoProxy}`
    : bypassEntries

  try {
    for (const host of IMDS_HOSTS) {
      let tokenResponse: HttpClientResponse
      try {
        tokenResponse = await withTimeout(
          http.put(
            `http://${host}/latest/api/token`,
            '',
            {
              'X-aws-ec2-metadata-token-ttl-seconds': '30'
            }
          ),
          IMDS_REQUEST_TIMEOUT_MS
        )
      } catch {
        continue
      }
      if (tokenResponse.message.statusCode !== 200) {
        continue
      }
      const token = await tokenResponse.readBody()
      if (!token) {
        continue
      }

      let resp: HttpClientResponse
      try {
        resp = await withTimeout(
          http.get(
            `http://${host}/latest/meta-data/${category}`,
            {
              'X-aws-ec2-metadata-token': token
            }
          ),
          IMDS_REQUEST_TIMEOUT_MS
        )
      } catch {
        continue
      }
      if (resp.message.statusCode !== 200) {
        continue
      }
      return resp.readBody()
    }
    return ''
  } finally {
    if (originalNoProxy === undefined) {
      delete process.env.no_proxy
    } else {
      process.env.no_proxy = originalNoProxy
    }
  }
}
