/** Compile-only checks against the authoritative shared browser contracts. */
import type { AISidebarSessionResponse, AISidebarSessionCreateRequest, AISidebarProvider, AICredentialStatusResponse } from '@radsysx/clinical-web/contracts';
import type { AILiveEvent, AILiveClientEvent } from '@radsysx/clinical-web';
import type { ViewerContext, Session, ServerEvent, ProviderProfile, ScreenSharing, ScreenStatus, AICredentialStatusResponse as ViewerCredentialStatus } from '../assets/live/protocol';

type Assert<T extends true> = T;
type ViewerRequestMatches = Assert<ViewerContext extends NonNullable<AISidebarSessionCreateRequest['viewerContext']> ? true : false>;
type ProviderMatches = Assert<AISidebarProvider extends ProviderProfile ? true : false>;
type SessionResponseMatches = Assert<AISidebarSessionResponse extends Session ? true : false>;
type ServerEventMatches = Assert<AILiveEvent extends ServerEvent ? true : false>;
type ExpectedClientKinds = 'text' | 'screen' | 'screen_sharing' | 'audio_end' | 'action_result' | 'ping' | 'playback_stop';
type ClientKindsMatch = Assert<AILiveClientEvent['kind'] extends ExpectedClientKinds ? true : false>;
type ScreenStatusMatches = Assert<Extract<AILiveEvent, { kind: 'screen_status' }> extends ScreenStatus ? true : false>;
type ScreenSharingMatches = Assert<Extract<AILiveClientEvent, { kind: 'screen_sharing' }> extends ScreenSharing ? true : false>;
type CredentialStatusMatches = Assert<AICredentialStatusResponse extends ViewerCredentialStatus ? true : false>;
type CredentialStatusComplete = Assert<ViewerCredentialStatus extends AICredentialStatusResponse ? true : false>;
export type LiveContractChecks = [ProviderMatches, ViewerRequestMatches, SessionResponseMatches, ServerEventMatches, ClientKindsMatch, ScreenStatusMatches, ScreenSharingMatches, CredentialStatusMatches, CredentialStatusComplete];
