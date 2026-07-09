import React, { useState, useEffect, useRef } from 'react';
import { auth } from './firebase';
import { signOut } from "firebase/auth";
import axios from 'axios';
import DOMPurify from 'dompurify';
import utmLogo from './assets/utm-logo.png';

import './App.css'; 

function Chat({ user, theme, toggleTheme }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleLogout = () => signOut(auth);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMsg = { role: 'user', text: input };
    setMessages(prev => [...prev, userMsg]);
    const currentInput = input;
    setInput('');
    setIsLoading(true);

    try {
      const res = await axios.post('http://localhost:8000/predict', {
        message: currentInput
      });
      if (res.data && res.data.reply) {
        setMessages(prev => [...prev, { role: 'ai', text: res.data.reply }]);
      } else {
        setMessages(prev => [...prev, { role: 'ai', text: "The assistant returned an empty response." }]);
      }
    } catch (err) {
      console.error("Backend unreachable:", err);
      setMessages(prev => [...prev, { role: 'ai', text: "Error: Could not connect to the AI server. Make sure main.py is running on port 8000." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') handleSend();
  };

  // Converts markdown links, plain URLs, newlines, and bullets into safe HTML
  const formatMessage = (text) => {
    let formatted = text
      // 1. Markdown-style links: [text](url)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      )
      // 2. Plain URLs not already inside an <a> tag
      .replace(
        /(?<!href=")(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
      )
      // 3. Newlines
      .replace(/\n/g, '<br/>')
      // 4. Bullets
      .replace(/•\s*/g, '<br/>• ')
      .replace(/^<br\/>/, '');

    return DOMPurify.sanitize(formatted, { ADD_ATTR: ['target', 'rel'] });
  };

  if (!user) return null;

  return (
    <div className="chat-page">
      <div className="chat-container">

        {/* ── Header ── */}
        <header className="chat-header">
          <div className="brand">
            <img src={utmLogo} alt="UTM" className="header-logo" />
            <div>
              <span className="brand-text">UTM Assistant</span>
              <span className="brand-sub">FYP Support</span>
            </div>
          </div>

          <div className="chat-header-right">
            <div className="user-info">
              <div className="status-dot" />
              <span>Welcome, <strong>{user?.email?.split('@')[0]}</strong></span>
            </div>

            <button
              className="chat-theme-toggle"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>

            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </header>

        {/* ── Messages ── */}
        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !isLoading && (
            <div className="empty-state">
              Ask me anything about the Faculty of Computing FYP!
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.role === 'ai' ? (
                <span
                  dangerouslySetInnerHTML={{ __html: formatMessage(m.text) }}
                />
              ) : (
                m.text
              )}
            </div>
          ))}

          {isLoading && (
            <div className="bubble typing">
              FYPBot is thinking...
            </div>
          )}
        </div>

        {/* ── Input ── */}
        <div className="chat-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Type your question about FYP..."
            disabled={isLoading}
          />
          <button onClick={handleSend} disabled={isLoading || !input.trim()}>
            {isLoading ? '…' : '➤'}
          </button>
        </div>

      </div>
    </div>
  );
}

export default Chat;