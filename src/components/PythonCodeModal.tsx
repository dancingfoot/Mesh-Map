import React, { useState } from 'react';
import { X, Copy, Check, Download, Terminal, Code, Sparkles, BookOpen } from 'lucide-react';

interface PythonCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  pythonCode: string;
}

export const PythonCodeModal: React.FC<PythonCodeModalProps> = ({
  isOpen,
  onClose,
  pythonCode,
}) => {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'code' | 'guide'>('code');

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(pythonCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([pythonCode], { type: 'text/x-python' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mesh_map.py';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[1000] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20">
              <Code className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">mesh_map.py</h2>
              <p className="text-xs text-slate-400">
                Single executable Python script (Streamlit + Folium + PySerial)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Tabs */}
            <div className="flex items-center bg-slate-800 p-1 rounded-lg text-xs mr-2">
              <button
                onClick={() => setActiveTab('code')}
                className={`px-3 py-1 rounded-md transition-colors ${
                  activeTab === 'code' ? 'bg-blue-600 text-white font-medium' : 'text-slate-400 hover:text-white'
                }`}
              >
                Python Code
              </button>
              <button
                onClick={() => setActiveTab('guide')}
                className={`px-3 py-1 rounded-md transition-colors ${
                  activeTab === 'guide' ? 'bg-blue-600 text-white font-medium' : 'text-slate-400 hover:text-white'
                }`}
              >
                Setup Guide
              </button>
            </div>

            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied!' : 'Copy Code'}</span>
            </button>

            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download mesh_map.py</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors ml-2"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-950 font-mono text-xs">
          {activeTab === 'code' ? (
            <pre className="text-slate-300 leading-relaxed overflow-x-auto select-text selection:bg-blue-600 selection:text-white whitespace-pre font-mono">
              <code>{pythonCode}</code>
            </pre>
          ) : (
            <div className="font-sans space-y-6 text-slate-300">
              <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  1. Quick Install Dependencies
                </h3>
                <p className="text-xs text-slate-400 mb-3">
                  Install the four core Python packages required for the GIS tracking dashboard:
                </p>
                <div className="p-3 bg-black rounded-lg font-mono text-xs text-emerald-400 border border-slate-800 flex items-center justify-between">
                  <span>pip install streamlit folium streamlit-folium pyserial</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText('pip install streamlit folium streamlit-folium pyserial');
                    }}
                    className="text-slate-400 hover:text-white text-xs underline font-sans ml-4"
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
                  <BookOpen className="w-4 h-4 text-blue-400" />
                  2. Launching the Application
                </h3>
                <p className="text-xs text-slate-400 mb-3">
                  Run the standalone Python script using the Streamlit CLI:
                </p>
                <div className="p-3 bg-black rounded-lg font-mono text-xs text-blue-400 border border-slate-800 flex items-center justify-between">
                  <span>streamlit run mesh_map.py</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText('streamlit run mesh_map.py');
                    }}
                    className="text-slate-400 hover:text-white text-xs underline font-sans ml-4"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  Streamlit will start a local server at <code className="text-slate-300">http://localhost:8501</code> and automatically open your default browser.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  3. Meshtastic Hardware Configuration
                </h3>
                <ul className="text-xs text-slate-400 space-y-2 list-disc list-inside">
                  <li>
                    <strong>Serial Port:</strong> Connect your Meshtastic node (Heltec ESP32, T-Beam, T-Echo, RAK4631) via USB. Common ports are <code className="text-slate-300">/dev/ttyUSB0</code> or <code className="text-slate-300">/dev/ttyACM0</code> on Linux/Raspberry Pi, and <code className="text-slate-300">COM3</code> / <code className="text-slate-300">COM4</code> on Windows.
                  </li>
                  <li>
                    <strong>Baud Rate:</strong> Meshtastic standard serial baud rate is <code className="text-slate-300">115200</code>.
                  </li>
                  <li>
                    <strong>Linux USB Permissions:</strong> If you get permission denied on Linux, add your user to the dialout group: <code className="text-slate-300">sudo usermod -a -G dialout $USER</code>.
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between text-xs text-slate-500">
          <span>All requirements satisfied in single executable script</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
