import type { Blob } from '@google/genai';

export enum ConversationStatus {
    Idle = 'idle',
    Generating = 'generating',
    Briefing = 'briefing',
    Ready = 'ready',
    Active = 'active',
    Summarizing = 'summarizing',
    PausedForFeedback = 'paused',
    Error = 'error',
}

export interface NpcProfile {
    name: string;
    gender: 'male' | 'female' | 'neutral';
    voice: string;
    languages: {
        primary: string;
        secondary?: string;
    };
    fluencyPrimary: 'low' | 'medium' | 'high';
    fluencySecondary?: 'low' | 'medium' | 'high';
    patience: 'low' | 'medium' | 'high';
    helpfulness: 'low' | 'medium' | 'high';
    accent: 'local' | 'neutral' | 'heavy';
    quirk: string;
}

export interface Scenario {
    locationName: string;
    locationType: string;
    task: string;
    npcProfile: NpcProfile;
    sceneDescription: string;
    conversationStarter: 'user' | 'npc';
    openingLine: string | null;
}

export interface Transcript {
    speaker: 'user' | 'npc';
    text: string;
    isFinal: boolean;
    imageUrl?: string; // Added to support inline images
}

export interface ConversationResult {
    summary: string;
    tips: string[];
    taskComplete: boolean;
    suggestedContinuation?: string;
    suggestedContinuationExplanation?: string;
}

export interface Hint {
    suggestion: string;
    translation: string;
    pronunciation: string;
    explanation: string;
}

export interface TranslationResult {
    translation: string;
    pronunciation: string;
    tip: string;
}

// --- NEW: Types for structured Study Card hints ---
export interface StudyCardEntry {
    term: string;
    translation: string;
}

export interface StudyCardHint {
    vocabulary: StudyCardEntry[];
    phrases: StudyCardEntry[];
}
// --- END NEW ---

export interface LiveSession {
    sendRealtimeInput(input: { media: Blob }): void;
    close(): void;
}