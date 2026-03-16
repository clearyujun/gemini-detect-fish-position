/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { Camera, RefreshCw, Target, Fish, Loader2, AlertCircle, Settings, X, Check } from 'lucide-react';
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

  const detectFish = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsDetecting(true);
    setError(null);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Could not get canvas context");

      // Draw current frame to canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      setCapturedImage(canvas.toDataURL('image/jpeg'));

      // Initialize Gemini
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: "Detect all fish in this image. Return the bounding boxes in [ymin, xmin, ymax, xmax] format where values are 0-1000. Return as JSON." },
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
      
      if (result.detections.length === 0) {
        setError("No fish detected in this frame. Try another angle!");
      }

    } catch (err) {
      console.error("Detection error:", err);
      setError("Failed to detect fish. Please try again.");
    } finally {
      setIsDetecting(false);
    }
  };

  const reset = () => {
    setCapturedImage(null);
    setDetections([]);
    setError(null);
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
      </header>

      <main className="max-w-4xl mx-auto p-6 space-y-8">
        {/* Viewport */}
        <div className="relative aspect-video bg-zinc-900 rounded-2xl overflow-hidden border border-white/10 shadow-2xl group">
          {!capturedImage ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover transition-opacity duration-700 ${isCameraReady ? 'opacity-100' : 'opacity-0'}`}
            />
          ) : (
            <img 
              src={capturedImage} 
              alt="Captured" 
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          )}

          {/* Overlay Detections */}
          <AnimatePresence>
            {detections.map((det, idx) => {
              const [ymin, xmin, ymax, xmax] = det.box_2d;
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute border-2 border-emerald-400 bg-emerald-400/10 rounded-sm pointer-events-none z-10"
                  style={{
                    top: `${ymin / 10}%`,
                    left: `${xmin / 10}%`,
                    width: `${(xmax - xmin) / 10}%`,
                    height: `${(ymax - ymin) / 10}%`,
                  }}
                >
                  <div className="absolute -top-6 left-0 bg-emerald-400 text-zinc-950 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-tighter whitespace-nowrap">
                    {det.label}
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

        {/* Controls */}
        <div className="flex flex-col items-center gap-6">
          <div className="flex gap-4">
            {!capturedImage ? (
              <button
                onClick={detectFish}
                disabled={!isCameraReady || isDetecting}
                className="group relative px-8 py-4 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-bold rounded-xl transition-all active:scale-95 flex items-center gap-3 shadow-[0_0_20px_rgba(16,185,129,0.3)]"
              >
                <Target className={`w-5 h-5 ${isDetecting ? 'animate-ping' : ''}`} />
                <span>DETECT FISH</span>
              </button>
            ) : (
              <button
                onClick={reset}
                className="px-8 py-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-bold rounded-xl transition-all active:scale-95 flex items-center gap-3"
              >
                <RefreshCw className="w-5 h-5" />
                <span>NEW SCAN</span>
              </button>
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
