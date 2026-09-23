"""Pure receipt accounting. Neither an image preview nor a model claim is delivery."""
from dataclasses import dataclass
import math
from .ai_exploration_contracts import (CoverageReceipt, MAX_BATCH_BYTES, MAX_BATCH_IMAGES,
    MAX_RUN_IMAGES, MAX_RUN_CALLS, MAX_RUN_SECONDS)


class CoverageLedger:
    def __init__(self, manifest_id: str, frame_ids: tuple[str, ...]):
        if not frame_ids or len(frame_ids) > 10000 or len(set(frame_ids)) != len(frame_ids):
            raise ValueError('Invalid frame inventory')
        self.manifest_id, self.frames = manifest_id, frame_ids
        self.indices = {key:i for i,key in enumerate(frame_ids)}
        self._requested, self._captured, self._delivered, self._failed = set(), set(), set(), set()
        self.operations = {}
        self.delivery_attempts = 0

    def _indices(self, ids):
        try: return {self.indices[key] for key in ids}
        except (KeyError, TypeError): raise ValueError('Unknown frame') from None

    def requested(self, ids): self._requested.update(self._indices(ids))
    def captured(self, ids):
        values = self._indices(ids)
        if not values <= self._requested: raise ValueError('Frames were not requested')
        self._captured.update(values)

    def submitted(self, operation_id, ids, kind):
        values = self._indices(ids)
        if not values <= self._captured: raise ValueError('Frames were not captured')
        if kind not in {'frame','thumbnail','pane','overview'}: raise ValueError('Unknown observation kind')
        identity = (tuple(ids), kind)
        if operation_id in self.operations:
            if self.operations[operation_id][0] != identity: raise ValueError('Operation changed')
            return
        self.operations[operation_id] = (identity, False)
        self.delivery_attempts += len(ids)

    def acknowledge(self, operation_id):
        if operation_id not in self.operations: raise ValueError('Unknown submission')
        identity, _ = self.operations[operation_id]
        self.operations[operation_id] = (identity, True)
        ids, kind = identity
        if kind == 'frame':
            self._delivered.update(self._indices(ids))
            self._failed.difference_update(self._indices(ids))

    def failed(self, ids, reason):
        self._failed.update(self._indices(ids) - self._delivered)

    def receipt(self):
        pending = set()
        for (ids, kind), ack in self.operations.values():
            if not ack and kind == 'frame': pending.update(self._indices(ids))
        return CoverageReceipt(manifest_id=self.manifest_id, frame_count=len(self.frames), frame_ids=list(self.frames),
            requested=sorted(self._requested), captured=sorted(self._captured), delivered=sorted(self._delivered),
            failed=sorted(self._failed), unconfirmed=sorted(pending-self._delivered), delivery_attempts=self.delivery_attempts,
            status='complete' if len(self._delivered)==len(self.frames) else 'partial' if self._requested else 'pending')

    @classmethod
    def restore(cls, receipt):
        result = cls(receipt.manifest_id, tuple(receipt.frame_ids))
        allowed = set(range(len(result.frames)))
        for source,target in [('requested','_requested'),('captured','_captured'),('delivered','_delivered'),('failed','_failed')]:
            values = set(getattr(receipt,source))
            if not values <= allowed: raise ValueError('Invalid saved coverage')
            setattr(result,target,values)
        result.delivery_attempts = receipt.delivery_attempts
        return result


class BudgetExceeded(ValueError): pass


@dataclass(eq=False)
class Reservation:
    images: int
    calls: int
    sent: bool = False


class RunBudget:
    def __init__(self, started_at):
        self.started_at, self.images, self.calls = started_at, 0, 0
        self.reservations = set()

    def check(self, now):
        if not math.isfinite(now) or not self.started_at <= now < self.started_at + MAX_RUN_SECONDS:
            raise BudgetExceeded('Exploration deadline reached')

    def reserve(self, *, images, calls, encoded_bytes, now):
        self.check(now)
        if any(type(v) is not int or v < 0 for v in (images,calls,encoded_bytes)):
            raise BudgetExceeded('Invalid budget request')
        if (images > MAX_BATCH_IMAGES or encoded_bytes > MAX_BATCH_BYTES
                or self.images + images > MAX_RUN_IMAGES or self.calls + calls > MAX_RUN_CALLS):
            raise BudgetExceeded('Exploration budget reached')
        reservation = Reservation(images, calls)
        self.reservations.add(reservation)
        self.images += images; self.calls += calls
        return reservation

    def mark_sent(self, reservation):
        if reservation not in self.reservations: raise ValueError('Unknown reservation')
        reservation.sent = True

    def rollback(self, reservation):
        if reservation not in self.reservations or reservation.sent: raise ValueError('Reservation cannot be rolled back')
        self.reservations.remove(reservation)
        self.images -= reservation.images; self.calls -= reservation.calls
