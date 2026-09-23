import { request } from './protocol.js';

export type CodexAccount = {
  available: boolean; signedIn: boolean; email: string | null; plan: string | null;
  loginState: string; credentialStorage: 'keyring';
};

export function codexLoginUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
  return url.href;
}

/** OAuth is owned by Codex; only status and a transient official login link enter the UI. */
export class SubscriptionController {
  account?: CodexAccount;
  busy = false;
  message = '';
  loginUrl = '';
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  constructor(private changed: () => void, private beforeChange: () => Promise<void>, private authenticated: () => Promise<void>) {}

  async refresh(): Promise<void> {
    if (this.busy) return;
    const epoch = ++this.epoch;
    this.busy = true; this.changed();
    try {
      const previous = this.account?.signedIn;
      const account = await request<CodexAccount>('/api/ai/sidebar/codex/account');
      if (epoch !== this.epoch) return;
      this.account = account;
      this.message = !account.available ? 'Subscription access requires the local desktop app.' : account.signedIn
        ? 'Signed in. Choose ChatGPT / Codex subscription and a model below, then save.'
        : account.loginState === 'pending' ? 'Complete sign-in in your browser. Waiting for Codex confirmation…'
        : account.loginState === 'failed' ? 'Sign-in failed. Check the OS keyring and try again.' : 'Use your ChatGPT plan for typed chat and public literature research.';
      if (account.signedIn) {
        this.loginUrl = '';
        if (!previous) await this.authenticated();
      }
      if (account.loginState === 'pending') this.poll();
      else this.deadline = 0;
    } catch {
      if (epoch === this.epoch) this.message = 'Could not check Codex. Check the desktop installation and OS keyring, then refresh.';
    } finally { if (epoch === this.epoch) { this.busy = false; this.changed(); } }
  }
  async login(): Promise<void> {
    if (this.busy || this.account?.signedIn || this.account?.loginState === 'pending') return;
    const epoch = ++this.epoch;
    this.busy = true; this.message = 'Preparing official ChatGPT sign-in…'; this.changed();
    try {
      await this.beforeChange();
      if (epoch !== this.epoch) return;
      const value = await request<{ authUrl: string }>('/api/ai/sidebar/codex/login', {}, 'POST');
      if (epoch !== this.epoch) return;
      this.loginUrl = codexLoginUrl(value.authUrl);
      if (this.account) this.account.loginState = 'pending';
      this.message = 'Continue in your browser below. RadSysX never receives your password or access tokens.';
      this.deadline = Date.now() + 300_000; this.poll();
    } catch { if (epoch === this.epoch) this.message = 'Sign-in could not start. Refresh status before retrying.'; }
    finally { if (epoch === this.epoch) { this.busy = false; this.changed(); } }
  }
  async logout(): Promise<void> {
    if (this.busy) return;
    this.stop(); const epoch = this.epoch;
    this.busy = true; this.loginUrl = ''; this.message = 'Ending RadSysX subscription sessions…'; this.changed();
    try {
      await this.beforeChange();
      if (epoch !== this.epoch) return;
      const account = await request<CodexAccount>('/api/ai/sidebar/codex/logout', {}, 'POST');
      if (epoch !== this.epoch) return;
      this.account = account; this.message = 'Signed out of RadSysX. Your other Codex clients are unchanged.';
      await this.authenticated();
    } catch { if (epoch === this.epoch) this.message = 'Sign-out is unconfirmed. Refresh status and retry.'; }
    finally { if (epoch === this.epoch) { this.busy = false; this.changed(); } }
  }
  private poll(): void {
    if (!this.deadline) this.deadline = Date.now() + 300_000;
    if (this.timer) clearTimeout(this.timer);
    if (Date.now() >= this.deadline) { this.message = 'Sign-in status needs checking. Refresh or cancel before retrying.'; return; }
    this.timer = setTimeout(() => void this.refresh(), 2000);
  }
  stop(): void { this.epoch += 1; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.busy = false; }
}
