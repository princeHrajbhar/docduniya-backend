import type { Request, Response } from 'express';
import mongoose from 'mongoose';

export const getHealth = (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};

/**
 * Readiness: the database answers and is a replica set (transactions are required). Load
 * balancers should route traffic only while this returns 200; liveness stays on GET /health.
 */
export const getReadiness = async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (mongoose.connection.readyState !== 1) throw new Error('not connected');
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('not a replica set');
    res.status(200).json({ success: true, status: 'ready', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ success: false, code: 'NOT_READY', message: 'Database unavailable' });
  }
};
