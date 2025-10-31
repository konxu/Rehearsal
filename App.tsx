import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    ConversationStatus,
    Scenario,
    Transcript,
    ConversationResult,
    LiveSession,
    Hint,
    TranslationResult,
    StudyCardHint
} from './types';
import {
    generateScenario,
    startConversation,
    summarizeConversation,
    createBlob,
    translateText,
    generateSpeech,
    generateHint,
    generateStudyCardHint,
    generateSimilarScenario,
    generateImage,
} from './services/geminiService';
import {
    Bot, CheckCircle, Lightbulb, Loader, Mic, PhoneOff, RefreshCw, Settings, SpeakerWave, Star, User, X, Stop
} from './components/Icons';

// --- Global Type Augmentations ---
declare global {
    interface Window {
        google: any;
        initMap: () => void;
        webkitAudioContext: typeof AudioContext;
    }
}

// --- Audio Helper Functions ---
const decode = (base64: string): Uint8Array => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
};

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}


// --- Main App Component ---
const App: React.FC = () => {
    // --- State Management ---
    const [status, setStatus] = useState<ConversationStatus>(ConversationStatus.Idle);
    const [scenario, setScenario] = useState<Scenario | null>(null);
    const [transcript, setTranscript] = useState<Transcript[]>([]);
    const [result, setResult] = useState<ConversationResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isNpcSpeaking, setIsNpcSpeaking] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [translation, setTranslation] = useState<{ text: string, data: TranslationResult } | null>(null);
    const [mapApiKey, setMapApiKey] = useState<string | null>(() => localStorage.getItem('googleMapsApiKey'));
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [mapError, setMapError] = useState<string | null>(null);
    const [isStreetViewVisible, setIsStreetViewVisible] = useState(false);
    const [mapReady, setMapReady] = useState(false);
    const [hint, setHint] = useState<Hint | null>(null);
    const [studyCardHint, setStudyCardHint] = useState<StudyCardHint | null>(null);


    // --- Refs ---
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstance = useRef<any>(null);
    const streetViewInstance = useRef<any>(null);
    const liveSessionRef = useRef<LiveSession | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const nextStartTimeRef = useRef<number>(0);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    const inactivityTimerRef = useRef<number | null>(null);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

    // --- Audio Playback ---
    const playAudioChunk = useCallback(async (base64Audio: string) => {
        if (!outputAudioContextRef.current || !base64Audio) return;
        const audioContext = outputAudioContextRef.current;
    
        // Ensure context is running
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        try {
            const audioBytes = decode(base64Audio);
            const audioBuffer = await decodeAudioData(audioBytes, audioContext, 24000, 1);

            // Schedule this chunk to play right after the previous one finishes
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContext.currentTime);

            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);

            // Keep track of active sources for cleanup/interruption
            audioSourcesRef.current.add(source);
            source.onended = () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) {
                    setIsNpcSpeaking(false);
                }
            };
            
            source.start(nextStartTimeRef.current);
            // Update the start time for the *next* chunk
            nextStartTimeRef.current += audioBuffer.duration;
        } catch (e) {
            console.error("Failed to play audio chunk:", e);
        }
    }, []);

    // --- Audio & Session Cleanup ---
    const cleanupAudioAndSession = useCallback(() => {
        try {
            liveSessionRef.current?.close();
        } catch (e) { console.error("Error closing live session:", e); }
        liveSessionRef.current = null;

        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
        }

        try {
            if (scriptProcessorRef.current) {
                scriptProcessorRef.current.disconnect();
            }
        } catch (e) { console.error("Error disconnecting script processor:", e); }
        scriptProcessorRef.current = null;
        
        try {
            if (mediaStreamSourceRef.current) {
                mediaStreamSourceRef.current.disconnect();
            }
        } catch (e) { console.error("Error disconnecting media stream source:", e); }
        mediaStreamSourceRef.current = null;
        
        if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
            inputAudioContextRef.current.close().catch(e => console.error("Error closing input audio context:", e));
        }
        inputAudioContextRef.current = null;

        try {
            audioSourcesRef.current.forEach(source => source.stop());
        } catch (e) { console.error("Error stopping audio sources:", e); }
        audioSourcesRef.current.clear();
        
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
            outputAudioContextRef.current.close().catch(e => console.error("Error closing output audio context:", e));
        }
        outputAudioContextRef.current = null;
        
        setIsRecording(false);
        setIsNpcSpeaking(false);
    }, []);
    
    // --- Microphone Recording Logic ---
    const startRecording = () => {
        if (!scriptProcessorRef.current || !mediaStreamSourceRef.current || !inputAudioContextRef.current || status !== ConversationStatus.Active) return;
        mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
        scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
        setIsRecording(true);
    };

    const stopRecording = () => {
        if (!scriptProcessorRef.current || !mediaStreamSourceRef.current) return;
        scriptProcessorRef.current.disconnect();
        setIsRecording(false);
    };
    
    const handleMicToggle = () => {
        if (isRecording) {
            stopRecording();
        } else {
            clearInactivityTimer();
            setHint(null);
            startRecording();
        }
    };

    // --- UI Interaction Handlers ---
    const handleCloseRehearsal = useCallback(() => {
        cleanupAudioAndSession();
        // FIX: Wrap network-dependent call in try/catch to ensure UI always resets.
        try {
            if (streetViewInstance.current && streetViewInstance.current.getVisible()) {
                streetViewInstance.current.setVisible(false);
            }
        } catch (e) {
            console.error("Failed to hide Street View, likely a network issue. Resetting state anyway.", e);
        }
        setStatus(ConversationStatus.Idle);
        setScenario(null);
        setTranscript([]);
        setResult(null);
        setError(null);
        setStudyCardHint(null);
    }, [cleanupAudioAndSession]);

    // --- Core Interaction Flow ---
    const handleRehearsalStartRequest = useCallback(async () => {
        // Use a ref for status check to avoid dependency on status state in useCallback
        if (!streetViewInstance.current || !streetViewInstance.current.getVisible() || status === ConversationStatus.Generating) return;

        setStatus(ConversationStatus.Generating);
        setError(null);
        setTranscript([]);
        setResult(null);
        setScenario(null);

        try {
            const location = streetViewInstance.current.getLocation();
             if (!location || !location.latLng || typeof location.latLng.lat !== 'function') {
                 throw new Error("Could not retrieve valid location data from Street View.");
            }
            const locationName = location.description || `Street View at ${location.latLng.lat().toFixed(4)}, ${location.latLng.lng().toFixed(4)}`;
            const context = `User is in Street View at position: ${location.latLng.toString()}`;

            const generatedScenario = await generateScenario(locationName, context);
            setScenario(generatedScenario);
            setStatus(ConversationStatus.Briefing);
        } catch (e: any) {
            console.error('Scenario generation failed:', e);
            setError(`Failed to create a scenario for this location. Please try another spot. (${e.message})`);
            setStatus(ConversationStatus.Error);
        }
    }, [status]); // status dependency is acceptable here as it's a guard.
    
    const handleEndConversation = useCallback(async () => {
        if (status === ConversationStatus.Summarizing) return;
        
        setStatus(ConversationStatus.Summarizing);
        cleanupAudioAndSession();
        
        if (!scenario || transcript.length === 0) {
             handleCloseRehearsal();
             return;
        };

        try {
            const summaryResult = await summarizeConversation(scenario, transcript);
            setResult(summaryResult);
            setStatus(ConversationStatus.PausedForFeedback);
        } catch (e: any) {
            console.error('Summarization failed:', e);
            setError('Failed to get feedback on the conversation.');
            setStatus(ConversationStatus.Error);
        }
    }, [scenario, transcript, cleanupAudioAndSession, status, handleCloseRehearsal]);

    const handleBeginConversation = useCallback(async (isContinuing = false) => {
        if (!scenario) return;

        setStatus(ConversationStatus.Ready);
        if (!isContinuing) {
            setTranscript([]);
        }
        setTranslation(null);

        try {
            // Setup input audio
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localStreamRef.current = stream;
            const inContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            inputAudioContextRef.current = inContext;
            const source = inContext.createMediaStreamSource(stream);
            mediaStreamSourceRef.current = source;
            const processor = inContext.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;
            
            // Setup output audio
            outputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            nextStartTimeRef.current = 0;

            processor.onaudioprocess = (audioProcessingEvent) => {
                const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                // Ensure session is active before sending data
                if (liveSessionRef.current) {
                    liveSessionRef.current.sendRealtimeInput({ media: pcmBlob });
                }
            };
            
            const session = await startConversation(scenario, {
                onTranscriptUpdate: (newTranscript) => {
                     setTranscript(prev => {
                        let updated = [...prev];
                        const lastEntry = updated.length > 0 ? updated[updated.length - 1] : null;

                        if (lastEntry && lastEntry.speaker === newTranscript.speaker && !lastEntry.isFinal) {
                            updated[updated.length - 1] = {
                                ...lastEntry,
                                text: lastEntry.text + newTranscript.text,
                            };
                        } else {
                            updated.push(newTranscript);
                        }
                        return updated;
                    });
                },
                onNpcAudio: (audioData) => {
                    if (!isNpcSpeaking) setIsNpcSpeaking(true);
                    playAudioChunk(audioData);
                },
                onTurnComplete: () => {
                    setTranscript(prev => prev.map(t => ({ ...t, isFinal: true })));
                },
                onError: (e) => {
                    console.error('Conversation error:', e);
                    setError(e.message);
                    setStatus(ConversationStatus.Error);
                    cleanupAudioAndSession();
                },
                onClose: () => {
                    console.log('Conversation closed by server.');
                    if(status === ConversationStatus.Active) {
                       handleEndConversation();
                    } else {
                       cleanupAudioAndSession();
                    }
                }
            });

            liveSessionRef.current = session;
            setStatus(ConversationStatus.Active);
            
            if (scenario.conversationStarter === 'npc' && scenario.openingLine && !isContinuing) {
                setIsNpcSpeaking(true);
                const openingTranscript = { speaker: 'npc' as const, text: scenario.openingLine, isFinal: true };
                setTranscript([openingTranscript]);
                try {
                    const audioData = await generateSpeech(scenario.openingLine, scenario.npcProfile.voice);
                    // If audio is successfully generated and played, the onended event in playAudioChunk
                    // will set isNpcSpeaking back to false.
                    if (audioData) {
                        await playAudioChunk(audioData);
                    } else {
                        // If no audio data is returned, we must manually unset the speaking flag.
                        console.warn("NPC opening line audio generation returned no data.");
                        setIsNpcSpeaking(false);
                    }
                } catch (e) {
                    console.error("Failed to generate or play NPC opening line:", e);
                    // Also unset the flag on any error during generation/playback.
                    setIsNpcSpeaking(false);
                }
            }

        } catch (err: any) {
            console.error('Failed to start conversation:', err);
            setError(err.message || 'Failed to start conversation. Please check microphone permissions and your network connection.');
            setStatus(ConversationStatus.Error);
        }
    }, [scenario, cleanupAudioAndSession, status, handleEndConversation, playAudioChunk]);

    const handleTrySimilarScenario = async () => {
        if (!scenario) return;

        setStatus(ConversationStatus.Generating);
        setError(null);
        setTranscript([]);
        setResult(null);

        try {
            const newScenario = await generateSimilarScenario(scenario);
            setScenario(newScenario);
            setStatus(ConversationStatus.Briefing);
        } catch (e: any) {
            console.error('Similar scenario generation failed:', e);
            setError(`Failed to create a similar scenario. Please try a new location. (${e.message})`);
            setStatus(ConversationStatus.Error);
        }
    };
    
    const handleExitToStreetView = useCallback(() => {
        cleanupAudioAndSession();
        setStatus(ConversationStatus.Idle);
        setScenario(null);
        setTranscript([]);
        setResult(null);
        setError(null);
        setStudyCardHint(null);
    }, [cleanupAudioAndSession]);

    const handleShowTranslation = async (text: string, lang: string) => {
        if (translation?.text === text) {
            setTranslation(null); // Hide on second click
            return;
        }
        try {
            const result = await translateText(text, lang);
            setTranslation({ text, data: result });
        } catch (e) {
            console.error("Translation failed", e);
        }
    }

    const handleStudyCardRequest = async () => {
        if (!scenario) return;
        try {
            const hint = await generateStudyCardHint(scenario);
            setStudyCardHint(hint);
        } catch(e) {
            console.error("Study card hint failed", e);
        }
    };

    // --- Map Initialization ---
    const initMap = useCallback(() => {
        if (!mapRef.current || !window.google) {
            const errorMsg = "Google Maps script failed to load. Please check your API key and ensure it has the 'Maps JavaScript API', 'Places API', and 'Street View API' enabled in the Google Cloud Console.";
            setMapError(errorMsg);
             localStorage.removeItem('googleMapsApiKey');
             setMapApiKey(null);
            return;
        }

        try {
            const map = new window.google.maps.Map(mapRef.current, {
                center: { lat: 48.8584, lng: 2.2945 }, // Default to Eiffel Tower
                zoom: 15,
                streetViewControl: true,
            });
            mapInstance.current = map;
            streetViewInstance.current = map.getStreetView();
            setMapReady(true); 
        } catch (e: any) {
            console.error("Map initialization error:", e);
            const errorMsg = "Could not initialize Google Maps. The API key might be invalid, restricted, or billing is not enabled.";
            setMapError(errorMsg);
            localStorage.removeItem('googleMapsApiKey');
            setMapApiKey(null);
        }
    }, []);

    useEffect(() => {
        if (mapApiKey && !window.google) {
            window.initMap = initMap;
            const scriptId = 'google-maps-script';
            let script = document.getElementById(scriptId) as HTMLScriptElement;
            if (!script) {
                script = document.createElement('script');
                script.id = scriptId;
                document.head.appendChild(script);
            }
            // FIX: Add 'places' and 'streetView' libraries to ensure all services are available.
            script.src = `https://maps.googleapis.com/maps/api/js?key=${mapApiKey}&callback=initMap&libraries=marker,places,streetView`;
            script.async = true;
            script.defer = true;
            script.onerror = () => {
                 setMapError("Failed to load Google Maps script. Check your API key and network connection.");
                 setMapApiKey(null); 
                 localStorage.removeItem('googleMapsApiKey');
            }
        } else if (mapApiKey && window.google && !mapInstance.current) {
            initMap();
        }
    }, [mapApiKey, initMap]);
    
    // FIX: Refactor event listener to prevent memory leaks and crashes.
    useEffect(() => {
        if (!mapReady || !streetViewInstance.current) return;

        const listener = streetViewInstance.current.addListener('visible_changed', () => {
            setIsStreetViewVisible(streetViewInstance.current.getVisible());
        });

        return () => {
            window.google.maps.event.removeListener(listener);
        };
    }, [mapReady]);

    useEffect(() => {
        // If street view is closed by the user (e.g. pressing ESC), reset the app state.
        if (!isStreetViewVisible && status !== ConversationStatus.Idle) {
            handleCloseRehearsal();
        }
    }, [isStreetViewVisible, status, handleCloseRehearsal]);

    const handleApiKeySubmit = () => {
        if (apiKeyInput.trim()) {
            localStorage.setItem('googleMapsApiKey', apiKeyInput.trim());
            setMapApiKey(apiKeyInput.trim());
            setMapError(null);
        }
    };
    
    // --- Effects ---
    useEffect(() => {
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcript, hint]);

    useEffect(() => {
        const lastEntry = transcript.length > 0 ? transcript[transcript.length - 1] : null;

        if (lastEntry && lastEntry.speaker === 'npc' && typeof lastEntry.imageUrl === 'undefined') {
            const imageRegex = /\*shows image of (.*?)\*/;
            const match = lastEntry.text.match(imageRegex);

            if (match) {
                const imagePrompt = match[1];
                const currentIndex = transcript.length - 1;

                setTranscript(prev => {
                    const updated = [...prev];
                    if (updated[currentIndex]) {
                        updated[currentIndex] = {
                            ...updated[currentIndex],
                            text: updated[currentIndex].text.replace(imageRegex, '').trim(),
                            imageUrl: 'loading',
                        };
                    }
                    return updated;
                });

                generateImage(imagePrompt, scenario?.npcProfile.languages.primary).then(imageUrl => {
                    setTranscript(prev => {
                        const updated = [...prev];
                        if (updated[currentIndex]) {
                            updated[currentIndex] = {
                                ...updated[currentIndex],
                                imageUrl: imageUrl || 'error',
                            };
                        }
                        return updated;
                    });
                });
            }
        }
    }, [transcript, scenario]);


    useEffect(() => {
        return () => cleanupAudioAndSession();
    }, [cleanupAudioAndSession]);
    
    const clearInactivityTimer = useCallback(() => {
        if (inactivityTimerRef.current) {
            clearTimeout(inactivityTimerRef.current);
            inactivityTimerRef.current = null;
        }
    }, []);

    const startInactivityTimer = useCallback(() => {
        clearInactivityTimer();
        inactivityTimerRef.current = window.setTimeout(async () => {
            if (status === ConversationStatus.Active && scenario) {
                const finalTranscript = transcript.filter(t => t.isFinal);
                const generatedHint = await generateHint(scenario, finalTranscript);
                setHint(generatedHint);
            }
        }, 12000);
    }, [clearInactivityTimer, scenario, transcript, status]);


    useEffect(() => {
        if (status === ConversationStatus.Active && !isNpcSpeaking && !isRecording) {
            startInactivityTimer();
        } else {
            clearInactivityTimer();
            if(hint) setHint(null);
        }
        return () => clearInactivityTimer();
    }, [isNpcSpeaking, isRecording, status, startInactivityTimer, clearInactivityTimer, hint]);


    // --- Render Logic ---
    if (!mapApiKey || mapError) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-gray-900">
                <div className="max-w-md w-full bg-gray-800 p-8 rounded-lg shadow-lg text-center">
                    <h1 className="text-3xl font-bold mb-4">Welcome to Rehearsal</h1>
                     {mapError && (
                        <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-md mb-6">
                            <p className="font-bold">Map Loading Failed</p>
                            <p className="text-sm">{mapError}</p>
                        </div>
                    )}
                    <p className="mb-6 text-gray-400">To explore the world, please enter your Google Maps API key.</p>
                    <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        className="w-full p-3 bg-gray-700 rounded-md mb-4 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="Paste your API key here"
                    />
                    <button onClick={handleApiKeySubmit} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-md transition-colors">
                        {mapError ? 'Save & Try Again' : 'Save and Start'}
                    </button>
                    <a href="https://developers.google.com/maps/documentation/javascript/get-api-key" target="_blank" rel="noopener noreferrer" className="block mt-4 text-sm text-blue-400 hover:underline">
                        How to get an API key? (And enable billing)
                    </a>
                </div>
            </div>
        );
    }
    
    const microphoneStateLabel = () => {
        if (status !== ConversationStatus.Active) return '';
        if (isNpcSpeaking) return 'NPC is speaking...';
        if (isRecording) return 'Recording... Click to stop';
        return 'Click the mic to speak';
    };

    // Main UI with Map
    return (
        <div className="w-full h-full relative">
            <div ref={mapRef} className="w-full h-full" />
            
            {status === ConversationStatus.Idle && (
                <button 
                    onClick={() => { localStorage.removeItem('googleMapsApiKey'); setMapApiKey(null); setMapError(null); window.location.reload(); }} 
                    className="absolute top-14 right-4 z-10 bg-black/50 p-2 rounded-full hover:bg-black/80 transition-colors" 
                    title="Change API Key"
                >
                    <Settings className="w-6 h-6 text-white"/>
                </button>
            )}
             
             {isStreetViewVisible && status === ConversationStatus.Idle && (
                <button onClick={handleRehearsalStartRequest} className="pulse-glow-button absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-8 rounded-lg shadow-2xl text-xl">
                    Rehearse Here
                </button>
             )}

             {status !== ConversationStatus.Idle && (
                 <button onClick={handleExitToStreetView} className="absolute top-14 right-4 z-50 bg-black/50 p-2 rounded-full hover:bg-black/80 transition-colors" title="Exit Rehearsal">
                    <X className="w-6 h-6 text-white"/>
                 </button>
             )}

            {/* Floating UI Overlays */}
            {status === ConversationStatus.Generating && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-40">
                    <div className="text-center p-8 bg-black/70 backdrop-blur-sm rounded-lg">
                        <Loader className="w-12 h-12 mx-auto animate-spin mb-4" />
                        <h2 className="text-2xl font-bold">Creating a scenario...</h2>
                        <p className="text-gray-300">Analyzing the location to build an immersive experience.</p>
                    </div>
                </div>
            )}

            {status === ConversationStatus.Briefing && scenario && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-40">
                    <div className="max-w-lg w-full text-center p-8 bg-black/70 backdrop-blur-sm rounded-lg shadow-2xl">
                        <h2 className="text-3xl font-bold mb-2">Your Scenario: {scenario.locationName}</h2>
                        <p className="text-lg text-gray-300 mb-4">{scenario.sceneDescription}</p>
                        <div className="bg-black/30 p-4 rounded-lg mb-6">
                            <p className="text-xl"><Star className="inline w-6 h-6 mr-2 text-yellow-400" /> <strong>Your Task:</strong> {scenario.task}</p>
                        </div>
                        <button onClick={() => handleBeginConversation(false)} className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-md text-xl transition-colors">
                            Begin Conversation
                        </button>
                    </div>
                </div>
            )}
            
            {(status === ConversationStatus.Active || status === ConversationStatus.Ready) && scenario && (
                 <div className="absolute bottom-0 left-0 right-0 p-4 z-40 pointer-events-none">
                    <div className="max-w-3xl mx-auto bg-black/70 backdrop-blur-md rounded-lg p-4 shadow-2xl flex flex-col h-[40vh] pointer-events-auto">
                         <div className="text-center text-sm text-gray-300 py-2 border-b border-white/20 mb-2">
                             <p><strong>Your Task:</strong> {scenario.task}</p>
                         </div>
                        <div className="flex-grow overflow-y-auto pr-2">
                            {transcript.length === 0 && status === ConversationStatus.Active && (
                                <div className="text-center text-gray-400 p-4">
                                    <p>{scenario?.conversationStarter === 'npc' ? 'Waiting for the NPC to speak...' : 'Click the microphone to start/stop speaking.'}</p>
                                </div>
                            )}
                             {transcript.map((t, i) => (
                                <div key={i} className={`flex items-start gap-3 my-2 ${t.speaker === 'user' ? 'justify-end' : ''}`}>
                                     {t.speaker === 'npc' && <Bot className="w-8 h-8 flex-shrink-0 text-cyan-400" />}
                                     <div className={`p-3 rounded-lg max-w-md ${t.speaker === 'npc' ? 'bg-gray-700' : 'bg-blue-600'}`}>
                                        <div className="flex items-center gap-2">
                                            <p onClick={() => scenario && handleShowTranslation(t.text, scenario.npcProfile.languages.primary)} className="cursor-pointer flex-grow">{t.text}</p>
                                            {t.speaker === 'npc' && (
                                                <button onClick={() => scenario && generateSpeech(t.text, scenario.npcProfile.voice).then(playAudioChunk)} className="text-white/70 hover:text-white flex-shrink-0">
                                                    <SpeakerWave className="w-4 h-4"/>
                                                </button>
                                            )}
                                        </div>
                                         {t.imageUrl === 'loading' && (
                                            <div className="mt-2 pt-2 border-t border-white/20 flex items-center justify-center">
                                                <Loader className="w-6 h-6 animate-spin text-gray-400" />
                                                <p className="ml-2 text-sm text-gray-400">Generating image...</p>
                                            </div>
                                        )}
                                        {t.imageUrl && t.imageUrl !== 'loading' && t.imageUrl !== 'error' && (
                                            <img src={t.imageUrl} alt="Generated by AI" className="mt-2 rounded-lg max-w-full h-auto" />
                                        )}
                                        {translation && translation.text === t.text && (
                                            <div className="mt-2 pt-2 border-t border-white/20">
                                                <p className="text-sm text-gray-300"><strong>Translation:</strong> {translation.data.translation}</p>
                                                <p className="text-sm text-cyan-300"><em>({translation.data.pronunciation})</em></p>
                                                <p className="text-sm text-amber-300 mt-1"><strong><Lightbulb className="inline w-4 h-4 mr-1"/> Tip:</strong> {translation.data.tip}</p>
                                            </div>
                                        )}
                                     </div>
                                     {t.speaker === 'user' && <User className="w-8 h-8 flex-shrink-0 text-gray-300" />}
                                </div>
                            ))}
                             {hint && (
                                 <div className="text-center my-4 p-3 mx-4 bg-black/40 rounded-lg border border-amber-500/30">
                                     <p className="text-amber-300 text-sm font-bold"><Lightbulb className="inline w-4 h-4 mr-1"/> Stuck? Try this:</p>
                                     <p className="text-lg font-semibold mt-1">{hint.suggestion}</p>
                                     <p className="text-sm text-cyan-300">({hint.pronunciation})</p>
                                     <p className="text-sm text-gray-300 italic">"{hint.translation}"</p>
                                     <p className="text-xs text-gray-400 mt-2">{hint.explanation}</p>
                                 </div>
                            )}
                            <div ref={transcriptEndRef} />
                        </div>
                         <div className="flex flex-col items-center justify-center pt-4 border-t border-white/20">
                            <div className="flex items-center justify-center w-full">
                                <button 
                                    onClick={handleEndConversation}
                                    className="text-white/70 hover:text-white font-bold p-4 rounded-full transition-colors"
                                    title="End & Get Feedback"
                                    disabled={status !== ConversationStatus.Active}
                                >
                                    <PhoneOff className="w-6 h-6"/>
                                </button>
                                <button
                                    onClick={handleMicToggle}
                                    className={`p-5 rounded-full mx-4 transition-colors ${isRecording ? 'bg-red-600 animate-pulse' : 'bg-green-600'} text-white disabled:bg-gray-500`}
                                    disabled={isNpcSpeaking || status !== ConversationStatus.Active}
                                    title={isRecording ? 'Click to stop' : 'Click to speak'}
                                >
                                    {isRecording ? <Stop className="w-8 h-8"/> : <Mic className="w-8 h-8"/>}
                                </button>
                                 <button
                                    onClick={handleStudyCardRequest}
                                    className="text-white/70 hover:text-white font-bold p-4 rounded-full transition-colors"
                                    title="Get a Study Hint"
                                    disabled={status !== ConversationStatus.Active}
                                >
                                    <Lightbulb className="w-6 h-6"/>
                                </button>
                            </div>
                            <p className="text-xs text-gray-400 mt-2 h-4">{microphoneStateLabel()}</p>
                         </div>
                    </div>
                </div>
            )}

            {studyCardHint && (
                <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
                    <div className="max-w-md w-full p-6 bg-gray-800 rounded-lg shadow-2xl relative">
                        <button onClick={() => setStudyCardHint(null)} className="absolute top-2 right-2 text-gray-400 hover:text-white">
                            <X className="w-6 h-6"/>
                        </button>
                        <h3 className="text-2xl font-bold mb-4 text-center">Study Card</h3>
                        <div className="mb-4">
                            <h4 className="font-bold text-lg mb-2 text-amber-300">Key Vocabulary</h4>
                            <ul className="space-y-1 text-gray-300">
                                {studyCardHint.vocabulary.map((v, i) => (
                                    <li key={`v-${i}`} className="grid grid-cols-2 gap-2">
                                        <span>{v.term}</span>
                                        <span className="text-gray-400 text-right">{v.translation}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                         <div>
                            <h4 className="font-bold text-lg mb-2 text-amber-300">Useful Phrases</h4>
                             <ul className="space-y-2 text-gray-300">
                                {studyCardHint.phrases.map((p, i) => (
                                     <li key={`p-${i}`}>
                                        <p>{p.term}</p>
                                        <p className="text-gray-400 text-sm italic">"{p.translation}"</p>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            )}

            {(status === ConversationStatus.PausedForFeedback || status === ConversationStatus.Summarizing) && (
                 <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-40">
                     {status === ConversationStatus.Summarizing ? (
                          <div className="text-center p-8 bg-black/70 backdrop-blur-sm rounded-lg">
                            <Loader className="w-12 h-12 mx-auto animate-spin mb-4" />
                            <h2 className="text-2xl font-bold">Analyzing your conversation...</h2>
                        </div>
                     ) : result && (
                         <div className="max-w-lg w-full text-center p-8 bg-black/80 backdrop-blur-sm rounded-lg shadow-2xl">
                             <h2 className="text-3xl font-bold mb-2">Conversation Complete!</h2>
                             <div className="flex items-center justify-center gap-2 text-xl my-4">
                                {result.taskComplete ? <CheckCircle className="w-8 h-8 text-green-500"/> : <RefreshCw className="w-8 h-8 text-yellow-500"/>}
                                <p>{result.summary}</p>
                             </div>
                             <div className="text-left bg-black/30 p-4 rounded-lg mb-6">
                                <h4 className="font-bold mb-2"><Lightbulb className="inline w-5 h-5 mr-2"/> Tips for Improvement:</h4>
                                <ul className="list-disc list-inside space-y-1 text-gray-300">
                                    {result.tips.map((tip, i) => <li key={i}>{tip}</li>)}
                                </ul>
                             </div>
                            
                            {!result.taskComplete && result.suggestedContinuation && (
                                <div className="bg-blue-900/50 p-4 rounded-lg mb-4 text-left">
                                     <div className="flex justify-between items-center">
                                        <div>
                                            <h4 className="font-bold mb-2">Want to finish your task?</h4>
                                            <p>You could say: "{result.suggestedContinuation}"</p>
                                            <p className="text-sm text-gray-400 mt-1"><em>({result.suggestedContinuationExplanation})</em></p>
                                        </div>
                                        <button onClick={() => scenario && result.suggestedContinuation && generateSpeech(result.suggestedContinuation, scenario.npcProfile.voice).then(playAudioChunk)} className="text-white/70 hover:text-white flex-shrink-0 p-2">
                                            <SpeakerWave className="w-6 h-6"/>
                                        </button>
                                     </div>
                                </div>
                            )}

                             <div className="flex gap-4">
                                {!result.taskComplete && (
                                    <button onClick={() => handleBeginConversation(true)} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-md transition-colors">Continue Task</button>
                                )}
                                <button onClick={handleTrySimilarScenario} className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-bold py-3 rounded-md transition-colors">Try Similar Task</button>
                                 <button 
                                    onClick={handleCloseRehearsal} 
                                    className="flex-1 bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 rounded-md transition-colors"
                                >
                                    New Scenario
                                </button>
                             </div>
                         </div>
                     )}
                 </div>
            )}
            
            {error && status === ConversationStatus.Error && (
                 <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50">
                     <div className="max-w-md w-full text-center p-8 bg-red-900/80 backdrop-blur-sm rounded-lg shadow-2xl">
                         <h2 className="text-2xl font-bold mb-4">An Error Occurred</h2>
                         <p className="mb-6">{error}</p>
                         <button onClick={handleCloseRehearsal} className="bg-white text-black font-bold py-3 px-6 rounded-md">Return to Map</button>
                     </div>
                 </div>
            )}
        </div>
    );
};

export default App;