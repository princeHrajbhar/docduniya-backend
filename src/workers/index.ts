/**
 * Background worker process. Run separately from the API (`npm run worker`). Every job is safe to
 * run on several instances at once: work is leased or guarded by version/state predicates, and
 * external effects use stable idempotency keys.
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { relayOutbox } from '../modules/operations/outbox.relay.js';
import { deliverNotifications } from '../modules/notifications/notification.service.js';
import { expireAppointmentHolds } from '../modules/appointments/appointment.service.js';
import {
  processInbox,
  processRefunds,
  retryPendingOrders,
} from '../modules/payments/payment.service.js';
import {
  expireAbandonedUploads,
  scanQuarantinedDocuments,
} from '../modules/documents/document.service.js';
import { escalateOverdueTasks } from '../modules/clinical/task.service.js';
import { expireBatches } from '../modules/pharmacy/pharmacy.service.js';
import { renewSubscriptions } from '../modules/commerce/subscription.service.js';
import { expireCredentials } from '../modules/practitioners/credential.service.js';
import { offerWaitlistSlots } from '../modules/appointments/waitlist.service.js';
import { flagLapsedDoctorAppointments } from '../modules/appointments/reassignment.service.js';
import { serviceActor } from '../shared/application/scope.js';
import { randomUUID } from 'node:crypto';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<number>;
}

const fast = env.WORKER_POLL_MS;
export const jobs: Job[] = [
  { name: 'outbox-relay', everyMs: fast, run: () => relayOutbox() },
  { name: 'payment-inbox', everyMs: fast, run: () => processInbox() },
  { name: 'hold-expiry', everyMs: fast * 3, run: () => expireAppointmentHolds() },
  { name: 'waitlist-offers', everyMs: fast * 6, run: () => offerWaitlistSlots() },
  { name: 'refunds', everyMs: fast * 3, run: () => processRefunds() },
  { name: 'payment-orders', everyMs: fast * 6, run: () => retryPendingOrders() },
  { name: 'notifications', everyMs: fast, run: () => deliverNotifications() },
  { name: 'document-scan', everyMs: fast * 2, run: () => scanQuarantinedDocuments() },
  { name: 'upload-expiry', everyMs: 15 * 60_000, run: () => expireAbandonedUploads() },
  { name: 'task-escalation', everyMs: 60_000, run: () => escalateOverdueTasks() },
  { name: 'batch-expiry', everyMs: 60 * 60_000, run: () => expireBatches() },
  { name: 'subscription-renewal', everyMs: 15 * 60_000, run: () => renewSubscriptions() },
  {
    name: 'doctor-credential-sweep',
    everyMs: 15 * 60_000,
    run: () => flagLapsedDoctorAppointments(),
  },
  {
    name: 'credential-expiry',
    everyMs: 60 * 60_000,
    run: () => expireCredentials(serviceActor('credential-expiry', randomUUID())),
  },
];

let stopping = false;
const timers = new Set<NodeJS.Timeout>();
const running = new Set<Promise<unknown>>();

function schedule(job: Job): void {
  if (stopping) return;
  const timer = setTimeout(() => {
    timers.delete(timer);
    const work = job
      .run()
      .then((count) => {
        if (count) logger.debug({ job: job.name, count }, 'Worker job processed items');
      })
      // Detached work needs explicit error handling; a failed run is retried next cycle.
      .catch((error: unknown) => logger.error({ err: error, job: job.name }, 'Worker job failed'))
      .finally(() => {
        running.delete(work);
        schedule(job);
      });
    running.add(work);
  }, job.everyMs);
  timers.add(timer);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Worker draining');
  for (const timer of timers) clearTimeout(timer);
  // Leases held by unfinished work simply expire and are picked up by another instance.
  await Promise.race([
    Promise.allSettled([...running]),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  await mongoose.disconnect();
  process.exit(0);
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGO_URI, {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000,
  });
  for (const job of jobs) schedule(job);
  logger.info({ jobs: jobs.map((job) => job.name) }, 'Worker started');
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Worker failed to start');
  process.exit(1);
});
