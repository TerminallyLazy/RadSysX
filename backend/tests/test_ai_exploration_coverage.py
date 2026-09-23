"""Coverage is acknowledged distinct frame delivery, never model prose or previews."""
import pytest
from backend.clinical.ai_exploration_coverage import CoverageLedger, RunBudget, BudgetExceeded


def test_repeated_frames_and_thumbnail_do_not_finish_series():
    ledger = CoverageLedger('manifest-1', tuple(f'frame-{i}' for i in range(34)))
    ledger.requested([f'frame-{i}' for i in range(34)])
    ledger.captured([f'frame-{i}' for i in range(34)])
    for i in range(33):
        ledger.submitted(f'op-{i}', [f'frame-{i}'], kind='frame')
        ledger.acknowledge(f'op-{i}')
    ledger.submitted('repeat', ['frame-0'], kind='frame'); ledger.acknowledge('repeat')
    ledger.submitted('preview', ['frame-33'], kind='thumbnail'); ledger.acknowledge('preview')
    assert ledger.receipt().status == 'partial'
    assert ledger.receipt().delivered == list(range(33))
    ledger.submitted('last', ['frame-33'], kind='frame')
    assert ledger.receipt().status == 'partial'
    ledger.acknowledge('last')
    assert ledger.receipt().status == 'complete'
    assert ledger.receipt().delivery_attempts == 36


def test_foreign_frames_and_changed_operation_cannot_change_coverage():
    ledger = CoverageLedger('manifest-1', ('frame-0', 'frame-1'))
    with pytest.raises(ValueError): ledger.requested(['frame-foreign'])
    ledger.requested(['frame-0', 'frame-1']); ledger.captured(['frame-0'])
    with pytest.raises(ValueError): ledger.submitted('op-1', ['frame-1'], kind='frame')
    ledger.submitted('op-1', ['frame-0'], kind='frame')
    ledger.submitted('op-1', ['frame-0'], kind='frame')
    with pytest.raises(ValueError): ledger.submitted('op-1', ['frame-1'], kind='frame')
    with pytest.raises(ValueError): ledger.acknowledge('not-submitted')
    ledger.failed(['frame-1'], 'render_failed')
    assert ledger.receipt().delivered == []
    assert ledger.receipt().failed == [1]
    ledger.acknowledge('op-1'); ledger.acknowledge('op-1')
    assert ledger.receipt().delivered == [0]
    assert ledger.receipt().delivery_attempts == 1


def test_continue_preserves_coverage_without_pending_pixels():
    ledger = CoverageLedger('manifest-1', ('frame-0', 'frame-1'))
    ledger.requested(['frame-0', 'frame-1']); ledger.captured(['frame-0', 'frame-1'])
    ledger.submitted('op-0', ['frame-0'], kind='frame'); ledger.acknowledge('op-0')
    ledger.submitted('op-1', ['frame-1'], kind='frame')
    resumed = CoverageLedger.restore(ledger.receipt())
    assert resumed.receipt().delivered == [0]
    assert resumed.receipt().status == 'partial'
    with pytest.raises(ValueError): resumed.acknowledge('op-1')


def test_limits_reserve_before_work_and_rollback_only_before_send():
    budget = RunBudget(started_at=10)
    for _ in range(16): budget.reserve(images=8, calls=1, encoded_bytes=8*1024*1024, now=11)
    with pytest.raises(BudgetExceeded): budget.reserve(images=1, calls=0, encoded_bytes=1, now=11)
    budget = RunBudget(started_at=10)
    reservation = budget.reserve(images=8, calls=1, encoded_bytes=100, now=11)
    budget.rollback(reservation)
    assert budget.images == 0 and budget.calls == 0
    reservation = budget.reserve(images=8, calls=1, encoded_bytes=100, now=11)
    budget.mark_sent(reservation)
    with pytest.raises(ValueError): budget.rollback(reservation)
    assert budget.images == 8
    with pytest.raises(BudgetExceeded): budget.check(610)
    with pytest.raises(BudgetExceeded): budget.reserve(images=9, calls=0, encoded_bytes=1, now=11)
    with pytest.raises(BudgetExceeded): budget.reserve(images=1, calls=0, encoded_bytes=8*1024*1024+1, now=11)
    for _ in range(63): budget.reserve(images=0, calls=1, encoded_bytes=0, now=12)
    with pytest.raises(BudgetExceeded): budget.reserve(images=0, calls=1, encoded_bytes=0, now=12)
