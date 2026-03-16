import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Camera, Target, Loader2, Settings, X, Check, Play, Square, Activity, Crosshair, Zap, Palette, Maximize2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Point {
  x: number;
  y: number;
}

interface BBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Detection State
  const [targetPos, setTargetPos] = useState<Point | null>(null);
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [fps, setFps] = useState(0);

  // Color & Size Settings
  const [targetColor, setTargetColor] = useState<RGB>({ r: 239, g: 68, b: 68 }); // Default Red
  const [hexColor, setHexColor] = useState('#ef4444');
  const [tolerance, setTolerance] = useState(50); 
  const [minArea, setMinArea] = useState(20); // Minimum pixels to count as an object
  
  const [videoLayout, setVideoLayout] = useState({ width: 0, height: 0, left: 0, top: 0 });
  const requestRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Helper: Hex to RGB
  const hexToRgb = (hex: string): RGB => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  };

  const handleColorChange = (hex: string) => {
    setHexColor(hex);
    setTargetColor(hexToRgb(hex));
  };

  // Device Enumeration
  const refreshDevices = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devs.filter(d => d.kind === 'videoinput');
      setDevices(videoDevices);
      if (videoDevices.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(videoDevices[0].deviceId);
      }
    } catch (err) {
      console.error("Device list error:", err);
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  // Camera Control
  const startCamera = useCallback(async (deviceId?: string) => {
    try {
      setIsCameraReady(false);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      }
      
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: deviceId } : { facingMode: 'environment' }
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          setIsCameraReady(true);
          setTimeout(updateVideoLayout, 100);
        };
      }
    } catch (err) {
      setError("Camera access denied.");
    }
  }, []);

  const updateVideoLayout = useCallback(() => {
    if (!videoRef.current || !containerRef.current) return;
    const video = videoRef.current;
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    if (video.videoWidth === 0) return;

    const videoRatio = video.videoWidth / video.videoHeight;
    const containerRatio = containerRect.width / containerRect.height;

    let actualWidth, actualHeight, left, top;
    if (containerRatio > videoRatio) {
      actualHeight = containerRect.height;
      actualWidth = actualHeight * videoRatio;
      top = 0;
      left = (containerRect.width - actualWidth) / 2;
    } else {
      actualWidth = containerRect.width;
      actualHeight = actualWidth / videoRatio;
      left = 0;
      top = (containerRect.height - actualHeight) / 2;
    }
    setVideoLayout({ width: actualWidth, height: actualHeight, left, top });
  }, []);

  useEffect(() => {
    startCamera(selectedDeviceId);
  }, [selectedDeviceId, startCamera]);

  useEffect(() => {
    window.addEventListener('resize', updateVideoLayout);
    return () => window.removeEventListener('resize', updateVideoLayout);
  }, [updateVideoLayout]);

  // Pixel Processing Loop
  const processFrame = useCallback((time: number) => {
    if (!videoRef.current || !canvasRef.current || !isLive) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) return;

    if (lastTimeRef.current) {
      const delta = time - lastTimeRef.current;
      setFps(Math.round(1000 / delta));
    }
    lastTimeRef.current = time;

    const scanWidth = 320;
    const scanHeight = Math.floor((video.videoHeight / video.videoWidth) * scanWidth);
    canvas.width = scanWidth;
    canvas.height = scanHeight;
    ctx.drawImage(video, 0, 0, scanWidth, scanHeight);

    const imageData = ctx.getImageData(0, 0, scanWidth, scanHeight);
    const data = imageData.data;

    let minX = scanWidth, minY = scanHeight, maxX = 0, maxY = 0;
    let found = false;
    let sumX = 0, sumY = 0, count = 0;

    for (let y = 0; y < scanHeight; y += 2) {
      for (let x = 0; x < scanWidth; x += 2) {
        const i = (y * scanWidth + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Color Matching Logic
        const dR = Math.abs(r - targetColor.r);
        const dG = Math.abs(g - targetColor.g);
        const dB = Math.abs(b - targetColor.b);

        if (dR < tolerance && dG < tolerance && dB < tolerance) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          
          sumX += x;
          sumY += y;
          count++;
          found = true;
        }
      }
    }

    if (found && count > minArea) {
      const centerX = sumX / count;
      const centerY = sumY / count;

      setTargetPos({
        x: (centerX / scanWidth) * 1000,
        y: (centerY / scanHeight) * 1000
      });

      setBbox({
        xmin: (minX / scanWidth) * 1000,
        ymin: (minY / scanHeight) * 1000,
        xmax: (maxX / scanWidth) * 1000,
        ymax: (maxY / scanHeight) * 1000
      });
    } else {
      setTargetPos(null);
      setBbox(null);
    }

    requestRef.current = requestAnimationFrame(processFrame);
  }, [isLive, targetColor, tolerance, minArea]);

  useEffect(() => {
    if (isLive) requestRef.current = requestAnimationFrame(processFrame);
    else if (requestRef.current) cancelAnimationFrame(requestRef.current);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [isLive, processFrame]);

  const presets = [
    { name: 'Red', hex: '#ef4444' },
    { name: 'Green', hex: '#22c55e' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Yellow', hex: '#eab308' },
    { name: 'Purple', hex: '#a855f7' },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-white/10">
      {/* Header */}
      <header className="p-4 flex items-center justify-between border-b border-white/5 bg-zinc-900/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg" style={{ backgroundColor: `${hexColor}20` }}>
            <Crosshair className="w-5 h-5" style={{ color: hexColor }} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Multi-Color Tracker</h1>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-zinc-500 font-mono uppercase tracking-widest">Pixel Analysis Engine</span>
              <span className="text-[9px] font-mono" style={{ color: hexColor }}>{fps} FPS</span>
            </div>
          </div>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)} 
          className="p-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-300 transition-all border border-white/5"
        >
          <Settings className="w-5 h-5" />
        </button>
      </header>

      <main className="max-w-6xl mx-auto p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Viewport */}
        <div className="lg:col-span-3 space-y-6">
          <div 
            ref={containerRef}
            className="relative aspect-video bg-black rounded-3xl overflow-hidden border border-white/10 shadow-2xl"
          >
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-contain" />
            <canvas ref={canvasRef} className="hidden" />

            {/* Tracking Overlay */}
            <div 
              className="absolute pointer-events-none z-10"
              style={{
                width: videoLayout.width,
                height: videoLayout.height,
                left: videoLayout.left,
                top: videoLayout.top
              }}
            >
              <AnimatePresence>
                {bbox && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute border-2 rounded-sm"
                    style={{
                      borderColor: hexColor,
                      backgroundColor: `${hexColor}10`,
                      boxShadow: `0 0 20px ${hexColor}40`,
                      top: `${bbox.ymin / 10}%`,
                      left: `${bbox.xmin / 10}%`,
                      width: `${(bbox.xmax - bbox.xmin) / 10}%`,
                      height: `${(bbox.ymax - bbox.ymin) / 10}%`,
                    }}
                  >
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                      <div className="w-4 h-0.5 absolute left-1/2 -translate-x-1/2" style={{ backgroundColor: hexColor }} />
                      <div className="h-4 w-0.5 absolute top-1/2 -translate-y-1/2" style={{ backgroundColor: hexColor }} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {targetPos && (
                <div 
                  className="absolute w-4 h-4 -ml-2 -mt-2 z-20"
                  style={{ left: `${targetPos.x / 10}%`, top: `${targetPos.y / 10}%` }}
                >
                  <div className="absolute inset-0 rounded-full animate-ping opacity-75" style={{ backgroundColor: hexColor }} />
                  <div className="absolute inset-1 bg-white rounded-full shadow-lg" />
                </div>
              )}
            </div>

            {/* Status Overlays */}
            {isLive && !targetPos && (
              <div className="absolute top-4 left-4 bg-zinc-900/80 px-3 py-1.5 rounded-full border border-white/10 flex items-center gap-2 z-20">
                <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: hexColor }} />
                <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest">Scanning for Target...</span>
              </div>
            )}
            
            {!isCameraReady && (
              <div className="absolute inset-0 bg-zinc-950 flex flex-col items-center justify-center z-20">
                <Loader2 className="w-10 h-10 animate-spin mb-4" style={{ color: hexColor }} />
                <p className="text-zinc-600 font-mono text-[10px] uppercase tracking-widest">Initializing Sensor...</p>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-3xl p-6 flex flex-col md:flex-row items-center justify-between gap-8">
            <button
              onClick={() => setIsLive(!isLive)}
              disabled={!isCameraReady}
              className={`w-full md:w-auto px-12 py-5 font-black rounded-2xl transition-all active:scale-95 flex items-center justify-center gap-3 shadow-2xl text-white`}
              style={{ backgroundColor: isLive ? '#4b5563' : hexColor, boxShadow: `0 10px 30px ${hexColor}30` }}
            >
              {isLive ? <Square className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
              <span className="text-lg tracking-tight">{isLive ? 'STOP TRACKING' : 'START TRACKING'}</span>
            </button>

            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-8 w-full">
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest">Color Tolerance</span>
                  <span className="text-[10px] font-mono" style={{ color: hexColor }}>{tolerance}</span>
                </div>
                <input 
                  type="range" min="10" max="150" step="1" 
                  value={tolerance} onChange={(e) => setTolerance(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: hexColor }}
                />
              </div>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest">Min Object Size</span>
                  <span className="text-[10px] font-mono" style={{ color: hexColor }}>{minArea}px</span>
                </div>
                <input 
                  type="range" min="1" max="500" step="1" 
                  value={minArea} onChange={(e) => setMinArea(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                  style={{ accentColor: hexColor }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <div className="bg-zinc-900 border border-white/10 rounded-3xl p-6 space-y-6 shadow-xl">
            {/* Color Palette */}
            <div>
              <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Palette className="w-3 h-3" />
                Target Color
              </h3>
              <div className="grid grid-cols-5 gap-2 mb-4">
                {presets.map(p => (
                  <button
                    key={p.hex}
                    onClick={() => handleColorChange(p.hex)}
                    className={`aspect-square rounded-lg border-2 transition-all ${hexColor === p.hex ? 'border-white scale-110 shadow-lg' : 'border-transparent opacity-60 hover:opacity-100'}`}
                    style={{ backgroundColor: p.hex }}
                    title={p.name}
                  />
                ))}
              </div>
              <div className="flex items-center gap-3 p-3 bg-zinc-950 rounded-xl border border-white/5">
                <input 
                  type="color" 
                  value={hexColor} 
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer bg-transparent border-none"
                />
                <span className="text-xs font-mono text-zinc-400 uppercase">{hexColor}</span>
              </div>
            </div>

            {/* Coordinates */}
            <div>
              <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Target className="w-3 h-3" />
                Live Coordinates
              </h3>
              
              <div className="space-y-4">
                <div className="p-4 bg-zinc-950 rounded-2xl border border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-2">Target Center</span>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-[9px] text-zinc-600 font-mono">X-AXIS</span>
                      <p className="text-xl font-mono font-bold" style={{ color: hexColor }}>{targetPos ? Math.round(targetPos.x) : '---'}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-[9px] text-zinc-600 font-mono">Y-AXIS</span>
                      <p className="text-xl font-mono font-bold" style={{ color: hexColor }}>{targetPos ? Math.round(targetPos.y) : '---'}</p>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-zinc-950 rounded-2xl border border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-2">Object Area</span>
                  <div className="flex items-center gap-2">
                    <Maximize2 className="w-3 h-3 text-zinc-600" />
                    <span className="text-sm font-mono text-zinc-300">{bbox ? Math.round((bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin) / 100) : '0'} units</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-white/5">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-3 h-3 text-amber-400" />
                <span className="text-[10px] font-bold text-amber-400 uppercase">Detection Info</span>
              </div>
              <p className="text-[10px] text-zinc-500 leading-relaxed">
                Tracking pixels matching <code className="px-1 bg-zinc-800 rounded" style={{ color: hexColor }}>{hexColor}</code>. <br/>
                Filtering objects smaller than <code className="text-zinc-300">{minArea}px</code>.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Camera Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsModalOpen(false)} className="absolute inset-0 bg-zinc-950/90 backdrop-blur-xl" />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }} 
              animate={{ opacity: 1, scale: 1, y: 0 }} 
              exit={{ opacity: 0, scale: 0.9, y: 20 }} 
              className="relative w-full max-w-md bg-zinc-900 border border-white/10 rounded-[2.5rem] p-8 shadow-2xl"
            >
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-2xl font-bold tracking-tight">Select Input</h2>
                <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-white/5 rounded-full"><X className="w-6 h-6 text-zinc-500" /></button>
              </div>
              <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                {devices.map((d) => (
                  <button 
                    key={d.deviceId} 
                    onClick={() => { setSelectedDeviceId(d.deviceId); setIsModalOpen(false); }} 
                    className={`w-full p-5 rounded-2xl border text-left transition-all flex items-center justify-between group ${selectedDeviceId === d.deviceId ? 'bg-white/5 border-white/20 text-white' : 'bg-white/5 border-transparent text-zinc-400 hover:border-white/10'}`}
                  >
                    <div className="flex items-center gap-4">
                      <Camera className={`w-6 h-6 ${selectedDeviceId === d.deviceId ? 'text-white' : 'text-zinc-600'}`} />
                      <span className="font-bold text-sm">{d.label || `Camera ${d.deviceId.slice(0, 5)}`}</span>
                    </div>
                    {selectedDeviceId === d.deviceId && <Check className="w-5 h-5" />}
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
