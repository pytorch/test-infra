import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from './auth/[...nextauth]';
import { getClickhouseClientWritable } from 'lib/clickhouse';
import dayjs from 'dayjs';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).end();
  }

  const { sessionId, feedback } = req.body as { sessionId?: string; feedback?: number };
  if (!sessionId || typeof feedback !== 'number') {
    return res.status(400).json({ error: 'Missing sessionId or feedback' });
  }

  try {
    await getClickhouseClientWritable().insert({
      table: 'misc.mcp_query_feedback',
      values: [[
        dayjs().utc().format('YYYY-MM-DD HH:mm:ss'),
        String(session.user.id),
        sessionId,
        feedback,
      ]],
    });
  } catch (err) {
    console.error('Failed to insert feedback', err);
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  res.status(200).end();
}
