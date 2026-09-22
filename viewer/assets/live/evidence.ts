import type { EvidenceConfirmation, EvidenceReviewDetail, EvidenceReviewList, EvidenceReviewSummary, EvidenceStartRequest, EvidenceRetryRequest } from './protocol.js';

const ROOT = '/api/ai/sidebar';
const active = (status?: string) => status === 'preparing' || status === 'reviewing';
class ReviewHTTPError extends Error { constructor(readonly status: number) { super('Review request failed'); } }

/** Saved public-literature review has no dependency on microphone, pixels or voice lifecycle. */
export class EvidenceController {
  sessionId?: string;
  reviews = new Map<string, EvidenceReviewSummary>();
  detail?: EvidenceReviewDetail;
  selectedUnitIds = new Set<string>();
  confirmation: EvidenceConfirmation | null = null;
  busy = false;
  message = '';
  open = false;
  private generation = 0;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private pollStarted = 0;
  private pollDelay = 1000;
  private disposed = false;
  private operations = new Map<string, { identity: string; key: string }>();

  get suspended(): boolean { return this.disposed; }

  constructor(private notify: () => void, private fetcher: typeof fetch = fetch) {}

  private resetRequest(): number {
    ++this.generation; this.abort.abort(); this.abort = new AbortController();
    clearTimeout(this.timer); this.timer = undefined; this.busy = false;
    return this.generation;
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private async request<T>(path: string, generation: number, body?: object): Promise<T | undefined> {
    const response = await this.fetcher(ROOT + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', signal: this.abort.signal,
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!this.current(generation)) return;
    if (!response.ok) throw new ReviewHTTPError(response.status);
    const value = await response.json() as T;
    return this.current(generation) ? value : undefined;
  }
  private key(operation: string, value: object): string {
    const identity = JSON.stringify(value), previous = this.operations.get(operation);
    if (previous?.identity === identity) return previous.key;
    const key = crypto.randomUUID(); this.operations.set(operation, { identity, key }); return key;
  }
  private fail(error: unknown, generation: number): void {
    if (!this.current(generation)) return;
    this.confirmation = null;
    if (error instanceof ReviewHTTPError && [401, 403].includes(error.status)) {
      clearTimeout(this.timer); this.pollStarted = -Infinity;
      this.message = 'Review access ended. Sign in and reopen this conversation.';
    } else if (error instanceof ReviewHTTPError && error.status === 409) {
      this.message = 'Review conflict or another review is active. Refresh the review before trying again.';
    } else if (error instanceof ReviewHTTPError && error.status === 503) {
      this.message = 'Jev or private review storage is unavailable. Check backend configuration, then refresh.';
    } else {
      this.message = 'Could not update the review. Saved results remain available. Refresh review to check its state.';
    }
  }
  private apply(detail: EvidenceReviewDetail): void {
    if (detail.sessionId !== this.sessionId) throw new Error('Wrong review session');
    const changed = this.detail?.previewSha256 !== detail.previewSha256 || this.detail?.reviewId !== detail.reviewId;
    this.detail = detail; this.reviews.set(detail.reviewId, detail);
    if (changed) {
      this.confirmation = null;
      this.selectedUnitIds = new Set(detail.selectedUnitIds ?? detail.claims.filter(c => c.eligible).map(c => c.unitId));
    } else if (detail.selectedUnitIds !== null) this.selectedUnitIds = new Set(detail.selectedUnitIds);
  }
  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.disposed || !active(this.detail?.status)) return;
    if (Date.now() - this.pollStarted >= 100000) {
      if (!this.message) this.message = 'Automatic updates paused. Refresh review for the latest saved state.';
      this.notify(); return;
    }
    const generation = this.generation, delay = this.pollDelay;
    this.pollDelay = Math.min(this.pollDelay * 2, 4000);
    this.timer = setTimeout(() => { if (this.current(generation)) void this.loadDetail(generation); }, delay);
  }
  private async loadDetail(generation: number): Promise<void> {
    const id = this.detail?.reviewId;
    if (!id || this.busy) return;
    this.busy = true;
    try {
      const value = await this.request<EvidenceReviewDetail>(`/evidence-reviews/${encodeURIComponent(id)}`, generation);
      if (value) { this.apply(value); this.message = ''; }
    } catch (error) { this.fail(error, generation); }
    finally { if (this.current(generation)) { this.busy = false; this.schedule(); this.notify(); } }
  }
  async selectSession(sessionId: string | undefined): Promise<void> {
    if (sessionId === this.sessionId && !this.disposed) return;
    this.disposed = false; const generation = this.resetRequest();
    this.sessionId = sessionId; this.detail = undefined; this.reviews.clear(); this.operations.clear();
    this.selectedUnitIds.clear(); this.confirmation = null; this.message = ''; this.open = false;
    this.notify(); if (!sessionId) return;
    this.busy = true;
    try {
      const list = await this.request<EvidenceReviewList>(`/sessions/${encodeURIComponent(sessionId)}/evidence-reviews`, generation);
      if (list) {
        this.reviews = new Map(list.reviews.map(review => [review.reviewId, review]));
        if (list.truncated) this.message = 'Showing the latest 100 reviews.';
        const running = list.reviews.find(review => active(review.status));
        if (running) {
          const detail = await this.request<EvidenceReviewDetail>(`/evidence-reviews/${encodeURIComponent(running.reviewId)}`, generation);
          if (detail) { this.apply(detail); this.pollStarted = Date.now(); this.pollDelay = 1000; }
        }
      }
    } catch (error) { this.fail(error, generation); }
    finally { if (this.current(generation)) { this.busy = false; this.schedule(); this.notify(); } }
  }
  async openTool(toolCallId: string): Promise<void> {
    if (!this.sessionId || this.disposed) return;
    // Invalidate an old detail request even if its fetch implementation ignores abort.
    const generation = this.resetRequest(); this.open = true; this.confirmation = null;
    this.busy = true; this.message = ''; this.pollStarted = Date.now(); this.pollDelay = 1000;
    this.detail = undefined; this.selectedUnitIds.clear(); this.notify();
    const saved = [...this.reviews.values()].find(review => review.toolCallId === toolCallId);
    try {
      const value = saved
        ? await this.request<EvidenceReviewDetail>(`/evidence-reviews/${encodeURIComponent(saved.reviewId)}`, generation)
        : await this.request<EvidenceReviewDetail>(`/sessions/${encodeURIComponent(this.sessionId)}/tools/${encodeURIComponent(toolCallId)}/evidence-reviews`, generation,
            { idempotencyKey: this.key(`prepare:${toolCallId}`, { sessionId: this.sessionId, toolCallId }) });
      if (value) this.apply(value);
    } catch (error) { this.fail(error, generation); }
    finally { if (this.current(generation)) { this.busy = false; this.schedule(); this.notify(); } }
  }
  setSelected(unitId: string, selected: boolean): void {
    if (this.busy || this.detail?.status !== 'ready' || !this.detail.claims.some(c => c.unitId === unitId && c.eligible)) return;
    if (selected) this.selectedUnitIds.add(unitId); else this.selectedUnitIds.delete(unitId);
    this.confirmation = null; this.notify();
  }
  setConfirmation(value: EvidenceConfirmation | null): void {
    if (this.busy) return;
    this.confirmation = value === 'synthetic' || value === 'public_literature' ? value : null; this.notify();
  }
  async start(): Promise<void> {
    if (this.busy || this.detail?.status !== 'ready' || !this.confirmation || !this.selectedUnitIds.size || !this.detail.previewSha256) return;
    const value = { previewSha256: this.detail.previewSha256, confirmation: this.confirmation, selectedUnitIds: [...this.selectedUnitIds] };
    const body: EvidenceStartRequest = { ...value, idempotencyKey: this.key(`start:${this.detail.reviewId}`, value) };
    await this.mutate('start', body);
  }
  async retry(): Promise<void> {
    if (this.busy || !this.detail || !['partial', 'failed', 'interrupted'].includes(this.detail.status) || !this.detail.selectedUnitIds?.length || !this.confirmation || !this.detail.previewSha256) return;
    const value = { previewSha256: this.detail.previewSha256, confirmation: this.confirmation };
    const body: EvidenceRetryRequest = { ...value, idempotencyKey: this.key(`retry:${this.detail.reviewId}`, value) };
    await this.mutate('retry', body);
  }
  async cancel(): Promise<void> { if (active(this.detail?.status)) await this.mutate('cancel', {}); }
  private async mutate(action: string, body: object): Promise<void> {
    if (!this.detail || this.disposed) return;
    const id = this.detail.reviewId, generation = this.resetRequest();
    this.busy = true; this.confirmation = null; this.message = ''; this.pollStarted = Date.now(); this.pollDelay = 1000; this.notify();
    try {
      const value = await this.request<EvidenceReviewDetail>(`/evidence-reviews/${encodeURIComponent(id)}/${action}`, generation, body);
      if (value) { this.apply(value); this.operations.delete(`${action}:${id}`); }
    } catch (error) { this.fail(error, generation); }
    finally { if (this.current(generation)) { this.busy = false; this.schedule(); this.notify(); } }
  }
  async refresh(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.pollStarted = Date.now(); this.pollDelay = 1000;
    await this.loadDetail(this.generation);
  }
  close(): void { this.open = false; this.confirmation = null; this.notify(); }
  dispose(): void {
    this.resetRequest(); this.disposed = true; this.confirmation = null; this.selectedUnitIds.clear();
    this.open = false; this.message = '';
  }
}
