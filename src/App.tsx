/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { Camera, RefreshCw, Target, Fish, Loader2, AlertCircle, Settings, X, Check, Radio, Play, Square } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Types for detection results
interface Detection {
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  label: string;
}

interface DetectionResponse {
  detections: Detection[];
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [isLive, setIsLive] = useState(false);
  const [highAccuracy, setHighAccuracy] = useState(false);
  const liveLoopRef = useRef<number | null>(null);

  // Initialize WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('Connected to WebSocket server');
      setWsStatus('connected');
    };

    socket.onclose = () => {
      console.log('Disconnected from WebSocket server');
      setWsStatus('disconnected');
      // Attempt to reconnect after 3 seconds
      setTimeout(() => {
        setWsStatus('connecting');
      }, 3000);
    };

    socket.onerror = (err) => {
      console.error('WebSocket error:', err);
      setWsStatus('disconnected');
    };

    setWs(socket);

    return () => {
      socket.close();
    };
  }, [wsStatus === 'connecting' ? 1 : 0]); // Re-run effect when status changes to connecting

  // Enumerate devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        // Request permission first to get labels
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devs = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devs.filter(d => d.kind === 'videoinput');
        setDevices(videoDevices);
        if (videoDevices.length > 0 && !selectedDeviceId) {
          const envDevice = videoDevices.find(d => d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('environment'));
          setSelectedDeviceId(envDevice?.deviceId || videoDevices[0].deviceId);
        }
      } catch (err) {
        console.error("Error enumerating devices:", err);
      }
    };
    getDevices();
  }, []);

  // Initialize Camera
  const startCamera = useCallback(async (deviceId?: string) => {
    try {
      setError(null);
      
      // Stop existing tracks
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }

      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraReady(true);
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Could not access camera. Please ensure you have granted permissions.");
    }
  }, []);

  useEffect(() => {
    startCamera(selectedDeviceId);
    return () => {
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedDeviceId, startCamera]);

  const detectFish = async (continuous = false) => {
    if (!videoRef.current || !canvasRef.current) return;

    if (!continuous) setIsDetecting(true);
    setError(null);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      // Use video dimensions
      const width = video.videoWidth;
      const height = video.videoHeight;
      
      if (width === 0 || height === 0) return;

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Could not get canvas context");

      // Draw current frame to canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Increase quality for better detection of small/blurry fish
      const base64Image = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
      
      // Only set captured image if not in live mode
      if (!continuous) {
        setCapturedImage(canvas.toDataURL('image/jpeg'));
      }

      // Initialize Gemini
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      
      const modelName = highAccuracy ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            parts: [
              { text: "Locate every single fish in this image. Be extremely thorough. Detect all fish regardless of their species, size, color, or orientation. Do not categorize them, just identify them as 'fish'. Return bounding boxes in [ymin, xmin, ymax, xmax] format where values are 0-1000. Output strictly in JSON format." },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    box_2d: {
                      type: Type.ARRAY,
                      items: { type: Type.NUMBER },
                      description: "[ymin, xmin, ymax, xmax]"
                    },
                    label: { type: Type.STRING }
                  },
                  required: ["box_2d", "label"]
                }
              }
            },
            required: ["detections"]
          }
        }
      });

      const result = JSON.parse(response.text || '{"detections": []}') as DetectionResponse;
      setDetections(result.detections);
      
      // Send to WebSocket
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'FISH_DETECTION',
          timestamp: Date.now(),
          detections: result.detections,
          imageWidth: width,
          imageHeight: height,
          isLive: continuous
        }));
      }
      
      if (!continuous && result.detections.length === 0) {
        setError("No fish detected in this frame. Try another angle!");
      }

    } catch (err) {
      console.error("Detection error:", err);
      if (!continuous) setError("Failed to detect fish. Please try again.");
    } finally {
      if (!continuous) setIsDetecting(false);
    }
  };

  // Live Detection Loop
  useEffect(() => {
    let active = true;
    
    const loop = async () => {
      if (!isLive || !active) return;
      await detectFish(true);
      if (active && isLive) {
        // Small delay to avoid rate limits and allow UI to breathe
        setTimeout(loop, 200);
      }
    };

    if (isLive) {
      loop();
    }

    return () => {
      active = false;
    };
  }, [isLive]);

  const toggleLive = () => {
    setIsLive(!isLive);
    if (!isLive) {
      reset();
    }
  };

  const reset = () => {
    setCapturedImage(null);
    setDetections([]);
    setError(null);
    setIsLive(false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="p-6 flex items-center justify-between border-b border-white/5 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500/10 rounded-lg">
            <Fish className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Fish Detector AI</h1>
            <p className="text-xs text-zinc-500 font-mono uppercase tracking-widest">Real-time Vision</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800/50 rounded-full border border-white/5">
            <div className={`w-2 h-2 rounded-full ${
              wsStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : 
              wsStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'
            }`} />
            <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
              WS: {wsStatus}
            </span>
          </div>
          <div className="flex items-center gap-2">
          {devices.length > 1 && (
            <button 
              onClick={() => setIsModalOpen(true)}
              className="p-2 hover:bg-white/5 rounded-full transition-colors text-zinc-400"
              title="Camera Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          )}
          <button 
            onClick={() => startCamera(selectedDeviceId)}
            className="p-2 hover:bg-white/5 rounded-full transition-colors text-zinc-400"
            title="Refresh Camera"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Viewport - Takes 3 columns on large screens */}
          <div className="lg:col-span-3 space-y-6">
            <div className="relative aspect-video bg-zinc-900 rounded-2xl overflow-hidden border border-white/10 shadow-2xl group">
          {!capturedImage ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-contain transition-opacity duration-700 ${isCameraReady ? 'opacity-100' : 'opacity-0'}`}
            />
          ) : (
            <img 
              src={capturedImage} 
              alt="Captured" 
              className="w-full h-full object-contain"
              referrerPolicy="no-referrer"
            />
          )}

          {/* Scanning Animation */}
          {(isDetecting || isLive) && (
            <motion.div 
              initial={{ top: '0%' }}
              animate={{ top: '100%' }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className="absolute left-0 right-0 h-0.5 bg-emerald-400/50 shadow-[0_0_15px_rgba(52,211,153,0.5)] z-20 pointer-events-none"
            />
          )}

          {/* Overlay Detections */}
          <AnimatePresence>
            {detections.map((det, idx) => {
              const [ymin, xmin, ymax, xmax] = det.box_2d;
              return (
                <motion.div
                  key={`${idx}-${ymin}-${xmin}`}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute border-2 border-emerald-400 bg-emerald-400/5 rounded-lg pointer-events-none z-10 shadow-[0_0_10px_rgba(52,211,153,0.3)]"
                  style={{
                    top: `${ymin / 10}%`,
                    left: `${xmin / 10}%`,
                    width: `${(xmax - xmin) / 10}%`,
                    height: `${(ymax - ymin) / 10}%`,
                  }}
                >
                  {/* Corner Accents */}
                  <div className="absolute -top-1 -left-1 w-3 h-3 border-t-2 border-l-2 border-emerald-400" />
                  <div className="absolute -top-1 -right-1 w-3 h-3 border-t-2 border-r-2 border-emerald-400" />
                  <div className="absolute -bottom-1 -left-1 w-3 h-3 border-b-2 border-l-2 border-emerald-400" />
                  <div className="absolute -bottom-1 -right-1 w-3 h-3 border-b-2 border-r-2 border-emerald-400" />
                  
                  <div className="absolute -top-7 left-0 bg-emerald-500 text-zinc-950 text-[10px] font-black px-2 py-0.5 rounded shadow-lg uppercase tracking-wider whitespace-nowrap flex flex-col gap-0">
                    <div className="flex items-center gap-1">
                      <Target className="w-3 h-3" />
                      FISH DETECTED
                    </div>
                    <div className="text-[8px] opacity-80 font-mono">
                      X:{Math.round((xmin + xmax) / 2)} Y:{Math.round((ymin + ymax) / 2)}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* Loading State */}
          {isDetecting && (
            <div className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
              <Loader2 className="w-10 h-10 text-emerald-400 animate-spin mb-4" />
              <p className="text-emerald-400 font-mono text-sm animate-pulse">ANALYZING AQUATIC LIFE...</p>
            </div>
          )}

          {/* Initial State / Error */}
          {!isCameraReady && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <Camera className="w-12 h-12 text-zinc-700 animate-pulse" />
              <p className="text-zinc-500 font-mono text-xs">INITIALIZING SENSORS...</p>
            </div>
          )}
        </div>

          {/* Detection Status Panel */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-4 flex items-center gap-4">
              <div className={`p-3 rounded-lg ${detections.length > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
                <Fish className="w-6 h-6" />
              </div>
              <div>
                <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Targets Found</p>
                <p className="text-2xl font-bold text-zinc-100">{detections.length}</p>
              </div>
            </div>
            
            <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-4 flex items-center gap-4">
              <div className={`p-3 rounded-lg ${isLive ? 'bg-red-500/20 text-red-400' : 'bg-zinc-800 text-zinc-500'}`}>
                <Radio className={`w-6 h-6 ${isLive ? 'animate-pulse' : ''}`} />
              </div>
              <div>
                <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">System Mode</p>
                <p className="text-lg font-bold text-zinc-100 uppercase">{isLive ? 'Live Tracking' : 'Standby'}</p>
              </div>
            </div>

            <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-4 flex items-center gap-4">
              <div className={`p-3 rounded-lg ${wsStatus === 'connected' ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-800 text-zinc-500'}`}>
                <RefreshCw className={`w-6 h-6 ${wsStatus === 'connecting' ? 'animate-spin' : ''}`} />
              </div>
              <div>
                <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Data Stream</p>
                <p className="text-lg font-bold text-zinc-100 uppercase">{wsStatus}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar - Live Data Feed */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5 h-full flex flex-col shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                <Target className="w-4 h-4 text-emerald-400" />
                Live Data Feed
              </h2>
              {isLive && <span className="flex h-2 w-2 rounded-full bg-red-500 animate-pulse" />}
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2">
              {detections.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-4 opacity-30">
                  <Fish className="w-8 h-8 mb-2" />
                  <p className="text-[10px] font-mono uppercase">No active targets</p>
                </div>
              ) : (
                detections.map((det, i) => {
                  const [ymin, xmin, ymax, xmax] = det.box_2d;
                  const centerX = Math.round((xmin + xmax) / 2);
                  const centerY = Math.round((ymin + ymax) / 2);
                  return (
                    <motion.div 
                      key={i}
                      initial={{ x: 20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      className="p-3 bg-zinc-800/50 border border-white/5 rounded-lg hover:border-emerald-500/30 transition-colors"
                    >
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-black text-emerald-400">TARGET #{i + 1}</span>
                        <span className="text-[8px] font-mono text-zinc-500">FISH</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                        <div className="bg-zinc-950 p-1.5 rounded">
                          <span className="text-zinc-500 mr-1">X:</span>
                          <span className="text-zinc-100">{centerX}</span>
                        </div>
                        <div className="bg-zinc-950 p-1.5 rounded">
                          <span className="text-zinc-500 mr-1">Y:</span>
                          <span className="text-zinc-100">{centerY}</span>
                        </div>
                        <div className="bg-zinc-950 p-1.5 rounded">
                          <span className="text-zinc-500 mr-1">W:</span>
                          <span className="text-zinc-100">{xmax - xmin}</span>
                        </div>
                        <div className="bg-zinc-950 p-1.5 rounded">
                          <span className="text-zinc-500 mr-1">H:</span>
                          <span className="text-zinc-100">{ymax - ymin}</span>
                        </div>
                      </div>
                    </motion.div>
                  );
                })
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-white/5">
              <p className="text-[9px] text-zinc-600 font-mono leading-relaxed">
                Coordinates are normalized (0-1000). Data is broadcasted via WebSocket in real-time.
              </p>
            </div>
          </div>
        </div>
      </div>

        {/* Controls */}
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-wrap justify-center gap-4">
            <button
              onClick={toggleLive}
              disabled={!isCameraReady}
              className={`px-8 py-4 font-bold rounded-xl transition-all active:scale-95 flex items-center gap-3 shadow-lg ${
                isLive 
                  ? 'bg-red-500 hover:bg-red-400 text-white shadow-red-500/20' 
                  : 'bg-zinc-800 hover:bg-zinc-700 text-emerald-400 border border-emerald-500/20 shadow-emerald-500/10'
              }`}
            >
              {isLive ? <Square className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
              <span>{isLive ? 'STOP LIVE TRACKING' : 'START LIVE TRACKING'}</span>
            </button>

            {!isLive && (
              <>
                <button
                  onClick={() => setHighAccuracy(!highAccuracy)}
                  className={`px-4 py-4 font-bold rounded-xl transition-all border ${
                    highAccuracy 
                      ? 'bg-amber-500/10 border-amber-500/50 text-amber-400' 
                      : 'bg-zinc-800/50 border-white/5 text-zinc-400'
                  }`}
                  title={highAccuracy ? "Using Pro model (Slower, More Accurate)" : "Using Flash model (Faster)"}
                >
                  {highAccuracy ? 'HIGH ACCURACY: ON' : 'HIGH ACCURACY: OFF'}
                </button>
                {!capturedImage ? (
                  <button
                    onClick={() => detectFish(false)}
                    disabled={!isCameraReady || isDetecting}
                    className="group relative px-8 py-4 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-bold rounded-xl transition-all active:scale-95 flex items-center gap-3 shadow-[0_0_20px_rgba(16,185,129,0.3)]"
                  >
                    <Target className={`w-5 h-5 ${isDetecting ? 'animate-ping' : ''}`} />
                    <span>SINGLE SCAN</span>
                  </button>
                ) : (
                  <button
                    onClick={reset}
                    className="px-8 py-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-bold rounded-xl transition-all active:scale-95 flex items-center gap-3"
                  >
                    <RefreshCw className="w-5 h-5" />
                    <span>RESET VIEW</span>
                  </button>
                )}
              </>
            )}
          </div>

          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 text-red-400 bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20"
            >
              <AlertCircle className="w-4 h-4" />
              <span className="text-sm font-medium">{error}</span>
            </motion.div>
          )}
        </div>

        {/* Info Section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-8 border-t border-white/5">
          <div className="p-4 bg-zinc-900/30 rounded-xl border border-white/5">
            <h3 className="text-zinc-400 text-[10px] font-bold uppercase tracking-widest mb-2">Detection Engine</h3>
            <p className="text-sm text-zinc-300">Powered by Gemini 3 Flash for rapid object localization and classification.</p>
          </div>
          <div className="p-4 bg-zinc-900/30 rounded-xl border border-white/5">
            <h3 className="text-zinc-400 text-[10px] font-bold uppercase tracking-widest mb-2">Instructions</h3>
            <p className="text-sm text-zinc-300">Point your camera at an aquarium or fish pond and press detect to find aquatic species.</p>
          </div>
          <div className="p-4 bg-zinc-900/30 rounded-xl border border-white/5">
            <h3 className="text-zinc-400 text-[10px] font-bold uppercase tracking-widest mb-2">Privacy</h3>
            <p className="text-sm text-zinc-300">Images are processed securely via AI and are not stored permanently on our servers.</p>
          </div>
        </div>
      </main>

      {/* Camera Selection Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsModalOpen(false)}
              className="absolute inset-0 bg-zinc-950/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Select Camera</h2>
                <button 
                  onClick={() => setIsModalOpen(false)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-zinc-500" />
                </button>
              </div>
              <div className="p-4 max-h-[60vh] overflow-y-auto">
                <div className="space-y-2">
                  {devices.map((device) => (
                    <button
                      key={device.deviceId}
                      onClick={() => {
                        setSelectedDeviceId(device.deviceId);
                        setIsModalOpen(false);
                      }}
                      className={`w-full flex items-center justify-between p-4 rounded-xl border transition-all ${
                        selectedDeviceId === device.deviceId
                          ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400'
                          : 'bg-white/5 border-transparent hover:border-white/10 text-zinc-400'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Camera className="w-5 h-5" />
                        <span className="text-sm font-medium">
                          {device.label || `Camera ${device.deviceId.slice(0, 4)}`}
                        </span>
                      </div>
                      {selectedDeviceId === device.deviceId && (
                        <Check className="w-5 h-5" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-6 bg-zinc-950/50 border-t border-white/5">
                <p className="text-[10px] text-zinc-500 uppercase tracking-widest text-center">
                  {devices.length} Devices Available
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Hidden Canvas for processing */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
