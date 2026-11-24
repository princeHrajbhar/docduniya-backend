import { Router, type Request } from 'express';
import { protect } from '../admin/auth/auth.middleware.js';
import { actor, idempotencyKey } from '../../shared/http/context.js';
import { idParam, noStore, ok, pageQuery } from '../../shared/http/handler.js';
import * as scheduling from '../scheduling/scheduling.service.js';
import * as schedulingDto from '../scheduling/scheduling.validation.js';
import * as appointments from './appointment.service.js';
import * as queue from './queue.service.js';
import * as dto from './appointment.validation.js';

const router = Router();
const org = '/organizations/:organizationId';
const orgId = (req: Request) => idParam(req, 'organizationId');
const appointmentId = (req: Request) => idParam(req, 'appointmentId');

// Provider catalog: resources, service offerings, prices and schedules
router.post(
  `${org}/resources`,
  protect,
  ok(
    (req) =>
      scheduling.createResource(
        actor(req),
        orgId(req),
        schedulingDto.resourceInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/resources`,
  protect,
  ok((req) => scheduling.listResources(actor(req), orgId(req), pageQuery(req))),
);
router.post(
  `${org}/service-offerings`,
  protect,
  ok(
    (req) =>
      scheduling.createOffering(
        actor(req),
        orgId(req),
        schedulingDto.offeringInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/service-offerings`,
  protect,
  ok((req) =>
    scheduling.listOfferings(actor(req), orgId(req), schedulingDto.offeringQuery.parse(req.query)),
  ),
);
router.post(
  `${org}/service-offerings/:offeringId/prices`,
  protect,
  ok(
    (req) =>
      scheduling.publishPrice(
        actor(req),
        orgId(req),
        idParam(req, 'offeringId'),
        schedulingDto.priceInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  `${org}/service-offerings/:offeringId/state`,
  protect,
  ok((req) =>
    scheduling.changeOfferingState(
      actor(req),
      orgId(req),
      idParam(req, 'offeringId'),
      schedulingDto.offeringStateInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  `${org}/schedules`,
  protect,
  ok(
    (req) =>
      scheduling.createSchedule(
        actor(req),
        orgId(req),
        schedulingDto.scheduleInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.get(
  `${org}/schedules`,
  protect,
  ok((req) => scheduling.listSchedules(actor(req), orgId(req), pageQuery(req))),
);
router.post(
  `${org}/schedules/:scheduleId/state`,
  protect,
  ok((req) =>
    scheduling.changeScheduleState(
      actor(req),
      orgId(req),
      idParam(req, 'scheduleId'),
      schedulingDto.scheduleStateInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Doctor leave blocks the doctor's global practitioner calendar across every provider.
router.post(
  '/doctors/me/time-blocks',
  protect,
  ok(
    (req) =>
      scheduling.blockDoctorTime(
        actor(req),
        schedulingDto.blockInput.parse(req.body),
        idempotencyKey(req),
      ),
    201,
  ),
);
router.post(
  '/doctors/me/time-blocks/:blockId/cancel',
  protect,
  ok((req) =>
    scheduling.cancelTimeBlock(
      actor(req),
      idParam(req, 'blockId'),
      dto.appointmentCommandInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);

// Public quote and availability. Estimates only: a hold re-checks everything.
router.get(
  '/offerings/:offeringId',
  noStore((req) => scheduling.getPublicOffering(idParam(req, 'offeringId'))),
);
router.get(
  '/offerings/:offeringId/availability',
  noStore((req) =>
    scheduling.availability(
      idParam(req, 'offeringId'),
      schedulingDto.availabilityQuery.parse(req.query).date,
    ),
  ),
);

// Patient portal booking
router.post(
  '/appointments/holds',
  protect,
  ok(
    (req) =>
      appointments.createHold(actor(req), dto.holdInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.get(
  '/me/appointments',
  protect,
  noStore((req) =>
    appointments.listAppointments(actor(req), dto.appointmentQuery.parse(req.query)),
  ),
);
router.get(
  '/appointments/:appointmentId',
  protect,
  noStore((req) => appointments.getAppointment(actor(req), appointmentId(req))),
);
router.post(
  '/appointments/:appointmentId/confirm',
  protect,
  ok((req) =>
    appointments.confirmAppointment(
      actor(req),
      appointmentId(req),
      dto.appointmentCommandInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
    ),
  ),
);
router.post(
  '/appointments/:appointmentId/cancel',
  protect,
  ok((req) =>
    appointments.cancelAppointment(
      actor(req),
      appointmentId(req),
      dto.cancelInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);
router.post(
  '/appointments/:appointmentId/reschedule',
  protect,
  ok((req) =>
    appointments.rescheduleAppointment(
      actor(req),
      appointmentId(req),
      dto.rescheduleInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

// Provider workspace booking and visit flow
router.post(
  `${org}/appointments/holds`,
  protect,
  ok(
    (req) =>
      appointments.createHold(
        actor(req),
        dto.holdInput.parse(req.body),
        idempotencyKey(req),
        orgId(req),
      ),
    201,
  ),
);
router.get(
  `${org}/appointments`,
  protect,
  noStore((req) =>
    appointments.listAppointments(actor(req), dto.appointmentQuery.parse(req.query), orgId(req)),
  ),
);
router.get(
  `${org}/appointments/:appointmentId`,
  protect,
  noStore((req) => appointments.getAppointment(actor(req), appointmentId(req), orgId(req))),
);
router.post(
  `${org}/appointments/:appointmentId/confirm`,
  protect,
  ok((req) =>
    appointments.confirmAppointment(
      actor(req),
      appointmentId(req),
      dto.appointmentCommandInput.parse(req.body).expectedVersion,
      idempotencyKey(req),
      orgId(req),
    ),
  ),
);
router.post(
  `${org}/appointments/:appointmentId/cancel`,
  protect,
  ok((req) =>
    appointments.cancelAppointment(
      actor(req),
      appointmentId(req),
      dto.cancelInput.parse(req.body),
      idempotencyKey(req),
      orgId(req),
    ),
  ),
);
router.post(
  `${org}/appointments/:appointmentId/reschedule`,
  protect,
  ok((req) =>
    appointments.rescheduleAppointment(
      actor(req),
      appointmentId(req),
      dto.rescheduleInput.parse(req.body),
      idempotencyKey(req),
      orgId(req),
    ),
  ),
);
for (const action of ['check-in', 'no-show', 'start', 'complete', 'discontinue'] as const)
  router.post(
    `${org}/appointments/:appointmentId/${action}`,
    protect,
    ok((req) => {
      const body = dto.transitionInput.parse(req.body);
      return appointments.transitionAppointment(
        actor(req),
        orgId(req),
        appointmentId(req),
        action,
        body.expectedVersion,
        body.reason,
        idempotencyKey(req),
      );
    }),
  );

// Facility queue
router.post(
  `${org}/queue`,
  protect,
  ok(
    (req) =>
      queue.addWalkIn(actor(req), orgId(req), dto.walkInInput.parse(req.body), idempotencyKey(req)),
    201,
  ),
);
router.get(
  `${org}/queue`,
  protect,
  noStore((req) => queue.listQueue(actor(req), orgId(req), dto.queueQuery.parse(req.query))),
);
router.post(
  `${org}/queue/:entryId/transition`,
  protect,
  ok((req) =>
    queue.transitionQueue(
      actor(req),
      orgId(req),
      idParam(req, 'entryId'),
      dto.queueTransitionInput.parse(req.body),
      idempotencyKey(req),
    ),
  ),
);

export default router;
