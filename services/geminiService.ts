import { GoogleGenAI, Type, Modality, LiveServerMessage, Blob } from '@google/genai';
import type { Scenario, Transcript, ConversationResult, LiveSession, Hint, TranslationResult, StudyCardHint } from '../types';

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

// --- Helper Functions ---

/**
 * Encodes audio data from a Uint8Array to a base64 string.
 * This is a manual implementation to avoid external libraries, as per guidelines.
 */
function encode(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function createBlob(data: Float32Array): Blob {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
        int16[i] = data[i] * 32768;
    }
    return {
        data: encode(new Uint8Array(int16.buffer)),
        mimeType: 'audio/pcm;rate=16000',
    };
}


// --- API Service Functions ---

export const generateScenario = async (locationName: string, context: string): Promise<Scenario> => {
    const model = 'gemini-2.5-flash'; // OPTIMIZED: Use faster model
    const validVoices = ['Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir'];
    const prompt = `
        You are a scenario generator for a language learning application called "Rehearsal".
        Your goal is to create an immersive, realistic, and culturally appropriate scenario for a user practicing a new language.
        The user is currently exploring a specific location using Google Street View.

        **CRITICAL INSTRUCTION: The user's geographic coordinates are the absolute source of truth.**

        - **User's Coordinates:** ${context}
        - **Location Name (Potentially unreliable):** ${locationName}

        Your task is to analyze the **User's Coordinates** to determine the *actual* environment the user is in. The \`Location Name\` might be generic (e.g., "Street", "Unnamed Road") or incorrect. You must base your scenario on what would plausibly exist at those exact coordinates.

        **Step-by-step process:**
        1.  **Analyze Coordinates:** First, determine the most likely type of establishment or point of interest at \`${context}\`. Is it a cafe, a shop, a bus stop, a park entrance, a residential building, a temple? Be specific.
        2.  **Create Scenario:** Based on your analysis of the coordinates, create a scenario. Do not invent a location that isn't there. The scenario must be grounded in the reality of the Street View image.
        3.  **Generate a simple, clear, and actionable task** for the user to complete by talking to a local NPC.
        4.  **Create a profile for the Non-Player Character (NPC)** they will interact with. The NPC's voice **MUST** be one of these exact values: ${validVoices.join(', ')}.
        5.  **Write a brief, evocative description of the scene** to set the mood, based on a typical view at that location.
        6.  **Decide who starts the conversation** (user or NPC). If the NPC starts, provide an opening line.

        The NPC profile must include:
        - name (culturally appropriate for the location)
        - gender ('male', 'female', or 'neutral')
        - voice (one of: ${validVoices.join(', ')}). **IMPORTANT: The selected voice MUST match the specified gender.** For example, a male-sounding name for a 'male' gender.
        - languages (e.g., { primary: 'Japanese', secondary: 'English' })
        - fluency for each language ('low', 'medium', 'high')
        - personality traits: patience, helpfulness ('low', 'medium', 'high')
        - accent ('local', 'neutral', 'heavy')
        - a unique quirk (a short, interesting personality trait, e.g., "Always polishing their glasses.")

        The user's task should be practical for a visitor, like asking for directions, ordering food, or asking about a local feature.

        Return the response as a JSON object matching the provided schema. Do not include any text outside the JSON object.
    `;

    const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    locationName: { type: Type.STRING },
                    locationType: { type: Type.STRING },
                    task: { type: Type.STRING },
                    npcProfile: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            gender: { type: Type.STRING },
                            voice: { type: Type.STRING },
                            languages: {
                                type: Type.OBJECT,
                                properties: {
                                    primary: { type: Type.STRING },
                                    secondary: { type: Type.STRING, nullable: true },
                                },
                                required: ['primary'],
                            },
                            fluencyPrimary: { type: Type.STRING },
                            fluencySecondary: { type: Type.STRING, nullable: true },
                            patience: { type: Type.STRING },
                            helpfulness: { type: Type.STRING },
                            accent: { type: Type.STRING },
                            quirk: { type: Type.STRING },
                        },
                        required: ['name', 'gender', 'voice', 'languages', 'fluencyPrimary', 'patience', 'helpfulness', 'accent', 'quirk'],
                    },
                    sceneDescription: { type: Type.STRING },
                    conversationStarter: { type: Type.STRING },
                    openingLine: { type: Type.STRING, nullable: true }
                },
                required: ['locationName', 'locationType', 'task', 'npcProfile', 'sceneDescription', 'conversationStarter'],
            }
        }
    });

    const jsonText = response.text.trim();
    const scenarioData = JSON.parse(jsonText) as Scenario;
    
    // FIX: Validate the generated voice name to prevent crashes
    if (!validVoices.includes(scenarioData.npcProfile.voice)) {
        console.warn(`Invalid voice "${scenarioData.npcProfile.voice}" generated by model. Defaulting to 'Zephyr' to prevent a crash.`);
        scenarioData.npcProfile.voice = 'Zephyr';
    }

    return scenarioData;
};

export const startConversation = async (
    scenario: Scenario,
    callbacks: {
        onTranscriptUpdate: (transcript: Transcript) => void;
        onNpcAudio: (audio: string) => void;
        onTurnComplete: () => void;
        onError: (e: any) => void;
        onClose: () => void;
    }
): Promise<LiveSession> => {
    const systemInstruction = `
        You are an NPC in a language learning simulation. Your name is ${scenario.npcProfile.name}.
        Your personality is defined as: ${JSON.stringify(scenario.npcProfile)}.
        The user's task is: ${scenario.task}.
        The scene is: ${scenario.sceneDescription}.

        **Core Directives:**
        1.  **Primary Language:** You must primarily speak ${scenario.npcProfile.languages.primary}.
        2.  **Concise and Natural:** Keep your responses concise and natural. Behave like a real person in this situation.
        3.  **Image Generation:** You can trigger an image generation by saying "*shows image of [description]*". For example: "*shows image of a cute cat wearing a hat*". The image will be displayed to the user. Do not explain this to the user.

        **--- CRITICAL: Adaptive Behavior Based on User's Language ---**
        You MUST adapt your responses based on the user's language proficiency, which you can infer from their speech.

        **IF the user speaks English or uses simple/broken words:**
        
        1.  **Check your profile:** Your ability to speak English is defined by your 'fluencySecondary' level: "${scenario.npcProfile.fluencySecondary || 'none'}".
        
        2.  **If your English fluency is 'medium' or 'high':**
            - Switch the primary conversation language to English to be helpful.
            - **Crucially, you MUST mix in key words or simple phrases from your primary language (${scenario.npcProfile.languages.primary}) to encourage learning.** For example: "Yes, the station is that way. You need the *densha* (train) on platform two."
        
        3.  **If your English fluency is 'low' or non-existent ('none'):**
            - **DO NOT switch to English.** You must act realistically confused or like you don't understand.
            - **Slow down your speech.** Use simpler words and shorter sentences in your primary language.
            - Use non-verbal cues in your text, like "*looks confused*", "*tilts head*", or "*points towards the menu*".
            - Try to guess the user's meaning based on their keywords. For example, if the user says "coffee?", you could respond with "*points to the coffee machine* 'コーヒー？' (Coffee?)".
            - **Proactively use the image generation feature to overcome the language barrier.** This is your most important tool when you cannot communicate verbally. For example, if the user asks for directions to a park, you could say "*pulls out a phone and shows a map* *shows image of a map to the nearby park*". Or if they are struggling to order, say "*shows image of the cafe's menu*".

        **--- FINAL RULE ---**
        **You must always provide a spoken response.** Even if you are confused or don't understand, you must express that confusion verbally (e.g., "Sorry, I don't quite understand," or "Pardon?"). Do not respond with only non-verbal cues or silence.
    `;
    
    try {
        const sessionPromise = ai.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            callbacks: {
                onopen: () => console.log('Live session opened.'),
                onmessage: async (message: LiveServerMessage) => {
                    // Keep track if a user transcript was updated in this message
                    let userTranscriptUpdated = false;
                    if (message.serverContent?.inputTranscription) {
                        callbacks.onTranscriptUpdate({
                            speaker: 'user',
                            text: message.serverContent.inputTranscription.text,
                            isFinal: false,
                        });
                        userTranscriptUpdated = true;
                    }
                    
                    if (message.serverContent?.outputTranscription) {
                        callbacks.onTranscriptUpdate({
                            speaker: 'npc',
                            text: message.serverContent.outputTranscription.text,
                            isFinal: false,
                        });
                    }
                    
                    const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                    if (base64Audio) {
                        callbacks.onNpcAudio(base64Audio);
                    }
                    
                    if (message.serverContent?.turnComplete) {
                        // Pass whether the user just spoke to help finalize transcripts correctly
                        callbacks.onTurnComplete();
                    }
                },
                onerror: (e) => callbacks.onError(e),
                onclose: () => callbacks.onClose()
            },
            config: {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: scenario.npcProfile.voice }
                    }
                },
                systemInstruction
            }
        });
        
        const session = await sessionPromise as unknown as LiveSession;
        return session;
    } catch (e: any) {
        console.error("Failed to connect to live session:", e);
        if (e.message?.includes('quota')) {
                throw new Error("API quota exceeded. Please check your billing status or wait and try again.");
        }
        // Re-throw a more user-friendly error
        throw new Error(`Connection to the conversation service failed. This could be due to a network issue or an API configuration problem.`);
    }
};

export const summarizeConversation = async (scenario: Scenario, transcript: Transcript[]): Promise<ConversationResult> => {
    const model = 'gemini-2.5-pro';
    const fullTranscript = transcript.map(t => `${t.speaker === 'user' ? 'User' : 'NPC'}: ${t.text}`).join('\n');
    const prompt = `
        You are an AI language coach analyzing a conversation from the "Rehearsal" app.
        The user's task was: "${scenario.task}"
        
        Here is the conversation transcript:
        ${fullTranscript}
        
        Analyze the conversation and provide feedback. Your response must be a JSON object with the following structure:
        - summary: A very brief (1-2 sentence) summary of the conversation's outcome.
        - tips: An array of 2-3 specific, actionable tips for the user to improve their language skills, based on their performance.
        - taskComplete: A boolean indicating whether the user successfully completed their task.
        - suggestedContinuation: (Optional) If the task is not complete, provide a specific phrase the user could say to continue and complete the task.
        - suggestedContinuationExplanation: (Optional) A brief explanation of why the suggested phrase is appropriate.
    `;

    const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING },
                    tips: { type: Type.ARRAY, items: { type: Type.STRING } },
                    taskComplete: { type: Type.BOOLEAN },
                    suggestedContinuation: { type: Type.STRING, nullable: true },
                    suggestedContinuationExplanation: { type: Type.STRING, nullable: true }
                },
                required: ['summary', 'tips', 'taskComplete']
            }
        }
    });

    const jsonText = response.text.trim();
    return JSON.parse(jsonText) as ConversationResult;
};

export const translateText = async (text: string, targetLanguage: string): Promise<TranslationResult> => {
    const model = 'gemini-2.5-flash';
    const prompt = `
        Translate the following text to ${targetLanguage}.
        Also provide one short, useful cultural or grammatical tip related to the translated phrase.
        Finally, provide a phonetic guide for the translation (e.g., Romaji for Japanese, Pinyin for Chinese).
        Text: "${text}"
        
        Return a JSON object with "translation", "pronunciation", and "tip" keys.
    `;
    const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    translation: { type: Type.STRING },
                    pronunciation: { type: Type.STRING },
                    tip: { type: Type.STRING }
                },
                required: ['translation', 'pronunciation', 'tip']
            }
        }
    });
    const jsonText = response.text.trim();
    return JSON.parse(jsonText);
};

export const generateSpeech = async (text: string, voice: string): Promise<string | null> => {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: [{ parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voice }
                    }
                }
            }
        });
        return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? null;
    } catch (e) {
        console.error("Speech generation failed:", e);
        return null;
    }
};

export const generateHint = async (scenario: Scenario, transcript: Transcript[]): Promise<Hint> => {
    const fullTranscript = transcript.map(t => `${t.speaker === 'user' ? 'User' : 'NPC'}: ${t.text}`).join('\n');
    const prompt = `
        The user is in a language conversation simulation. They seem to be stuck.
        Their task is: "${scenario.task}"
        The target language is: ${scenario.npcProfile.languages.primary}
        Current conversation:
        ${fullTranscript}
        
        Provide a single, short, encouraging hint to help them continue the conversation and achieve their task.
        Your response must be a JSON object with the following structure:
        - suggestion: A phrase in the target language (${scenario.npcProfile.languages.primary}) that the user could say next.
        - translation: The English translation of the suggestion.
        - pronunciation: A phonetic guide for the suggestion (e.g., Romaji for Japanese, Pinyin for Chinese).
        - explanation: A brief, simple explanation of why this suggestion is helpful in this context.
    `;
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    suggestion: { type: Type.STRING },
                    translation: { type: Type.STRING },
                    pronunciation: { type: Type.STRING },
                    explanation: { type: Type.STRING }
                },
                required: ['suggestion', 'translation', 'pronunciation', 'explanation']
            }
        }
    });
    const jsonText = response.text.trim();
    return JSON.parse(jsonText);
};

export const generateStudyCardHint = async (scenario: Scenario): Promise<StudyCardHint> => {
    const prompt = `
        You are a language coach for the "Rehearsal" app. Your goal is to create a "cheat sheet" for the user to help them complete their task.
        The user's task is: "${scenario.task}"
        The target language is: ${scenario.npcProfile.languages.primary}

        Based *only* on the task and target language, generate a list of key vocabulary and useful phrases that the user will likely need.
        Provide the English translation for each term and phrase.
        Provide 3-5 key vocabulary words/phrases and 2-3 useful full phrases.
        Return a JSON object with "vocabulary" and "phrases" keys. Each should be an array of objects, with each object containing "term" and "translation".
    `;
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    vocabulary: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                term: { type: Type.STRING },
                                translation: { type: Type.STRING },
                            },
                            required: ['term', 'translation'],
                        },
                    },
                    phrases: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                term: { type: Type.STRING },
                                translation: { type: Type.STRING },
                            },
                            required: ['term', 'translation'],
                        },
                    },
                },
                required: ['vocabulary', 'phrases'],
            },
        },
    });
    const jsonText = response.text.trim();
    return JSON.parse(jsonText);
};

export const generateSimilarScenario = async (originalScenario: Scenario): Promise<Scenario> => {
    const model = 'gemini-2.5-flash'; // OPTIMIZED: Use faster model
    const validVoices = ['Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir'];
    const prompt = `
        You are a scenario generator for a language learning application.
        The user has just completed a scenario and wants to try a "similar" one for more practice.
        A "similar" scenario means the **core task remains the same**, but the context changes to provide a fresh challenge.

        **CRITICAL RULE: The 'task' for the user MUST be functionally identical to the original task.** For example, if the original task was "Ask a stranger to take your photo", the new task must also be about asking someone to take a photo. Do NOT change it to "Ask for directions".

        **ANOTHER CRITICAL RULE: The NPC's primary language MUST remain the same as the original scenario.** The user is practicing a specific language. The new NPC's primary language must be '${originalScenario.npcProfile.languages.primary}'.

        **Your job is to change the *context* around the task:**
        1.  **Change the Location:** Come up with a new, different \`locationName\` and \`locationType\`.
        2.  **Change the NPC:** Create a completely new \`npcProfile\` with a different name, personality, and background, but speaking the same primary language. The voice must be one of these: ${validVoices.join(', ')}.
        3.  **Change the Scene:** Write a new \`sceneDescription\` for the new location.

        **Original Scenario to base the new one on:**
        ${JSON.stringify(originalScenario, null, 2)}

        Generate a new scenario object with the same JSON structure, following all the rules above.
    `;

     const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    locationName: { type: Type.STRING },
                    locationType: { type: Type.STRING },
                    task: { type: Type.STRING },
                    npcProfile: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            gender: { type: Type.STRING },
                            voice: { type: Type.STRING },
                            languages: {
                                type: Type.OBJECT,
                                properties: {
                                    primary: { type: Type.STRING },
                                    secondary: { type: Type.STRING, nullable: true },
                                },
                                 required: ['primary'],
                            },
                            fluencyPrimary: { type: Type.STRING },
                            fluencySecondary: { type: Type.STRING, nullable: true },
                            patience: { type: Type.STRING },
                            helpfulness: { type: Type.STRING },
                            accent: { type: Type.STRING },
                            quirk: { type: Type.STRING },
                        },
                         required: ['name', 'gender', 'voice', 'languages', 'fluencyPrimary', 'patience', 'helpfulness', 'accent', 'quirk'],
                    },
                    sceneDescription: { type: Type.STRING },
                    conversationStarter: { type: Type.STRING },
                    openingLine: { type: Type.STRING, nullable: true }
                },
                required: ['locationName', 'locationType', 'task', 'npcProfile', 'sceneDescription', 'conversationStarter'],
            }
        }
    });

    const jsonText = response.text.trim();
    const scenarioData = JSON.parse(jsonText) as Scenario;

    // FIX: Validate the generated voice name to prevent crashes
    if (!validVoices.includes(scenarioData.npcProfile.voice)) {
        console.warn(`Invalid voice "${scenarioData.npcProfile.voice}" generated by model. Defaulting to 'Zephyr' to prevent a crash.`);
        scenarioData.npcProfile.voice = 'Zephyr';
    }

    return scenarioData;
};

export const generateImage = async (prompt: string, language?: string): Promise<string | null> => {
    try {
        let imageGenPrompt = `A realistic photograph of ${prompt}.`;
        if (language) {
            imageGenPrompt += ` Any text in the image, such as on a menu or a sign, should be in ${language}. For example, if it's a menu, the items should be written in ${language}.`;
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
                parts: [{ text: imageGenPrompt }],
            },
            config: {
                responseModalities: [Modality.IMAGE],
            },
        });
        for (const part of response.candidates?.[0]?.content?.parts ?? []) {
            if (part.inlineData) {
                const base64ImageBytes: string = part.inlineData.data;
                return `data:image/jpeg;base64,${base64ImageBytes}`;
            }
        }
        return null;
    } catch (e) {
        console.error("Image generation failed", e);
        return null;
    }
};