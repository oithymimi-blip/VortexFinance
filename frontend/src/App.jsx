import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import WalletConnect from './components/WalletConnect';
import ApproveForm from './components/ApproveForm';
import PermitHistory from './components/PermitHistory';
import CountdownTimer from './components/CountdownTimer';
import InfoSection from './components/InfoSection';
import AdminView from './components/AdminView';
import AdminPanel from './components/AdminPanel';

/* ── Inline SVG logo icon ── */
function VortexIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="14" stroke="url(#vg)" strokeWidth="2"/>
      <path d="M10 16c0-3.314 2.686-6 6-6s6 2.686 6 6-2.686 6-6 6" stroke="url(#vg2)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M16 10l3 3-3 3" stroke="#22d3ee" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <defs>
        <linearGradient id="vg" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#06b6d4"/>
          <stop offset="1" stopColor="#6366f1"/>
        </linearGradient>
        <linearGradient id="vg2" x1="10" y1="10" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22d3ee"/>
          <stop offset="1" stopColor="#818cf8"/>
        </linearGradient>
      </defs>
    </svg>
  );
}

function HomePage() {
  return (
    <div className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex justify-between items-center mb-12 py-4 border-b border-cyan-900/40">
        <div className="flex items-center gap-3">
          <VortexIcon size={34} />
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold bg-gradient-to-r from-cyan-300 via-sky-400 to-indigo-400 bg-clip-text text-transparent tracking-tight">
              VortexFinance
            </h1>
            <p className="text-xs text-cyan-500/70 mt-0.5">BNB Smart Chain · Powered by Permit2</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <WalletConnect />
        </div>
      </header>
      <main className="max-w-4xl mx-auto space-y-8">
        <ApproveForm />
        <PermitHistory />
        <CountdownTimer />
        <InfoSection />
      </main>
    </div>
  );
}

function AdminPage() {
  return (
    <div className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8 py-4 border-b border-cyan-900/40">
        <Link to="/" className="text-cyan-400 hover:text-cyan-300 font-medium text-sm flex items-center gap-1 transition">
          ← Back to App
        </Link>
      </div>
      <AdminPanel />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#051121',
            color: '#e0f2fe',
            border: '1px solid #0e7490',
          },
        }}
      />
      <Routes>
        <Route path="/"      element={<HomePage />} />
        <Route path="/admin" element={<AdminView />} />
        <Route path="/super" element={<AdminPage />} />
      </Routes>
    </BrowserRouter>
  );
}
