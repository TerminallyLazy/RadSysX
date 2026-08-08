"use client";

import React, { useState, useCallback, useRef, useEffect } from 'react';
import Draggable, { type DraggableEventHandler, type DraggableProps } from 'react-draggable';
import { Play, Pause, Mic, Monitor, Video, X, Trash2, ChevronUp, ChevronDown, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGemini } from './Providers';
import { geminiEvents } from '@/lib/hooks/useGeminiConnection';

interface MediaControlPanelProps {
  onClose?: () => void;
}
interface LogEntry {
  timestamp: Date;
  type: 'info' | 'error' | 'api' | 'gemini';
  message: string;
}

const DraggablePanel = Draggable as unknown as React.ComponentType<Partial<DraggableProps>>;

export function MediaControlPanel({ onClose }: MediaControlPanelProps) {
  // Panel state
  const [panelSize, setPanelSize] = useState({ width: 320, height: 300 });
  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 }); // Initialize with safe defaults
  const [actualHeight, setActualHeight] = useState(100);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionRafRef = useRef<number>();
  const transitionTimeoutRef = useRef<NodeJS.Timeout>();

  // Log state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLogExpanded, setIsLogExpanded] = useState(true);
  const [isLogMaximized, setIsLogMaximized] = useState(false);

  const calculateBounds = useCallback(() => {
    // Guard against SSR
    if (typeof window === 'undefined') {
      return { maxX: 0, maxY: 0, padding: 16 };
    }
    
    const currentHeight = isLogExpanded ? panelSize.height : 100;
    const padding = 16;
    return {
      maxX: window.innerWidth - (panelSize.width + padding),
      maxY: window.innerHeight - (currentHeight + padding),
      padding
    };
  }, [isLogExpanded, panelSize.width, panelSize.height]);

  const handleDragStart = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleDrag: DraggableEventHandler = useCallback((e, data) => {
    e.preventDefault();
    const { maxX, maxY, padding } = calculateBounds();
    
    requestAnimationFrame(() => {
      setPosition({
        x: Math.min(Math.max(data.x, padding), maxX),
        y: Math.min(Math.max(data.y, padding), maxY)
      });
    });
  }, [calculateBounds]);

  const handleDragStop = useCallback(() => {
    setIsDragging(false);
    const { maxX, maxY, padding } = calculateBounds();
    
    requestAnimationFrame(() => {
      setPosition(prev => ({
        x: Math.min(Math.max(prev.x, padding), maxX),
        y: Math.min(Math.max(prev.y, padding), maxY)
      }));
    });
  }, [calculateBounds]);

  const handleHeightTransition = useCallback(() => {
    if (transitionRafRef.current) {
      cancelAnimationFrame(transitionRafRef.current);
    }
    if (transitionTimeoutRef.current) {
      clearTimeout(transitionTimeoutRef.current);
    }

    setIsTransitioning(true);
    const newHeight = isLogExpanded ? panelSize.height : 100;
    
    transitionRafRef.current = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setActualHeight(newHeight);
        const { maxY, padding } = calculateBounds();
        
        setPosition(prev => ({
          x: prev.x,
          y: Math.min(prev.y, maxY)
        }));
      });
    });

    transitionTimeoutRef.current = setTimeout(() => {
      setIsTransitioning(false);
    }, 300);
  }, [isLogExpanded, panelSize.height, calculateBounds]);

  // Media state
  const [activeButton, setActiveButton] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  // Refs
  const nodeRef = useRef(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);

  // Gemini connection
  const { isConnected, isConnecting, connect, disconnect, sendAudioChunk } = useGemini();


  // Initialize position and handle window resize
  useEffect(() => {
    // Only run on client side
    if (typeof window === 'undefined') return;
    
    if (!isInitialized) {
      const { maxY, padding } = calculateBounds();
      const initialX = window.innerWidth / 2 - panelSize.width / 2;
      const initialY = window.innerHeight - (isLogExpanded ? panelSize.height : 100) - padding;
      setPosition({ x: initialX, y: initialY });
      setIsInitialized(true);
    }

    let rafId: number;
    let resizeTimeout: NodeJS.Timeout;

    const handleResize = () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeTimeout) clearTimeout(resizeTimeout);

      resizeTimeout = setTimeout(() => {
        rafId = requestAnimationFrame(() => {
          const { maxY, padding } = calculateBounds();
          setPosition(prev => ({
            x: Math.min(Math.max(prev.x, padding), window.innerWidth - padding),
            y: Math.min(Math.max(prev.y, padding), maxY)
          }));
        });
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, [calculateBounds, isInitialized, panelSize, isLogExpanded]);

  // Cleanup transition animations on unmount
  useEffect(() => {
    return () => {
      if (transitionRafRef.current) {
        cancelAnimationFrame(transitionRafRef.current);
      }
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  // Update height when log state changes
  useEffect(() => {
    handleHeightTransition();
  }, [isLogExpanded, handleHeightTransition]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs(prev => [...prev, { timestamp: new Date(), type, message }]);
    // Scroll to bottom
    if (logContainerRef.current) {
      setTimeout(() => {
        logContainerRef.current!.scrollTop = logContainerRef.current!.scrollHeight;
      }, 0);
    }
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Clean up audio processing when component unmounts or stream changes
  useEffect(() => {
    return () => {
      if (processorNodeRef.current) {
        processorNodeRef.current.disconnect();
        processorNodeRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  const startAudioProcessing = useCallback((audioStream: MediaStream) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();  // Use default sample rate
    }

    const source = audioContextRef.current.createMediaStreamSource(audioStream);
    const processor = audioContextRef.current.createScriptProcessor(2048, 1, 1);
    processorNodeRef.current = processor;

    processor.onaudioprocess = async (e) => {
      if (isConnected) {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Downsample to 16kHz if needed
        const downsampledLength = Math.floor(inputData.length * 16000 / audioContextRef.current!.sampleRate);
        const downsampledData = new Float32Array(downsampledLength);
        
        const step = audioContextRef.current!.sampleRate / 16000;
        for (let i = 0; i < downsampledLength; i++) {
          downsampledData[i] = inputData[Math.floor(i * step)];
        }
        
        // Convert Float32Array to Int16Array for proper PCM format
        const pcmData = new Int16Array(downsampledData.length);
        for (let i = 0; i < downsampledData.length; i++) {
          pcmData[i] = Math.max(-32768, Math.min(32767, Math.floor(downsampledData[i] * 32768)));
        }
        
        try {
          await sendAudioChunk(pcmData.buffer);
        } catch (error) {
          console.error('Error sending audio chunk:', error);
          addLog('error', `Error sending audio chunk: ${error}`);
        }
      }
    };

    source.connect(processor);
    processor.connect(audioContextRef.current.destination);
    addLog('info', 'Started audio processing');
  }, [isConnected, sendAudioChunk, addLog]);

  const handleStartClick = useCallback(async () => {
    try {
      if (isConnected) {
        await disconnect();
        setActiveButton(null);
        addLog('info', 'Disconnected from Gemini API');
      } else {
        setActiveButton('connecting');
        await connect();
        setActiveButton('connected');
        addLog('info', 'Connected to Gemini API');
      }
    } catch (error) {
      console.error('Error with Gemini connection:', error);
      addLog('error', `Connection error: ${error}`);
      setActiveButton(null);
    }
  }, [isConnected, connect, disconnect, addLog]);

  const handleMicrophoneClick = useCallback(async () => {
    try {
      if (activeButton === 'microphone') {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          setStream(null);
        }
        if (processorNodeRef.current) {
          processorNodeRef.current.disconnect();
          processorNodeRef.current = null;
        }
        setActiveButton(null);
        addLog('info', 'Microphone disabled');
      } else {
        const audioStream = await navigator.mediaDevices.getUserMedia({ 
          audio: true  // Use default settings, we'll downsample in processing
        });
        setStream(audioStream);
        startAudioProcessing(audioStream);
        setActiveButton('microphone');
        addLog('info', 'Microphone enabled');
      }
    } catch (error) {
      console.error('Error accessing microphone:', error);
      addLog('error', `Microphone error: ${error}`);
    }
  }, [activeButton, stream, startAudioProcessing, addLog]);

  const handleScreenshareClick = useCallback(async () => {
    try {
      if (activeButton === 'screenshare') {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          setStream(null);
        }
        setActiveButton(null);
      } else {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        setStream(displayStream);
        setActiveButton('screenshare');
      }
    } catch (error) {
      console.error('Error sharing screen:', error);
    }
  }, [activeButton, stream]);

  const handleWebcamClick = useCallback(async () => {
    try {
      if (activeButton === 'webcam') {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          setStream(null);
        }
        setActiveButton(null);
      } else {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        setStream(videoStream);
        setActiveButton('webcam');
      }
    } catch (error) {
      console.error('Error accessing webcam:', error);
    }
  }, [activeButton, stream]);

  // Listen for Gemini events
  useEffect(() => {
    const handleGeminiText = (text: string) => {
      addLog('gemini', `Response: ${text}`);
    };

    const handleGeminiAudio = () => {
      addLog('gemini', 'Received audio response');
    };

    const handleGeminiError = (error: string) => {
      addLog('error', `Gemini error: ${error}`);
    };

    const handleGeminiStatus = (status: string) => {
      addLog('info', `Gemini status: ${status}`);
    };

    geminiEvents.on('text', handleGeminiText);
    geminiEvents.on('audio', handleGeminiAudio);
    geminiEvents.on('error', handleGeminiError);
    geminiEvents.on('status', handleGeminiStatus);

    return () => {
      geminiEvents.off('text', handleGeminiText);
      geminiEvents.off('audio', handleGeminiAudio);
      geminiEvents.off('error', handleGeminiError);
      geminiEvents.off('status', handleGeminiStatus);
    };
  }, [addLog]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    
    const startX = e.pageX;
    const startY = e.pageY;
    const startWidth = panelSize.width;
    const startHeight = panelSize.height;
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const newWidth = Math.max(400, startWidth + (e.pageX - startX));
      const newHeight = Math.max(400, startHeight + (e.pageY - startY));
      
      setPanelSize({ width: newWidth, height: newHeight });
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [isResizing, panelSize]);

  return (
    <>
      <DraggablePanel
        nodeRef={panelRef}
        position={position}
        onStart={handleDragStart}
        onDrag={handleDrag}
        onStop={handleDragStop}
        handle=".handle"
        disabled={isResizing || isTransitioning}
        scale={1}
        positionOffset={{ x: 0, y: 0 }}
      >
        <div 
          ref={panelRef}
          className={cn(
            "absolute bg-white dark:bg-[#1b2237] rounded-lg shadow-lg border border-[#e4e7ec] dark:border-[#2D3848] p-3",
            "transition-all duration-300 ease-out will-change-transform",
            isDragging && "cursor-grabbing shadow-2xl scale-[1.02] border-[#4cedff]/50",
            isLogExpanded ? "shadow-lg" : "shadow-md",
            isTransitioning && "pointer-events-none"
          )}
          style={{
            width: `${panelSize.width}px`,
            height: `${actualHeight}px`,
            zIndex: 9999,
            touchAction: 'none',
            transform: `translate3d(0,0,0) scale(${isDragging ? 1.02 : 1})`,
            transition: isDragging 
              ? 'none' 
              : 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            willChange: 'transform, height, box-shadow',
          }}
        >
          <div 
            className={cn(
              "handle select-none flex items-center justify-between mb-2 px-2 py-1 rounded-md",
              "transition-all duration-150 ease-in-out",
              isDragging 
                ? "cursor-grabbing bg-gray-100 dark:bg-[#2D3848]/50 shadow-inner" 
                : "cursor-grab hover:bg-gray-50 dark:hover:bg-[#2D3848]/30"
            )}
            style={{
              transform: isDragging ? 'scale(0.98)' : 'scale(1)',
            }}
          >
            <div className="flex items-center gap-2">
              <div className={cn(
                "w-2 h-2 rounded-full transition-all duration-300",
                isConnecting && "animate-pulse",
                isConnecting ? "bg-yellow-400" :
                isConnected ? "bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.5)]" : 
                "bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.5)]"
              )} />
              <span className={cn(
                "text-xs transition-colors duration-200",
                isConnecting ? "text-yellow-400/80" :
                isConnected ? "text-green-400/80" : "text-red-400/80"
              )}>
                {isConnecting ? "Connecting..." :
                 isConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
            {/* {onClose && (
              <button
                onClick={onClose}
                className={cn(
                  "p-1 rounded hover:bg-gray-100 dark:hover:bg-[#374357] text-gray-500 dark:text-foreground/60",
                  "transition-colors duration-150 ease-in-out"
                )}
                title="Close Panel"
              >
                <X className="h-4 w-4" />
              </button>
            )} */}
          </div>

          <div className="flex justify-center gap-2 mb-2">
            <button
              onClick={handleStartClick}
              className={cn(
                "p-2 rounded-lg transition-all duration-200",
                "transform hover:scale-105 active:scale-95",
                "focus:outline-none focus:ring-2 focus:ring-[#4cedff]/50",
                "bg-gray-50 dark:bg-[#2D3848] hover:bg-gray-100 dark:hover:bg-[#374357]",
                "relative overflow-hidden",
                (isConnected || activeButton === 'connected') 
                  ? "text-[#4cedff] shadow-[0_0_15px_rgba(76,237,255,0.4)]" 
                  : "text-gray-500 dark:text-foreground/80"
              )}
              title={isConnected ? "Disconnect from Gemini API" : "Connect to Gemini API"}
            >
              <div className={cn(
                "absolute inset-0 bg-[#4cedff]/10",
                "transition-transform duration-300",
                (isConnected || activeButton === 'connected') ? "scale-100" : "scale-0"
              )} />
              {(isConnected || activeButton === 'connected') ? (
                <Pause className="h-5 w-5 relative z-10" />
              ) : (
                <Play className="h-5 w-5 relative z-10" />
              )}
            </button>

            <button
              onClick={handleMicrophoneClick}
              className={cn(
                "p-2 rounded-lg transition-all duration-200",
                "transform hover:scale-105 active:scale-95",
                "focus:outline-none focus:ring-2 focus:ring-[#4cedff]/50",
                "bg-gray-50 dark:bg-[#2D3848] hover:bg-gray-100 dark:hover:bg-[#374357]",
                "relative overflow-hidden",
                activeButton === 'microphone' 
                  ? "text-[#4cedff] shadow-[0_0_15px_rgba(76,237,255,0.4)]" 
                  : "text-gray-500 dark:text-foreground/80"
              )}
              title="Toggle Microphone"
            >
              <div className={cn(
                "absolute inset-0 bg-[#4cedff]/10",
                "transition-transform duration-300",
                activeButton === 'microphone' ? "scale-100" : "scale-0"
              )} />
              <Mic className="h-5 w-5 relative z-10" />
            </button>

            <button
              onClick={handleScreenshareClick}
              className={cn(
                "p-2 rounded-lg transition-all duration-200",
                "transform hover:scale-105 active:scale-95",
                "focus:outline-none focus:ring-2 focus:ring-[#4cedff]/50",
                "bg-gray-50 dark:bg-[#2D3848] hover:bg-gray-100 dark:hover:bg-[#374357]",
                "relative overflow-hidden",
                activeButton === 'screenshare' 
                  ? "text-[#4cedff] shadow-[0_0_15px_rgba(76,237,255,0.4)]" 
                  : "text-gray-500 dark:text-foreground/80"
              )}
              title="Share Screen"
            >
              <div className={cn(
                "absolute inset-0 bg-[#4cedff]/10",
                "transition-transform duration-300",
                activeButton === 'screenshare' ? "scale-100" : "scale-0"
              )} />
              <Monitor className="h-5 w-5 relative z-10" />
            </button>

            <button
              onClick={handleWebcamClick}
              className={cn(
                "p-2 rounded-lg transition-all duration-200",
                "transform hover:scale-105 active:scale-95",
                "focus:outline-none focus:ring-2 focus:ring-[#4cedff]/50",
                "bg-gray-50 dark:bg-[#2D3848] hover:bg-gray-100 dark:hover:bg-[#374357]",
                "relative overflow-hidden",
                activeButton === 'webcam' 
                  ? "text-[#4cedff] shadow-[0_0_15px_rgba(76,237,255,0.4)]" 
                  : "text-gray-500 dark:text-foreground/80"
              )}
              title="Toggle Webcam"
            >
              <div className={cn(
                "absolute inset-0 bg-[#4cedff]/10",
                "transition-transform duration-300",
                activeButton === 'webcam' ? "scale-100" : "scale-0"
              )} />
              <Video className="h-5 w-5 relative z-10" />
            </button>
          </div>

          <div className={cn(
            "transition-all duration-300 ease-in-out",
            "overflow-hidden flex flex-col",
            isLogExpanded ? "h-[calc(100%-100px)]" : "h-[32px]"
          )}>
            <div 
              className={cn(
                "flex items-center justify-between",
                "cursor-pointer rounded-md px-2 py-1",
                "transition-colors duration-150 ease-in-out",
                "hover:bg-gray-50 dark:hover:bg-[#2D3848]"
              )}
              onClick={() => setIsLogExpanded(!isLogExpanded)}
            >
              <span className="text-xs font-medium text-gray-500 dark:text-foreground/60">Event Log</span>
              <div className="flex items-center gap-2">
                {isLogExpanded && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        clearLogs();
                      }}
                      className={cn(
                        "p-1 rounded-md",
                        "transition-all duration-150 ease-in-out",
                        "hover:bg-gray-100 dark:hover:bg-[#374357] hover:text-[#4cedff]",
                        "active:scale-95",
                        "text-gray-400 dark:text-foreground/60"
                      )}
                      title="Clear logs"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsLogMaximized(!isLogMaximized);
                      }}
                      className={cn(
                        "p-1 rounded-md",
                        "transition-all duration-150 ease-in-out",
                        "hover:bg-gray-100 dark:hover:bg-[#374357] hover:text-[#4cedff]",
                        "active:scale-95",
                        "text-gray-400 dark:text-foreground/60"
                      )}
                      title={isLogMaximized ? "Minimize" : "Maximize"}
                    >
                      <Maximize2 className="h-3 w-3" />
                    </button>
                  </>
                )}
                <div className={cn(
                  "transition-transform duration-200",
                  isLogExpanded ? "rotate-0" : "-rotate-90"
                )}>
                  {isLogExpanded ? (
                    <ChevronUp className="h-3 w-3 text-gray-400 dark:text-foreground/60" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-gray-400 dark:text-foreground/60" />
                  )}
                </div>
              </div>
            </div>
            <div 
              ref={logContainerRef}
              className={cn(
                "bg-gray-50 dark:bg-[#161d2f] rounded-md p-2 text-xs font-mono",
                "transition-all duration-300 ease-in-out",
                "scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-[#2D3848] scrollbar-track-transparent",
                isLogExpanded ? "flex-1 opacity-100 mt-1" : "h-0 opacity-0 mt-0"
              )}
            >
              {logs.map((log, index) => (
                <div 
                  key={index}
                  className={cn(
                    "py-1 transition-opacity duration-150",
                    "animate-in fade-in slide-in-from-bottom-1",
                    log.type === 'error' && "text-red-400",
                    log.type === 'api' && "text-blue-400",
                    log.type === 'gemini' && "text-[#4cedff]",
                    log.type === 'info' && "text-gray-500 dark:text-foreground/60"
                  )}
                >
                  <span className="opacity-50">[{log.timestamp.toLocaleTimeString()}]</span>{' '}
                  {log.message}
                </div>
              ))}
            </div>
          </div>

          {/* Resize handle - only show when expanded */}
          {isLogExpanded && (
            <div
              ref={resizeRef}
              className={cn(
                "absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-50",
                "transition-all duration-150 ease-in-out",
                isResizing && "scale-110",
                "hover:opacity-80"
              )}
              // onMouseDown={handleResizeStart}
              // style={{
              //   background: 'linear-gradient(135deg, transparent 50%, #4cedff 50%)',
              //   borderBottomRightRadius: '0.5rem',
              //   boxShadow: isResizing ? '0 0 10px rgba(76,237,255,0.4)' : 'none',
              // }}
            />
          )}
        </div>
      </DraggablePanel>

      {/* Maximized Event Log Modal */}
      {isLogMaximized && (
        <div 
          className={cn(
            "fixed inset-0 bg-black/50 z-[9999]",
            "flex items-center justify-center",
            "animate-in fade-in duration-200"
          )}
        >
          <div 
            className={cn(
              "bg-white dark:bg-[#1b2237] rounded-lg shadow-lg",
              "border border-[#e4e7ec] dark:border-[#2D3848] p-4",
              "w-[800px] h-[600px] flex flex-col",
              "animate-in zoom-in-95 duration-200",
              "shadow-[0_0_30px_rgba(0,0,0,0.3)]"
            )}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium flex items-center gap-2">
                Event Log
                <div className={cn(
                  "px-2 py-0.5 rounded-full text-xs",
                  "bg-gray-100 dark:bg-[#2D3848] text-gray-500 dark:text-foreground/60"
                )}>
                  {logs.length} entries
                </div>
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => clearLogs()}
                  className={cn(
                    "p-1.5 rounded-md",
                    "transition-all duration-150 ease-in-out",
                    "hover:bg-gray-100 dark:hover:bg-[#374357] hover:text-[#4cedff]",
                    "active:scale-95",
                    "text-gray-500 dark:text-foreground/60"
                  )}
                  title="Clear logs"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setIsLogMaximized(false)}
                  className={cn(
                    "p-1.5 rounded-md",
                    "transition-all duration-150 ease-in-out",
                    "hover:bg-gray-100 dark:hover:bg-[#374357] hover:text-[#4cedff]",
                    "active:scale-95",
                    "text-gray-500 dark:text-foreground/60"
                  )}
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div 
              className={cn(
                "flex-1 bg-gray-50 dark:bg-[#161d2f] rounded-md p-4",
                "overflow-y-auto text-sm font-mono",
                "scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-[#2D3848] scrollbar-track-transparent"
              )}
            >
              {logs.map((log, index) => (
                <div 
                  key={index}
                  className={cn(
                    "py-1.5 transition-opacity duration-150",
                    "animate-in fade-in slide-in-from-bottom-1",
                    log.type === 'error' && "text-red-400",
                    log.type === 'api' && "text-blue-400",
                    log.type === 'gemini' && "text-[#4cedff]",
                    log.type === 'info' && "text-gray-500 dark:text-foreground/60"
                  )}
                >
                  <span className="opacity-50 mr-2">[{log.timestamp.toLocaleTimeString()}]</span>
                  <span>{log.message}</span>
                </div>
              ))}
              {logs.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-foreground/40">
                  <span className="text-lg mb-2">No logs yet</span>
                  <span className="text-sm">Events will appear here</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
