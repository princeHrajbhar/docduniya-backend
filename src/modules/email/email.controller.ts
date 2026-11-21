import type { Request, Response } from 'express';
import * as suppressionService from './suppression.service.js';
import type { EmailLogQuery, SuppressionListQuery } from './email.validation.js';

export async function listSuppressions(req: Request, res: Response) {
  const query = req.query as unknown as SuppressionListQuery;
  res.json({
    success: true,
    ...(await suppressionService.listSuppressions(query.page, query.limit, query.search)),
  });
}

export async function blockEmail(req: Request, res: Response) {
  const body = req.body as { email: string; reason?: string };
  const data = await suppressionService.blockEmail(body.email, body.reason, req.user!.userId);
  res.json({
    success: true,
    message: 'Email blocked. No future communication will be sent to this address.',
    data,
  });
}

export async function unblockEmail(req: Request<{ email: string }>, res: Response) {
  res.json({
    success: true,
    message: 'Email unblocked',
    data: await suppressionService.unblockEmail(req.params.email),
  });
}

export async function listEmailLogs(req: Request, res: Response) {
  res.json({
    success: true,
    ...(await suppressionService.listEmailLogs(req.query as unknown as EmailLogQuery)),
  });
}
