import React, { useState, useEffect } from 'react';
import { auth, db } from './firebase';
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import utmLogo from './assets/utm-logo.png';

function Login({ theme, toggleTheme }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [checking, setChecking] = useState(false); // "Checking role..." state

  // AUTOMATIC ERROR CLEAR GUARDE RAIL
  // If an error message gets displayed, automatically clear it out after 6 seconds
  useEffect(() => {
    if (errorMsg) {
      const timer = setTimeout(() => {
        setErrorMsg('');
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [errorMsg]);

  const handleLogin = async () => {
    setErrorMsg('');

    if (!email.trim()) {
      setErrorMsg("Please enter your UTM student email address.");
      return;
    }
    if (!email.toLowerCase().endsWith('@graduate.utm.my')) {
      setErrorMsg("Access Denied. Please use your authoritative @graduate.utm.my domain profile.");
      return;
    }
    if (!password) {
      setErrorMsg("Please enter your account password to verify identity.");
      return;
    }

    try {
      setChecking(true);
      await signInWithEmailAndPassword(auth, email.trim(), password);
      
      // ✅ Just sign in — App.js onAuthStateChanged handles everything else.
      // Do NOT check Firestore here, do NOT call auth.signOut() here.
      // App.js will fetch the role and route to the correct view.

    } catch (error) {
      setChecking(false);
      switch (error.code) {
        case 'auth/user-not-found':
          setErrorMsg("No profile registry matched. Check your credential values.");
          break;
        case 'auth/wrong-password':
          setErrorMsg("Incorrect authentication password security signature.");
          break;
        case 'auth/too-many-requests':
          setErrorMsg("Account temporarily locked down due to excessive connection traffic. Try again later.");
          break;
        case 'auth/invalid-email':
          setErrorMsg("Structural string parameters do not conform to an explicit email template layout.");
          break;
        case 'auth/invalid-credential':
          setErrorMsg("Invalid authorization request tokens. Email or password mismatch.");
          break;
        default:
          setErrorMsg(`Network Gateway Reject: ${error.message}`);
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleLogin();
  };

  // "Checking role..." screen shown after auth, before App.js re-renders
  if (checking) {
    return (
      <div className="login-page">
        <div className="login-box" style={{ textAlign: 'center' }}>
          <img src={utmLogo} alt="UTM" style={{ width: 64, marginBottom: 16 }} />
          <div className="loading-screen" style={{ fontSize: 14, fontWeight: '500' }}>
            Verifying access level data streams...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-box">
        {toggleTheme && (
          <button
            className="login-theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        )}

        <div className="utm-logo-wrap">
          <img src={utmLogo} alt="Universiti Teknologi Malaysia" />
        </div>
        <div className="logo-divider" />
        <h1 className="utm-title">F Y P B o t</h1>
        <p>UTM Assistant AI Chatbot</p>

        {/* ── MODIFIED ERROR ALERT BLOCK INTERFACE ── */}
        {errorMsg && (
          <div 
            className="login-error-alert" 
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(239, 68, 68, 0.15)',
              borderLeft: '4px solid #ef4444',
              color: '#f87171',
              padding: '12px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              lineHeight: '1.4',
              marginBottom: '16px',
              animation: 'fadeIn 0.3s ease-in-out',
              textAlign: 'left'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <span style={{ fontSize: '14px', marginTop: '1px' }}>⚠️</span>
              <span>{errorMsg}</span>
            </div>
            <button 
              onClick={() => setErrorMsg('')}
              style={{
                background: 'none',
                border: 'none',
                color: '#f87171',
                fontSize: '18px',
                cursor: 'pointer',
                lineHeight: '1',
                padding: '0 4px',
                opacity: '0.7',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '1'}
              onMouseLeave={(e) => e.target.style.opacity = '0.7'}
            >
              &times;
            </button>
          </div>
        )}

        <input
          type="email"
          placeholder="UTM Gmail — @graduate.utm.my"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={checking}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={checking}
        />
        <button className="login-btn" onClick={handleLogin} disabled={checking}>
          {checking ? 'Verifying...' : 'Login'}
        </button>

        <p className="login-footer-note">Faculty of Computing · UTM</p>
      </div>
      
      {/* Dynamic Keyframe Injection for the Alert Block Fade In effect */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

export default Login;