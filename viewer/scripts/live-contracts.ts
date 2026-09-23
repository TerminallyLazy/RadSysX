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

import type { AIResearchSettings, AIResearchModels } from '@radsysx/clinical-web/contracts';
import type { AIResearchSettings as ViewerResearchSettings, AIResearchModels as ViewerResearchModels } from '../assets/live/protocol';
type ResearchSettingsMatches = Assert<AIResearchSettings extends ViewerResearchSettings ? true : false>;
type ResearchSettingsComplete = Assert<ViewerResearchSettings extends AIResearchSettings ? true : false>;
type ResearchModelsMatches = Assert<AIResearchModels extends ViewerResearchModels ? true : false>;

import type * as SharedEvidence from '@radsysx/clinical-web/contracts';
import type * as ViewerEvidence from '../assets/live/protocol';
type EvidenceReviewDetailMatches = Assert<SharedEvidence.EvidenceReviewDetail extends ViewerEvidence.EvidenceReviewDetail ? true : false>;
type EvidenceReviewDetailComplete = Assert<ViewerEvidence.EvidenceReviewDetail extends SharedEvidence.EvidenceReviewDetail ? true : false>;
type EvidenceStartRequestMatches = Assert<SharedEvidence.EvidenceStartRequest extends ViewerEvidence.EvidenceStartRequest ? true : false>;
type EvidenceStartRequestComplete = Assert<ViewerEvidence.EvidenceStartRequest extends SharedEvidence.EvidenceStartRequest ? true : false>;
type EvidenceRetryRequestMatches = Assert<SharedEvidence.EvidenceRetryRequest extends ViewerEvidence.EvidenceRetryRequest ? true : false>;
type EvidenceRetryRequestComplete = Assert<ViewerEvidence.EvidenceRetryRequest extends SharedEvidence.EvidenceRetryRequest ? true : false>;
type EvidenceReviewAvailabilityMatches = Assert<SharedEvidence.EvidenceReviewAvailability extends ViewerEvidence.EvidenceReviewAvailability ? true : false>;
type EvidenceReviewAvailabilityComplete = Assert<ViewerEvidence.EvidenceReviewAvailability extends SharedEvidence.EvidenceReviewAvailability ? true : false>;
